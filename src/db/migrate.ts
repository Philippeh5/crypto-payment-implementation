import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { getPool, query } from './pool.js';
import pino from 'pino';

const logger = pino({ name: 'db-migrate' });
const __dirname = join(fileURLToPath(import.meta.url), '..');

async function runMigrations(): Promise<void> {
  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');

  logger.info('Running database migrations...');

  // Split by semicolon (simple approach — works for our schema)
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    try {
      await query(stmt);
      logger.debug({ stmt: stmt.slice(0, 80) + '...' }, 'Executed');
    } catch (err: any) {
      // Ignore "already exists" errors for idempotency
      if (err.code === '42P07' || err.code === '42710' || err.code === '42701') {
        logger.debug({ err: err.message }, 'Object already exists, skipping');
        continue;
      }
      throw err;
    }
  }

  logger.info('Migrations completed successfully');
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runMigrations();
    process.exit(0);
  } catch (err) {
    logger.fatal({ err }, 'Migration failed');
    process.exit(1);
  }
}

export { runMigrations };