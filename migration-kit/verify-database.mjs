import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("Usage: node verify-database.mjs <database-path>");
}

const databasePath = resolve(inputPath);
const database = new DatabaseSync(databasePath, { readOnly: false });

try {
  // Opening a writable SQLite connection safely rolls back a hot rollback
  // journal left by an interrupted process before this check is evaluated.
  const rows = database.prepare("PRAGMA quick_check").all();
  const messages = rows.flatMap((row) => Object.values(row).map(String));

  if (messages.length !== 1 || messages[0] !== "ok") {
    throw new Error(`SQLite quick_check failed: ${messages.join("; ")}`);
  }

  console.log(`SQLite quick_check: ok (${databasePath})`);
} finally {
  database.close();
}
