-- Prisma cannot diff inside Unsupported("vector(n)"), so the dimension change
-- is written by hand.

-- The index has to go before the column type changes, and comes back after,
-- because an hnsw index is bound to the dimension it was built on.
DROP INDEX IF EXISTS cache_embedding_idx;

ALTER TABLE "CacheEntry"
  ALTER COLUMN "embedding" TYPE vector(384);

CREATE INDEX cache_embedding_idx
  ON "CacheEntry"
  USING hnsw (embedding vector_cosine_ops);
