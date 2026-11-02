import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authenticateUser,
  backupDatabase,
  createUser,
  generatePassword,
  generateUsername,
  getUserById,
  listUserKeys,
  listUsers,
  resetUserPassword,
  upsertUserKeys,
  updateUserStatus,
} from "./db.mjs";

const port = Number(process.env.PORT || 18082);
const upstreamApi = (process.env.UPSTREAM_API || "http://185.150.191.36:61100").replace(/\/+$/, "");
const sharedUpstreamUsername = String(
  process.env.SHARED_UPSTREAM_USERNAME || "userbingcha2",
).trim();
const basePath = normalizeBasePath(process.env.BASE_PATH || "");
const cookieSecure = process.env.COOKIE_SECURE === "true";
const sessionTtlMs = Number(process.env.SESSION_TTL_SECONDS || 43200) * 1000;
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "dist");
const sessions = new Map();
const loginAttempts = new Map();
let trafficGapCache = null;
let trafficGapCacheExpiresAt = 0;
let trafficGapRequest = null;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function normalizeBasePath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function applySecurityHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://bcai.online; " +
      "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; " +
      "frame-ancestors 'none'; form-action 'self'",
  );
  if (String(req.headers["x-forwarded-proto"] || "").includes("https")) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function signSessionId(id) {
  return createHmac("sha256", sessionSecret).update(id).digest("base64url");
}

function serializeSessionCookie(id) {
  const value = `${id}.${signSessionId(id)}`;
  const attributes = [
    `bc_session=${encodeURIComponent(value)}`,
    `Path=${basePath || "/"}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
  ];
  if (cookieSecure) attributes.push("Secure");
  return attributes.join("; ");
}

function clearSessionCookie() {
  const attributes = [
    "bc_session=",
    `Path=${basePath || "/"}`,
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (cookieSecure) attributes.push("Secure");
  return attributes.join("; ");
}

function getSession(req) {
  const cookie = parseCookies(req).bc_session;
  if (!cookie) return null;
  const separator = cookie.lastIndexOf(".");
  if (separator < 1) return null;
  const id = cookie.slice(0, separator);
  const suppliedSignature = cookie.slice(separator + 1);
  const expectedSignature = signSessionId(id);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  const user = getUserById(session.userId);
  if (!user || user.status !== "active") {
    sessions.delete(id);
    return null;
  }
  session.username = user.username;
  session.role = user.role;
  session.upstreamNamespace = user.upstream_namespace;
  session.expiresAt = Date.now() + sessionTtlMs;
  return { id, ...session };
}

async function readJson(req, maxBytes = 5 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("请求内容过大");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求格式无效");
    error.status = 400;
    throw error;
  }
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .split(",")[0]
    .trim();
}

function checkLoginRate(req) {
  const key = clientIp(req);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 5 * 60 * 1000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}

function checkSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  try {
    return new URL(origin).host === forwardedHost;
  } catch {
    return false;
  }
}

function sanitizeSession(session) {
  return {
    username: session.username,
    role: session.role,
    channels: session.channels,
    userType: session.userType,
    expiresAt: session.expiresAt,
  };
}

function hasAnthropicAccess(session) {
  return session.channels.includes("anthropic");
}

function maskStoredKey(value) {
  const key = String(value || "");
  if (!key) return "未知 Key";
  if (key.includes("...")) return key;
  return `${key.slice(0, Math.min(10, key.length))}...${key.slice(-8)}`;
}

function publicKeyMetadata(item) {
  return {
    id: item.id,
    channel: item.channel,
    key: maskStoredKey(item.key),
    source: item.source,
    first_seen_at: item.first_seen_at,
    last_seen_at: item.last_seen_at,
    upstream_uploaded_at: item.upstream_uploaded_at,
    submitted_count: item.submitted_count,
  };
}

function optionalFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTrafficGaps(data) {
  return {
    success: data?.success === true,
    ready: data?.ready !== false,
    start_timestamp: optionalFiniteNumber(data?.start_timestamp),
    end_timestamp: optionalFiniteNumber(data?.end_timestamp),
    window: String(data?.window || "").slice(0, 16),
    rpm_gap: optionalFiniteNumber(data?.rpm_gap),
    tpm_gap: optionalFiniteNumber(data?.tpm_gap),
    site_count: optionalFiniteNumber(data?.site_count),
    successful_site_count: optionalFiniteNumber(data?.successful_site_count),
    failed_site_count: optionalFiniteNumber(data?.failed_site_count),
    tpm_estimate_complete: data?.tpm_estimate_complete === true,
    complete: data?.complete === true,
    updated_at: String(data?.updated_at || "").slice(0, 32),
    stale: false,
  };
}

async function getTrafficGaps() {
  if (trafficGapCache && trafficGapCacheExpiresAt > Date.now()) {
    return trafficGapCache;
  }
  if (!trafficGapRequest) {
    trafficGapRequest = (async () => {
      const response = await fetch(`${upstreamApi}/api/traffic-gaps`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`upstream status ${response.status}`);
      const payload = normalizeTrafficGaps(await response.json());
      if (!payload.success) throw new Error("upstream traffic gap query failed");
      trafficGapCache = payload;
      trafficGapCacheExpiresAt = Date.now() + 15 * 1000;
      return payload;
    })();
  }
  try {
    return await trafficGapRequest;
  } catch (error) {
    if (trafficGapCache) return { ...trafficGapCache, stale: true };
    throw error;
  } finally {
    trafficGapRequest = null;
  }
}

function invalidateUserSessions(userId) {
  for (const [sessionId, session] of sessions) {
    if (session.userId === Number(userId)) sessions.delete(sessionId);
  }
}

async function handleLogin(req, res) {
  if (!checkLoginRate(req)) {
    json(res, 429, { detail: "登录尝试过于频繁，请稍后再试" });
    return;
  }
  const body = await readJson(req, 64 * 1024);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) {
    json(res, 400, { detail: "请输入账号和密码" });
    return;
  }

  const user = authenticateUser(username, password);
  if (!user) {
    json(res, 401, { detail: "账号、密码错误或账号已停用" });
    return;
  }

  const id = randomBytes(32).toString("base64url");
  const session = {
    userId: user.id,
    username: user.username,
    role: user.role,
    upstreamNamespace: user.upstream_namespace,
    channels: ["anthropic"],
    userType: "default",
    expiresAt: Date.now() + sessionTtlMs,
  };
  sessions.set(id, session);
  json(res, 200, { data: sanitizeSession(session) }, { "Set-Cookie": serializeSessionCookie(id) });
}

async function handleAdminApi(req, res, pathname, session) {
  if (session.role !== "admin") {
    json(res, 403, { detail: "需要管理员权限" });
    return;
  }

  if (pathname === "/api/admin/users" && req.method === "GET") {
    json(res, 200, { data: listUsers() });
    return;
  }

  if (pathname === "/api/admin/users" && req.method === "POST") {
    const body = await readJson(req, 64 * 1024);
    const username = String(body.username || "").trim() || generateUsername();
    const password = String(body.password || "") || generatePassword();
    try {
      const user = createUser({
        username,
        password,
        role: "user",
        createdBy: session.userId,
      });
      json(res, 201, { data: { user, password } });
    } catch (error) {
      json(res, 400, { detail: error.message });
    }
    return;
  }

  const keysMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/keys$/);
  if (keysMatch && req.method === "GET") {
    const user = getUserById(Number(keysMatch[1]));
    if (!user) {
      json(res, 404, { detail: "账号不存在" });
      return;
    }
    const keys = listUserKeys(user.id, "anthropic").map(publicKeyMetadata);
    json(res, 200, { data: { user, keys } });
    return;
  }

  const usageMatch = pathname.match(
    /^\/api\/admin\/users\/(\d+)\/anthropic\/usage$/,
  );
  if (usageMatch && req.method === "POST") {
    const user = getUserById(Number(usageMatch[1]));
    if (!user) {
      json(res, 404, { detail: "账号不存在" });
      return;
    }
    const body = await readJson(req);
    const ownedKeys = listUserKeys(user.id, "anthropic").map((item) => item.key);
    if (!ownedKeys.length) {
      sendEmptyUsage(res);
      return;
    }
    await proxyStream(req, res, "/api/usage/anthropic", {
      key_list: ownedKeys.join("\n"),
      date: String(body.date || "").slice(0, 10),
      hour: String(body.hour || "").slice(0, 2),
      minute: String(body.minute || "").slice(0, 2),
      username: sharedUpstreamUsername,
    });
    return;
  }

  const statusMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/status$/);
  if (statusMatch && req.method === "PATCH") {
    const userId = Number(statusMatch[1]);
    if (userId === session.userId) {
      json(res, 400, { detail: "不能修改当前登录管理员的状态" });
      return;
    }
    const body = await readJson(req, 32 * 1024);
    try {
      const user = updateUserStatus(userId, String(body.status || ""));
      if (user.status === "disabled") invalidateUserSessions(user.id);
      json(res, 200, { data: user });
    } catch (error) {
      json(res, 400, { detail: error.message });
    }
    return;
  }

  const passwordMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/password$/);
  if (passwordMatch && req.method === "POST") {
    const userId = Number(passwordMatch[1]);
    const body = await readJson(req, 32 * 1024);
    const password = String(body.password || "") || generatePassword();
    try {
      const user = resetUserPassword(userId, password);
      if (user.id !== session.userId) invalidateUserSessions(user.id);
      json(res, 200, { data: { user, password } });
    } catch (error) {
      json(res, 400, { detail: error.message });
    }
    return;
  }

  json(res, 404, { detail: "管理接口不存在" });
}

function handleLogout(req, res) {
  const session = getSession(req);
  if (session) sessions.delete(session.id);
  json(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
}

async function proxyStream(req, res, path, payload, onEvent = null) {
  let upstream;
  try {
    upstream = await fetch(`${upstreamApi}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    json(res, 502, { detail: "无法连接上游服务" });
    return;
  }

  const headers = {
    "Cache-Control": "no-cache, no-store",
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "X-Accel-Buffering": "no",
  };
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) headers["Content-Disposition"] = disposition;
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = onEvent ? new TextDecoder() : null;
  let eventBuffer = "";

  function inspectChunk(value, stream = true) {
    if (!decoder || !onEvent) return;
    eventBuffer += decoder.decode(value, { stream });
    const lines = eventBuffer.split("\n");
    eventBuffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.startsWith("data: ")) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {
        // Upstream progress must keep streaming even if one metadata frame is malformed.
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      inspectChunk(value);
      if (res.destroyed) {
        await reader.cancel();
        break;
      }
      if (!res.write(Buffer.from(value))) await once(res, "drain");
    }
    inspectChunk(new Uint8Array(), false);
    if (!res.destroyed) res.end();
  } catch {
    if (!res.headersSent) {
      json(res, 502, { detail: "读取上游响应失败" });
    } else if (!res.destroyed) {
      res.end();
    }
  }
}

function sendEmptyUsage(res) {
  const event = {
    type: "done",
    queried: 0,
    displayed: 0,
    query_incomplete: false,
    failed_key_count: 0,
    total_usd: 0,
  };
  res.writeHead(200, {
    "Cache-Control": "no-cache, no-store",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  res.end(`data: ${JSON.stringify(event)}\n\n`);
}

async function handleApi(req, res, pathname) {
  if (!checkSameOrigin(req)) {
    json(res, 403, { detail: "请求来源无效" });
    return;
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    await handleLogin(req, res);
    return;
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    handleLogout(req, res);
    return;
  }

  const session = getSession(req);
  if (!session) {
    json(res, 401, { detail: "登录已过期，请重新登录" }, { "Set-Cookie": clearSessionCookie() });
    return;
  }
  if (pathname === "/api/auth/me" && req.method === "GET") {
    json(res, 200, { data: sanitizeSession(session) });
    return;
  }
  if (pathname === "/api/traffic-gaps" && req.method === "GET") {
    try {
      json(res, 200, await getTrafficGaps());
    } catch {
      json(res, 502, { detail: "暂时无法读取源站流量缺口" });
    }
    return;
  }
  if (pathname.startsWith("/api/admin/")) {
    await handleAdminApi(req, res, pathname, session);
    return;
  }
  if (!hasAnthropicAccess(session)) {
    json(res, 403, { detail: "当前账号没有 Anthropic 渠道权限" });
    return;
  }

  if (pathname === "/api/channel/anthropic/upload" && req.method === "POST") {
    const body = await readJson(req);
    const keyList = String(body.key_list || "").trim();
    if (!keyList) {
      json(res, 400, { detail: "请输入至少一个 Anthropic Key" });
      return;
    }
    try {
      upsertUserKeys(session.userId, "anthropic", keyList.split(/\r?\n/), {
        source: "submitted",
      });
    } catch (error) {
      json(res, Number(error.status) || 400, { detail: error.message });
      return;
    }
    await proxyStream(req, res, "/api/upload/anthropic", {
      key_list: keyList,
      username: sharedUpstreamUsername,
    });
    return;
  }

  if (pathname === "/api/channel/anthropic/usage" && req.method === "POST") {
    const body = await readJson(req);
    const ownedKeys = listUserKeys(session.userId, "anthropic").map((item) => item.key);
    if (!ownedKeys.length) {
      sendEmptyUsage(res);
      return;
    }
    await proxyStream(req, res, "/api/usage/anthropic", {
      key_list: ownedKeys.join("\n"),
      date: String(body.date || "").slice(0, 10),
      hour: String(body.hour || "").slice(0, 2),
      minute: String(body.minute || "").slice(0, 2),
      username: sharedUpstreamUsername,
    });
    return;
  }

  if (pathname === "/api/keys" && req.method === "GET") {
    json(res, 200, { data: listUserKeys(session.userId, "anthropic") });
    return;
  }

  if (pathname === "/api/channel/anthropic/export" && req.method === "POST") {
    const body = await readJson(req, 8 * 1024 * 1024);
    const records = Array.isArray(body.records) ? body.records.slice(0, 5000) : [];
    if (!records.length) {
      json(res, 400, { detail: "没有可以导出的记录" });
      return;
    }
    await proxyStream(req, res, "/api/usage/anthropic/status-records.xlsx", {
      records,
      filename_prefix: "bingcha-key-status",
    });
    return;
  }

  json(res, 404, { detail: "接口不存在" });
}

async function serveStatic(req, res, pathname) {
  let requestedPath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  requestedPath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = resolve(join(distDir, requestedPath));
  if (!filePath.startsWith(distDir)) {
    json(res, 403, { detail: "路径无效" });
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    if (extname(requestedPath)) {
      json(res, 404, { detail: "资源不存在" });
      return;
    }
    filePath = join(distDir, "index.html");
    await access(filePath);
  }

  const extension = extname(filePath).toLowerCase();
  const headers = {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
  };
  if (extension === ".html") {
    headers["Cache-Control"] = "no-cache";
  } else if (pathname.startsWith("/assets/")) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  } else {
    headers["Cache-Control"] = "public, max-age=3600";
  }
  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  applySecurityHeaders(req, res);
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;
    if (pathname === "/health") {
      json(res, 200, { status: "ok" });
      return;
    }
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { detail: "请求方法不支持" });
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (error) {
    json(res, Number(error.status || 500), {
      detail: error.status ? error.message : "服务暂时不可用",
    });
  }
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
  for (const [ip, entry] of loginAttempts) {
    if (entry.resetAt <= now) loginAttempts.delete(ip);
  }
}, 60_000);
cleanupTimer.unref();

async function runDatabaseBackup() {
  try {
    const outputPath = await backupDatabase();
    console.log(`database backup created: ${outputPath}`);
  } catch (error) {
    console.error(`database backup failed: ${error.message}`);
  }
}

const firstBackupTimer = setTimeout(runDatabaseBackup, 60_000);
firstBackupTimer.unref();
const backupTimer = setInterval(runDatabaseBackup, 24 * 60 * 60 * 1000);
backupTimer.unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`bingcha-channel listening on ${port}`);
});
