-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RedeemCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "product" TEXT NOT NULL DEFAULT 'GOOGLE_ONE',
    "codeType" TEXT NOT NULL DEFAULT 'JOIN_GROUP',
    "usesAllowed" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'UNUSED',
    "expiresAt" DATETIME,
    "usedAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_RedeemCode" ("code", "createdAt", "createdById", "expiresAt", "id", "product", "status", "updatedAt", "usedAt", "usesAllowed") SELECT "code", "createdAt", "createdById", "expiresAt", "id", "product", "status", "updatedAt", "usedAt", "usesAllowed" FROM "RedeemCode";
DROP TABLE "RedeemCode";
ALTER TABLE "new_RedeemCode" RENAME TO "RedeemCode";
CREATE UNIQUE INDEX "RedeemCode_code_key" ON "RedeemCode"("code");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
