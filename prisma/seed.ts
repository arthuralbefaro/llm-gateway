import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { generateApiKey, hashApiKey } from '../src/common/api-key';

const DEV_KEY_NAME = 'development';

// this uses pg rather than PrismaClient because the prisma-client generator
// emits typescript with .js specifiers that ts-node cannot resolve, and running
// the seed should not depend on a build having happened first
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const key = generateApiKey();
  const hash = hashApiKey(key);
  const client = new Client({ connectionString });
  await client.connect();

  try {
    // rotating on re-run keeps the seed idempotent without leaving behind a key
    // whose plaintext nobody has
    const updated = await client.query(
      'UPDATE "ApiKey" SET "hash" = $1, "active" = true WHERE "name" = $2 RETURNING "id"',
      [hash, DEV_KEY_NAME],
    );

    if (updated.rowCount === 0) {
      await client.query(
        'INSERT INTO "ApiKey" ("id", "name", "hash") VALUES ($1, $2, $3)',
        [randomUUID(), DEV_KEY_NAME, hash],
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
