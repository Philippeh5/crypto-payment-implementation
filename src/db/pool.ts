import pg from 'pg';
import { getConfig } from '../config.js';
import pino from 'pino';

const { Pool } = pg;
const logger = pino({ name: 'db-pool' });

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const config = getConfig();
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logger.fatal({ err }, 'Unexpected pool error');
    });

    logger.info('Database pool initialized');
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
}

/**
 * Execute a query with automatic retry on serialization failures.
 */
export async function query<T = any>(
  text: string,
  params?: any[],
  retries = 3
): Promise<pg.QueryResult<T>> {
  const pool = getPool();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await pool.query<T>(text, params);
      return result;
    } catch (err: any) {
      lastError = err;
      // Retry on serialization failure (40001) or deadlock (40P01)
      if (err.code === '40001' || err.code === '40P01') {
        logger.warn({ attempt, err: err.message }, 'Serialization/deadlock error, retrying...');
        await new Promise(r => setTimeout(r, 50 * attempt));
        continue;
      }
      throw err;
    }
  }

  throw lastError!;
}

/**
 * Execute a function within a transaction with automatic retry.
 */
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  retries = 3
): Promise<T> {
  const pool = getPool();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      lastError = err;
      await client.query('ROLLBACK').catch(() => {});
      // Retry on serialization failure or deadlock
      if (err.code === '40001' || err.code === '40P01') {
        logger.warn({ attempt, err: err.message }, 'Transaction serialization/deadlock, retrying...');
        await new Promise(r => setTimeout(r, 50 * attempt));
        client.release();
        continue;
      }
      client.release();
      throw err;
    } finally {
      // Client released in catch or after commit
    }
  }

  throw lastError!;
}

/**
 * Acquire an advisory lock for coordination.
 * Use for: per-user deposit crediting, withdrawal processing.
 * Lock is released at transaction end or explicitly.
 */
export async function withAdvisoryLock<T>(
  lockKey: bigint,
  fn: () => Promise<T>
): Promise<T> {
  return transaction(async (client) => {
    // Try to acquire lock (non-blocking variant returns boolean)
    const acquired = await client.query(
      'SELECT pg_try_advisory_xact_lock($1)',
      [lockKey.toString()]
    );

    if (!acquired.rows[0]?.pg_try_advisory_xact_lock) {
      throw new Error(`Could not acquire advisory lock for key ${lockKey}`);
    }

    return fn();
  });
}

/**
 * Generate a consistent advisory lock key from a string.
 * Uses hash to fit in 64-bit signed integer.
 */
export function getAdvisoryLockKey(namespace: string, identifier: string): bigint {
  // Simple FNV-1a hash for consistent 64-bit key
  let hash = 0xcbf29ce484222325n;
  const str = `${namespace}:${identifier}`;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash *= 0x100000001b3n;
  }
  // Ensure positive signed 64-bit
  return (hash & 0x7fffffffffffffffbign);
}

/**
 * Health check query.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}