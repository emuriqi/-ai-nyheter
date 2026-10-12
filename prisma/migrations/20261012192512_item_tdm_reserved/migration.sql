-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SourceItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "guid" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "publishedAt" DATETIME,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excerpt" TEXT,
    "bodyText" TEXT,
    "tdmReserved" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT,
    "language" TEXT NOT NULL,
    "deleteAfter" DATETIME NOT NULL,
    "purgedAt" DATETIME,
    "storyId" TEXT,
    CONSTRAINT "SourceItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SourceItem_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SourceItem" ("bodyText", "contentHash", "deleteAfter", "excerpt", "fetchedAt", "guid", "id", "language", "publishedAt", "purgedAt", "sourceId", "storyId", "title", "url") SELECT "bodyText", "contentHash", "deleteAfter", "excerpt", "fetchedAt", "guid", "id", "language", "publishedAt", "purgedAt", "sourceId", "storyId", "title", "url" FROM "SourceItem";
DROP TABLE "SourceItem";
ALTER TABLE "new_SourceItem" RENAME TO "SourceItem";
CREATE INDEX "SourceItem_deleteAfter_purgedAt_idx" ON "SourceItem"("deleteAfter", "purgedAt");
CREATE INDEX "SourceItem_storyId_idx" ON "SourceItem"("storyId");
CREATE UNIQUE INDEX "SourceItem_sourceId_guid_key" ON "SourceItem"("sourceId", "guid");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
