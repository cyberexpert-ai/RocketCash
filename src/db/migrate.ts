import fs from 'fs';
import path from 'path';
import { db } from './index';

async function migrate() {
  console.log('Running migrations...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await db.query(
      'SELECT id FROM schema_migrations WHERE filename = $1', [file]
    );
    if (rows.length > 0) {
      console.log(`  Skipping ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`  Applying ${file}...`);
    await db.query(sql);
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    console.log(`  ✓ ${file}`);
  }
  console.log('Migrations complete.');
  await db.end();
}

migrate().catch(err => { console.error(err); process.exit(1); });
