import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { SupabaseStore } from '../src/storage/supabase-store.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const migrationFile = process.argv[2] || path.join(__dirname, 'migrations', '003_create_resume_parsed_table.sql');
  const sql = fs.readFileSync(migrationFile, 'utf8');

  console.log(`[Migration] Running ${path.basename(migrationFile)}...`);
  const store = new SupabaseStore();
  if (!store.isAvailable()) {
    console.error('[Migration] Supabase store is not available. Check DATABASE_URL or SUPABASE_URL.');
    process.exit(1);
  }

  try {
    await store.query(sql);
    console.log(`[Migration] ✓ Migration applied successfully!`);
  } catch (err) {
    console.error(`[Migration] ✗ Migration failed:`, err.message);
    process.exit(1);
  } finally {
    await store.close();
  }
}

run();
