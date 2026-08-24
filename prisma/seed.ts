import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { generateApiKey, hashApiKey } from '../src/common/api-key';

const DEV_KEY_NAME = 'development';

// generous on purpose, this key exists for local demos and load tests, and a
// low default already produced one voided measurement whose 429s looked like
// excellent latency (docs/load/read-path-after-opt-in.md)
const DEV_KEY_RATE_LIMIT = 100000;

// this uses pg rather than PrismaClient because the prisma-client generator
// emits typescript with .js specifiers that ts-node cannot resolve, and running
// the seed should not depend on a build having happened first
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const rotate = process.argv.includes('--rotate');
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const existing = await client.query(
      'SELECT "id" FROM "ApiKey" WHERE "name" = $1',
      [DEV_KEY_NAME],
    );

    // a restart must not invalidate a key somebody is using, so an existing
    // key is left alone unless rotation is asked for explicitly
    if (existing.rowCount !== 0 && !rotate) {
      process.stdout.write(
        'development api key already exists, run with --rotate to replace it\n',
      );
      return;
    }

    const key = generateApiKey();
    const hash = hashApiKey(key);

    if (existing.rowCount === 0) {
      await client.query(
        'INSERT INTO "ApiKey" ("id", "name", "hash", "rateLimit") VALUES ($1, $2, $3, $4)',
        [randomUUID(), DEV_KEY_NAME, hash, DEV_KEY_RATE_LIMIT],
      );
    } else {
      await client.query(
        'UPDATE "ApiKey" SET "hash" = $1, "active" = true, "rateLimit" = $2 WHERE "name" = $3',
        [hash, DEV_KEY_RATE_LIMIT, DEV_KEY_NAME],
      );
    }

    process.stdout.write(
      `\n  development api key (shown once, only the hash is stored):\n\n    ${key}\n\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  process.stderr.write(
    `${error instanceof Error ? error.message : 'seed failed'}\n`,
  );
});
