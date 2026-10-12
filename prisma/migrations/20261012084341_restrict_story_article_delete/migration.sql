-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Article" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lede" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "isCorrected" BOOLEAN NOT NULL DEFAULT false,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT true,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "publishedAt" DATETIME,
    "unpublishedAt" DATETIME,
    "unpublishReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Article_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Article" ("aiGenerated", "body", "createdAt", "id", "isCorrected", "lede", "model", "promptVersion", "publishedAt", "status", "storyId", "title", "unpublishReason", "unpublishedAt", "updatedAt", "version") SELECT "aiGenerated", "body", "createdAt", "id", "isCorrected", "lede", "model", "promptVersion", "publishedAt", "status", "storyId", "title", "unpublishReason", "unpublishedAt", "updatedAt", "version" FROM "Article";
DROP TABLE "Article";
ALTER TABLE "new_Article" RENAME TO "Article";
CREATE UNIQUE INDEX "Article_storyId_key" ON "Article"("storyId");
CREATE INDEX "Article_status_publishedAt_idx" ON "Article"("status", "publishedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
