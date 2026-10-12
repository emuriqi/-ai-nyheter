-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "feedUrl" TEXT,
    "homepageUrl" TEXT NOT NULL,
    "termsUrl" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "licenseNote" TEXT NOT NULL,
    "attribution" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "termsReviewedAt" DATETIME,
    "tdmReservation" TEXT NOT NULL,
    "allowFullTextFetch" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "robotsCheckedAt" DATETIME,
    "robotsAllowed" BOOLEAN,
    "lastFetchedAt" DATETIME,
    "lastFetchError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SourceItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "guid" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "publishedAt" DATETIME,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excerpt" TEXT,
    "bodyText" TEXT,
    "contentHash" TEXT,
    "language" TEXT NOT NULL,
    "deleteAfter" DATETIME NOT NULL,
    "purgedAt" DATETIME,
    "storyId" TEXT,
    CONSTRAINT "SourceItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SourceItem_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Story" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "workingTitle" TEXT NOT NULL,
    "category" TEXT,
    "sensitivity" TEXT NOT NULL DEFAULT 'NORMAL',
    "sensitivityReasons" JSONB,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSourceAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Article" (
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
    CONSTRAINT "Article_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ArticleRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lede" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "changeSummary" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "model" TEXT,
    "promptVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArticleRevision_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RevisionSource" (
    "revisionId" TEXT NOT NULL,
    "sourceItemId" TEXT NOT NULL,

    PRIMARY KEY ("revisionId", "sourceItemId"),
    CONSTRAINT "RevisionSource_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "ArticleRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RevisionSource_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "SourceItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModerationReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "revisionId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "checkedBy" TEXT NOT NULL,
    "model" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModerationReview_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "ArticleRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "stats" JSONB,
    "error" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Source_slug_key" ON "Source"("slug");

-- CreateIndex
CREATE INDEX "SourceItem_deleteAfter_purgedAt_idx" ON "SourceItem"("deleteAfter", "purgedAt");

-- CreateIndex
CREATE INDEX "SourceItem_storyId_idx" ON "SourceItem"("storyId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceItem_sourceId_guid_key" ON "SourceItem"("sourceId", "guid");

-- CreateIndex
CREATE UNIQUE INDEX "Story_slug_key" ON "Story"("slug");

-- CreateIndex
CREATE INDEX "Story_lastSourceAt_idx" ON "Story"("lastSourceAt");

-- CreateIndex
CREATE UNIQUE INDEX "Article_storyId_key" ON "Article"("storyId");

-- CreateIndex
CREATE INDEX "Article_status_publishedAt_idx" ON "Article"("status", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleRevision_articleId_version_key" ON "ArticleRevision"("articleId", "version");

-- CreateIndex
CREATE INDEX "RevisionSource_sourceItemId_idx" ON "RevisionSource"("sourceItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ModerationReview_revisionId_key" ON "ModerationReview"("revisionId");

-- CreateIndex
CREATE INDEX "ModerationReview_decision_idx" ON "ModerationReview"("decision");

-- CreateIndex
CREATE INDEX "JobRun_type_startedAt_idx" ON "JobRun"("type", "startedAt");
