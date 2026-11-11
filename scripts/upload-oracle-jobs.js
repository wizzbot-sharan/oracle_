import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { parseCsv } from '../src/shared/csv.js';

const { Pool } = pg;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = process.env.JOBS_CSV_PATH ? path.resolve(rootDir, process.env.JOBS_CSV_PATH) : path.resolve(rootDir, 'data/oracle_jobs.csv');

async function main() {
  console.log(`[Upload Oracle Jobs] Reading: ${csvPath}`);
  if (!fs.existsSync(csvPath)) {
    console.error(`[Error] CSV file not found at: ${csvPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(content);
  console.log(`[Upload Oracle Jobs] Parsed ${rows.length} rows from CSV.`);

  if (rows.length === 0) {
    console.log('[Upload Oracle Jobs] No rows found to upload.');
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

  if (connectionString) {
    console.log('[Upload Oracle Jobs] Connecting via direct PostgreSQL (DATABASE_URL)...');
    const pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 10000
    });

    try {
      // 1. Clear oracle_jobs table
      console.log('[Upload Oracle Jobs] Clearing existing records from oracle_jobs table...');
      await pool.query('DELETE FROM oracle_jobs;');
      console.log('[Upload Oracle Jobs] Table cleared.');

      // 2. Ensure referenced job_keys exist in jobs table to satisfy any foreign keys
      const uniqueJobsMap = new Map();
      for (const r of rows) {
        const k = (r.job_key || '').trim();
        const u = (r.job_url || '').trim();
        if (k && u && !uniqueJobsMap.has(k)) {
          uniqueJobsMap.set(k, u);
        }
      }

      if (uniqueJobsMap.size > 0) {
        for (const [k, u] of uniqueJobsMap.entries()) {
          await pool.query(`
            INSERT INTO jobs (job_key, job_url, metadata, updated_at)
            VALUES ($1, $2, '{}'::jsonb, NOW())
            ON CONFLICT (job_key) DO UPDATE SET job_url = EXCLUDED.job_url
          `, [k, u]);
        }
      }

      // 3. Batch insert rows into oracle_jobs
      const BATCH_SIZE = 100;
      let inserted = 0;

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        const values = [];
        const placeholders = [];

        chunk.forEach((r, idx) => {
          const offset = idx * 6;
          placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`);
          values.push(
            r.job_key?.trim() || null,
            r.job_url?.trim() || '',
            r.company_name?.trim() || '',
            r.client_name?.trim() || '',
            r.applywizz_id?.trim() || '',
            Number(r.score) || 0
          );
        });

        const query = `
          INSERT INTO oracle_jobs (job_key, job_url, company_name, client_name, applywizz_id, score)
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (job_key, applywizz_id) DO UPDATE SET
            job_url = EXCLUDED.job_url,
            company_name = EXCLUDED.company_name,
            client_name = EXCLUDED.client_name,
            score = EXCLUDED.score;
        `;

        await pool.query(query, values);
        inserted += chunk.length;
        process.stdout.write(`\r[Upload Oracle Jobs] Progress: [${inserted} / ${rows.length}] uploaded...`);
      }

      console.log(`\n✓ Successfully uploaded ${inserted} records into Supabase oracle_jobs table!`);
      console.log('👉 You can now run "Ingest" on the Railway Dashboard to process new job keys.');
    } finally {
      await pool.end();
    }
  } else if (supabaseUrl && supabaseKey) {
    console.log('[Upload Oracle Jobs] Connecting via Supabase REST API...');
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. Clear oracle_jobs table
    console.log('[Upload Oracle Jobs] Clearing existing records from oracle_jobs table...');
    const { error: delErr } = await supabase.from('oracle_jobs').delete().neq('id', 0);
    if (delErr) {
      console.warn('[Warning] Could not clear table via REST:', delErr.message);
    }

    // 2. Insert records in chunks
    const BATCH_SIZE = 100;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE).map(r => ({
        job_key: r.job_key?.trim() || null,
        job_url: r.job_url?.trim() || '',
        company_name: r.company_name?.trim() || '',
        client_name: r.client_name?.trim() || '',
        applywizz_id: r.applywizz_id?.trim() || '',
        score: Number(r.score) || 0
      }));

      const { error: insErr } = await supabase.from('oracle_jobs').upsert(chunk, { onConflict: 'job_key,applywizz_id' });
      if (insErr) {
        throw new Error(`Failed to insert batch: ${insErr.message}`);
      }
      inserted += chunk.length;
      process.stdout.write(`\r[Upload Oracle Jobs] Progress: [${inserted} / ${rows.length}] uploaded...`);
    }

    console.log(`\n✓ Successfully uploaded ${inserted} records into Supabase oracle_jobs table!`);
    console.log('👉 You can now run "Ingest" on the Railway Dashboard to process new job keys.');
  } else {
    console.error('[Error] Neither DATABASE_URL nor SUPABASE_URL & SUPABASE_KEY are set in environment.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\n[Upload Error]:', err.message);
  process.exit(1);
});
