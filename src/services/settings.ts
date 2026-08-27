import { db } from '../db';

const cache: Record<string, { value: string; ts: number }> = {};
const CACHE_TTL = 30_000; // 30s

export async function getSetting(key: string): Promise<string | null> {
  const now = Date.now();
  if (cache[key] && now - cache[key].ts < CACHE_TTL) return cache[key].value;

  const { rows } = await db.query(`SELECT value FROM admin_settings WHERE key = $1`, [key]);
  if (!rows[0]) return null;
  cache[key] = { value: rows[0].value, ts: now };
  return rows[0].value;
}

export async function setSetting(key: string, value: string, adminId?: string): Promise<void> {
  await db.query(
    `INSERT INTO admin_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = NOW()`,
    [key, value, adminId || null]
  );
  delete cache[key];
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const { rows } = await db.query(`SELECT key, value FROM admin_settings ORDER BY key`);
  return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
}
