import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema';

export type Db = PgliteDatabase<typeof schema>;
export { schema };

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function openDb(dataDir: string | 'memory'): Promise<{ db: Db; client: PGlite }> {
  let client: PGlite;
  if (dataDir === 'memory') {
    client = new PGlite();
  } else {
    mkdirSync(dataDir, { recursive: true });
    client = new PGlite(dataDir);
  }
  await client.waitReady;
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return { db, client };
}
