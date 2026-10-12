-- AlterTable
ALTER TABLE "SourceItem" ADD COLUMN "clusterMethod" TEXT;
ALTER TABLE "SourceItem" ADD COLUMN "clusterScore" REAL;
ALTER TABLE "SourceItem" ADD COLUMN "clusteredAt" DATETIME;
