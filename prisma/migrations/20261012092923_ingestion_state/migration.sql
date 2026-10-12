-- AlterTable
ALTER TABLE "Source" ADD COLUMN "etag" TEXT;
ALTER TABLE "Source" ADD COLUMN "lastAttemptAt" DATETIME;
ALTER TABLE "Source" ADD COLUMN "lastModified" TEXT;
ALTER TABLE "Source" ADD COLUMN "tdmCheckedAt" DATETIME;
ALTER TABLE "Source" ADD COLUMN "tdmReservationFound" BOOLEAN;
