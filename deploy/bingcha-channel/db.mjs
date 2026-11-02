import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const databasePath = resolve(process.env.DATABASE_PATH || "./data/bingcha.db");
const backupDirectory = resolve(
  process.env.BACKUP_DIR || `${dirname(databasePath)}/backups`,
);
const keyBackupSecret =
  process.env.KEY_BACKUP_SECRET ||
  process.env.SESSION_SECRET ||
  "bingcha-development-key-backup-secret";
const keyEncryptionKey = createHash("sha256").update(keyBackupSecret).digest();
mkdirSync(dirname(databasePath), { recursive: true });
mkdirSync(backupDirectory, { recursive: true });

const database = new DatabaseSync(databasePath);
database.exec("PRAGMA journal_mode = WAL");
database.exec("PRAGMA foreign_keys = ON");
database.exec("PRAGMA busy_timeout = 5000");
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    upstream_namespace TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
  CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

  CREATE TABLE IF NOT EXISTS user_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    key_ciphertext TEXT NOT NULL,
    key_iv TEXT NOT NULL,
    key_tag TEXT NOT NULL,
    key_hint TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'submitted',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    upstream_uploaded_at TEXT,
    submitted_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(user_id, channel, fingerprint)
  );

  CREATE INDEX IF NOT EXISTS idx_user_keys_owner
    ON user_keys(user_id, channel, last_seen_at DESC);
`);

// A key can only belong to one local account. During the one-time migration,
// prefer the original upstream account if an older database contains duplicates.
database.exec(`
  WITH ranked_keys AS (
    SELECT
      user_keys.id,
      ROW_NUMBER() OVER (
        PARTITION BY user_keys.channel, user_keys.fingerprint
        ORDER BY
          CASE WHEN users.username = 'userbingcha2' THEN 0 ELSE 1 END,
          user_keys.first_seen_at ASC,
          user_keys.id ASC
      ) AS owner_rank
    FROM user_keys
    JOIN users ON users.id = user_keys.user_id
  )
  DELETE FROM user_keys
  WHERE id IN (
    SELECT id FROM ranked_keys WHERE owner_rank > 1
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_keys_global_fingerprint
    ON user_keys(channel, fingerprint);
`);

const publicColumns = `
  users.id, users.username, users.role, users.status, users.upstream_namespace,
  users.created_at, users.updated_at, users.last_login_at, users.created_by,
  (
    SELECT COUNT(*)
    FROM user_keys
    WHERE user_keys.user_id = users.id
  ) AS key_count
`;

function nowIso() {
  return new Date().toISOString();
}

function encryptKey(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptKey(row) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyEncryptionKey,
    Buffer.from(row.key_iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(row.key_tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.key_ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function keyFingerprint(value) {
  return createHmac("sha256", keyEncryptionKey).update(value).digest("base64url");
}

function keyHint(value) {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

export function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!/^[a-z0-9][a-z0-9_-]{3,31}$/.test(username)) {
    throw new Error("账号需为 4-32 位小写字母、数字、下划线或连字符");
  }
  return username;
}

export function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 10 || password.length > 128) {
    throw new Error("密码长度需为 10-128 位");
  }
  return password;
}

function hashPassword(password, salt = randomBytes(18).toString("base64url")) {
  const hash = scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("base64url");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt).hash);
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function generateUsername() {
  return `bc_${randomBytes(5).toString("hex")}`;
}

export function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(18);
  let password = "";
  for (const byte of bytes) password += alphabet[byte % alphabet.length];
  return password;
}

export function generateNamespace() {
  return `shell_${randomBytes(10).toString("hex")}`;
}

export function createUser({
  username,
  password,
  role = "user",
  upstreamNamespace,
  createdBy = null,
}) {
  const normalizedUsername = validateUsername(username);
  const normalizedPassword = validatePassword(password);
  if (!["admin", "user"].includes(role)) throw new Error("账号角色无效");
  const namespace = String(upstreamNamespace || generateNamespace()).trim();
  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(namespace)) throw new Error("上游命名空间无效");
  const { salt, hash } = hashPassword(normalizedPassword);
  const timestamp = nowIso();

  try {
    const result = database
      .prepare(
        `INSERT INTO users (
          username, password_salt, password_hash, role, status,
          upstream_namespace, created_at, updated_at, created_by
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        normalizedUsername,
        salt,
        hash,
        role,
        namespace,
        timestamp,
        timestamp,
        createdBy,
      );
    return getUserById(Number(result.lastInsertRowid));
  } catch (error) {
    if (String(error.message).includes("users.username")) throw new Error("该账号已存在");
    if (String(error.message).includes("users.upstream_namespace")) {
      throw new Error("上游命名空间已存在");
    }
    throw error;
  }
}

export function authenticateUser(username, password) {
  const normalizedUsername = normalizeUsername(username);
  const row = database
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(normalizedUsername);
  if (!row || row.status !== "active") return null;
  if (!verifyPassword(String(password || ""), row.password_salt, row.password_hash)) return null;
  const timestamp = nowIso();
  database
    .prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?")
    .run(timestamp, timestamp, row.id);
  return getUserById(row.id);
}

export function getUserById(id) {
  return (
    database
      .prepare(`SELECT ${publicColumns} FROM users WHERE id = ?`)
      .get(Number(id)) || null
  );
}

export function getUserByUsername(username) {
  return (
    database
      .prepare(`SELECT ${publicColumns} FROM users WHERE username = ?`)
      .get(normalizeUsername(username)) || null
  );
}

export function listUsers() {
  return database
    .prepare(
      `SELECT ${publicColumns}
       FROM users
       ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at DESC`,
    )
    .all();
}

export function updateUserStatus(id, status) {
  if (!["active", "disabled"].includes(status)) throw new Error("账号状态无效");
  const user = getUserById(id);
  if (!user) throw new Error("账号不存在");
  if (user.role === "admin" && status === "disabled") {
    const activeAdmins = database
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'")
      .get().count;
    if (Number(activeAdmins) <= 1) throw new Error("不能禁用唯一的管理员账号");
  }
  const timestamp = nowIso();
  database
    .prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, timestamp, Number(id));
  return getUserById(id);
}

export function resetUserPassword(id, password) {
  const user = getUserById(id);
  if (!user) throw new Error("账号不存在");
  const normalizedPassword = validatePassword(password);
  const { salt, hash } = hashPassword(normalizedPassword);
  const timestamp = nowIso();
  database
    .prepare(
      "UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?",
    )
    .run(salt, hash, timestamp, Number(id));
  return getUserById(id);
}

export function userCount() {
  return Number(database.prepare("SELECT COUNT(*) AS count FROM users").get().count);
}

export function upsertUserKeys(
  userId,
  channel,
  values,
  { source = "submitted", upstreamUploadedAt = null } = {},
) {
  const owner = getUserById(userId);
  if (!owner) throw new Error("账号不存在");
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  if (!/^[a-z0-9-]{3,32}$/.test(normalizedChannel)) throw new Error("渠道类型无效");
  const keyRecords = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const key = String(typeof value === "object" ? value?.key : value || "").trim();
    if (key.length < 8 || key.length > 4096) continue;
    keyRecords.set(key, {
      key,
      upstreamUploadedAt:
        typeof value === "object" && value?.upstreamUploadedAt
          ? String(value.upstreamUploadedAt)
          : upstreamUploadedAt,
    });
    if (keyRecords.size >= 5000) break;
  }
  const keys = [...keyRecords.values()];
  if (!keys.length) return { inserted: 0, updated: 0, total: 0 };

  const timestamp = nowIso();
  const findStatement = database.prepare(
    "SELECT id, user_id FROM user_keys WHERE channel = ? AND fingerprint = ?",
  );
  const insertStatement = database.prepare(
    `INSERT INTO user_keys (
      user_id, channel, fingerprint, key_ciphertext, key_iv, key_tag, key_hint,
      source, first_seen_at, last_seen_at, upstream_uploaded_at, submitted_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateStatement = database.prepare(
    `UPDATE user_keys
     SET last_seen_at = ?,
         upstream_uploaded_at = COALESCE(?, upstream_uploaded_at),
         submitted_count = submitted_count + ?
     WHERE id = ?`,
  );

  let inserted = 0;
  let updated = 0;
  const preparedKeys = keys.map((record) => ({
    ...record,
    fingerprint: keyFingerprint(record.key),
  }));
  const conflictingKeys = preparedKeys.filter((record) => {
    const existing = findStatement.get(normalizedChannel, record.fingerprint);
    return existing && Number(existing.user_id) !== Number(userId);
  });
  if (conflictingKeys.length) {
    const error = new Error(
      `其中 ${conflictingKeys.length} 个 Key 已绑定到其他账号，不能重复绑定`,
    );
    error.code = "KEY_ALREADY_BOUND";
    error.status = 409;
    throw error;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const record of preparedKeys) {
      const { key, fingerprint } = record;
      const existing = findStatement.get(normalizedChannel, fingerprint);
      const submittedIncrement = source === "submitted" ? 1 : 0;
      if (existing) {
        updateStatement.run(
          timestamp,
          record.upstreamUploadedAt,
          submittedIncrement,
          existing.id,
        );
        updated += 1;
        continue;
      }
      const encrypted = encryptKey(key);
      insertStatement.run(
        Number(userId),
        normalizedChannel,
        fingerprint,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        keyHint(key),
        String(source || "submitted").slice(0, 32),
        timestamp,
        timestamp,
        record.upstreamUploadedAt,
        submittedIncrement,
      );
      inserted += 1;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    if (
      String(error.message).includes("idx_user_keys_global_fingerprint") ||
      String(error.message).includes("user_keys.channel, user_keys.fingerprint")
    ) {
      const conflict = new Error("该 Key 已绑定到其他账号，不能重复绑定");
      conflict.code = "KEY_ALREADY_BOUND";
      conflict.status = 409;
      throw conflict;
    }
    throw error;
  }
  return { inserted, updated, total: keys.length };
}

export function listUserKeys(userId, channel = "anthropic") {
  const rows = database
    .prepare(
      `SELECT id, channel, key_ciphertext, key_iv, key_tag, key_hint, source,
              first_seen_at, last_seen_at, upstream_uploaded_at, submitted_count
       FROM user_keys
       WHERE user_id = ? AND channel = ?
       ORDER BY COALESCE(upstream_uploaded_at, first_seen_at) DESC, id DESC`,
    )
    .all(Number(userId), String(channel || "").trim().toLowerCase());
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    key: decryptKey(row),
    key_hint: row.key_hint,
    source: row.source,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    upstream_uploaded_at: row.upstream_uploaded_at,
    submitted_count: row.submitted_count,
  }));
}

export async function backupDatabase() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = resolve(backupDirectory, `bingcha-${timestamp}.db`);
  await backup(database, outputPath);

  const retentionDays = Math.max(
    1,
    Number(process.env.BACKUP_RETENTION_DAYS || 14),
  );
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = await readdir(backupDirectory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /^bingcha-\d{4}-\d{2}-\d{2}T.+\.db$/.test(entry.name),
      )
      .map(async (entry) => {
        const matched = entry.name.match(/^bingcha-(.+)\.db$/);
        const encoded = matched?.[1] || "";
        const dateParts = encoded.replace(
          /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
          "$1:$2:$3.$4Z",
        );
        const createdAt = Date.parse(dateParts);
        if (Number.isFinite(createdAt) && createdAt < cutoff) {
          await unlink(resolve(backupDirectory, entry.name));
        }
      }),
  );
  return outputPath;
}
