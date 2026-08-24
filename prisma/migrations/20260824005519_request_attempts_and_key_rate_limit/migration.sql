-- The hnsw index on CacheEntry.embedding is deliberately not in the prisma
-- schema, because prisma cannot model an index over an Unsupported column.
-- Every generated migration will try to drop it again, and every one of them
-- has to have that drop removed by hand.

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "rateLimit" INTEGER;

-- CreateTable
CREATE TABLE "RequestAttempt" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequestAttempt_requestId_idx" ON "RequestAttempt"("requestId");

-- CreateIndex
CREATE INDEX "RequestAttempt_provider_createdAt_idx" ON "RequestAttempt"("provider", "createdAt");

-- AddForeignKey
ALTER TABLE "RequestAttempt" ADD CONSTRAINT "RequestAttempt_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
