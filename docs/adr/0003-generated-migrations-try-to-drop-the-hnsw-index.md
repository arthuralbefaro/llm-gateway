# 3. Every generated migration tries to drop the HNSW index

Status: accepted

## Context

`CacheEntry.embedding` is declared as `Unsupported("vector(384)")`, because
Prisma has no vector type. The HNSW index that makes the semantic cache viable
is created in raw SQL inside a migration:

```sql
CREATE INDEX cache_embedding_idx
  ON "CacheEntry"
  USING hnsw (embedding vector_cosine_ops);
```

Prisma cannot express an index over an `Unsupported` column, so the index is not
in the schema. Its migration diff finds an index the schema does not describe
and calls it drift. This is not a Prisma bug — given a schema that cannot
represent the index, an index in the database *is* drift. The consequence is
that **every** generated migration, whatever it was about, arrives containing:

```sql
-- DropIndex
DROP INDEX "cache_embedding_idx";
```

It first appeared in a migration whose only intended content was adding a
nullable column to `ApiKey` and creating an unrelated table.

## Why this is the most dangerous trap in the project

Applying it does not fail. Nothing errors, no test breaks, and the cache keeps
returning correct answers.

What changes is that every similarity lookup becomes a sequential scan. The
symptom is a cache that gets slower as it fills — which is also what a healthy
cache under growing load looks like. The real cause is a line in a migration
nobody read, applied weeks earlier, in a change about something else. Silent,
delayed, and its symptom points away from its cause.

## Decision

Two mechanisms, because review alone is not trustworthy.

**Review every generated migration.** Any `DROP INDEX "cache_embedding_idx"` is
removed unless immediately followed by a recreate, which is legitimate when the
column type changes and the index must be rebuilt at the new dimension.

**Guard the index with a test that fails loudly.** `pnpm test` replays the
create and drop statements for the index across every migration in order. If the
final state lacks it, the suite fails and names the migration that removed it.
The test is static — it parses SQL files and needs no database, so it runs
everywhere including CI, and catches the mistake when the migration is generated
rather than after it reaches production.

## Consequences

- A comment in a migration file is not a control. The next migration is a new
  file that does not inherit it, and the trap is per file.
- The guard fails on a real dimension change until the recreate is written into
  the same migration. That is the correct prompt.
- The guard checks that the index exists, not that it is the right kind. A
  migration recreating it as a btree would pass. Asserting `USING hnsw` is cheap
  and worth doing if the definition changes again.
- The rule generalises to anything in raw SQL over an `Unsupported` column: if
  the schema cannot describe it, Prisma will eventually try to delete it.

## Alternatives

**Trust the review step alone.** Rejected. It depends on somebody remembering,
on every migration, forever, including ones about unrelated things. The point of
the trap is that it appears where attention is not.

**Move the index into a startup script.** Rejected. It survives Prisma's diff,
but the database stops being reproducible from migrations alone, and
`prisma migrate reset` produces an environment differing from production
invisibly until it is slow.

**Store the embedding as a float array instead of `Unsupported`.** Rejected. It
removes the reason for pgvector: no vector operators, no HNSW, similarity search
becomes application-side work over every row.

**A live check against the database at boot.** Kept as a possible addition, not
a replacement. It proves the deployed database is correct, which the static
check cannot, but only fires after the bad migration is applied. The static
check fails earlier and in more places.
