import { Pool, PoolClient, QueryResult } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

const pool = new Pool({
  connectionString: config.db.url,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error', { err: err.message });
});

export const db = {
  async query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
    const start = Date.now();
    try {
      const res = await pool.query<T>(text, params);
      logger.debug('DB query', { text: text.substring(0, 80), duration: Date.now() - start, rows: res.rowCount });
      return res;
    } catch (err: any) {
      logger.error('DB query error', { text: text.substring(0, 80), err: err.message });
      throw err;
    }
  },

  async getClient(): Promise<PoolClient> {
    return pool.connect();
  },

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async healthCheck(): Promise<boolean> {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  },

  async end(): Promise<void> {
    await pool.end();
  },
};

export type DbClient = PoolClient;
