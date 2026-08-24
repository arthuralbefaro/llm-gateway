import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');
const INDEX = 'cache_embedding_idx';

interface Statement {
  migration: string;
  action: 'create' | 'drop';
}

// prisma cannot describe an index over an Unsupported column, so it reads the
// hnsw index as drift and every generated migration arrives trying to drop it
// see docs/adr/0003
function indexStatements(): Statement[] {
  const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return migrations.flatMap((migration) => {
    const sql = readFileSync(
      join(MIGRATIONS_DIR, migration, 'migration.sql'),
      'utf8',
    );

    return sql
      .split(';')
      .map((statement) => stripComments(statement))
      .filter((statement) => statement.includes(INDEX))
      .map((statement): Statement | undefined => {
        if (/create\s+index/i.test(statement)) {
          return { migration, action: 'create' };
        }
        if (/drop\s+index/i.test(statement)) {
          return { migration, action: 'drop' };
        }
        return undefined;
      })
      .filter((statement): statement is Statement => statement !== undefined);
  });
}

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('migration guard', () => {
  const statements = indexStatements();

  it('creates the hnsw index at some point', () => {
    expect(statements.some((s) => s.action === 'create')).toBe(true);
  });

  it('leaves the hnsw index in place after every migration has run', () => {
    let present = false;
    let removedBy: string | undefined;

    for (const statement of statements) {
      if (statement.action === 'create') {
        present = true;
        removedBy = undefined;
      } else {
        present = false;
        removedBy = statement.migration;
      }
    }

    expect({ present, removedBy }).toEqual({
      present: true,
      removedBy: undefined,
    });
  });

  it('recreates the index in the same migration that drops it', () => {
    const byMigration = new Map<string, Set<string>>();
    for (const statement of statements) {
      const actions = byMigration.get(statement.migration) ?? new Set<string>();
      actions.add(statement.action);
      byMigration.set(statement.migration, actions);
    }

    const droppedWithoutRecreate = [...byMigration.entries()]
      .filter(([, actions]) => actions.has('drop') && !actions.has('create'))
      .map(([migration]) => migration);

    expect(droppedWithoutRecreate).toEqual([]);
  });
});
