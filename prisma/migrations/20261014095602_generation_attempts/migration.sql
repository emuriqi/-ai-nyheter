-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Story" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "workingTitle" TEXT NOT NULL,
    "category" TEXT,
    "sensitivity" TEXT NOT NULL DEFAULT 'NORMAL',
    "sensitivityReasons" JSONB,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSourceAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generationAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastGenerationAt" DATETIME,
    "lastGenerationError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Story" ("category", "createdAt", "firstSeenAt", "id", "lastSourceAt", "sensitivity", "sensitivityReasons", "slug", "updatedAt", "workingTitle") SELECT "category", "createdAt", "firstSeenAt", "id", "lastSourceAt", "sensitivity", "sensitivityReasons", "slug", "updatedAt", "workingTitle" FROM "Story";
DROP TABLE "Story";
ALTER TABLE "new_Story" RENAME TO "Story";
CREATE UNIQUE INDEX "Story_slug_key" ON "Story"("slug");
CREATE INDEX "Story_lastSourceAt_idx" ON "Story"("lastSourceAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
