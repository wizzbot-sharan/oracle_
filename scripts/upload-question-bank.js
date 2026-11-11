import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { parseCsv } from '../src/shared/csv.js';

const { Pool } = pg;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = process.env.QUESTION_BANK_CSV_PATH
  ? path.resolve(rootDir, process.env.QUESTION_BANK_CSV_PATH)
  : path.resolve(rootDir, 'data/question_bank.csv');

async function main() {
  console.log(`[Upload Question Bank] Reading: ${csvPath}`);
  if (!fs.existsSync(csvPath)) {
    console.error(`[Error] CSV file not found at: ${csvPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  console.log('[Upload Question Bank] Parsing CSV content...');
  const rows = parseCsv(content);
  console.log(`[Upload Question Bank] Parsed ${rows.length} total rows.`);

  if (rows.length === 0) {
    console.log('[Upload Question Bank] No records found.');
    return;
  }

  // Deduplicate in-memory by (applywizz_id + question_label) to prevent single-batch conflict errors
  const dedupedMap = new Map();
  for (const r of rows) {
    const applywizzId = (r.applywizz_id || '').trim();
    const label = (r.question_label || '').trim();
    if (!label) continue;

    const key = `${applywizzId}::${label.toLowerCase()}`;
    dedupedMap.set(key, {
      applywizz_id: applywizzId || null,
      question_label: label,
      field_type: (r.field_type || 'text').trim(),
      value: r.value ?? '',
      source: (r.source || 'manual').trim(),
      confidence: Number(r.confidence) || 1.0,
      created_at: r.created_at || new Date().toISOString(),
      updated_at: r.updated_at || new Date().toISOString()
    });
  }

  const dedupedRows = [...dedupedMap.values()];
  console.log(`[Upload Question Bank] Unique questions after deduplication: ${dedupedRows.length}`);

  const connectionString = process.env.DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

  if (connectionString) {
    console.log('[Upload Question Bank] Connecting via direct PostgreSQL (DATABASE_URL)...');
    const pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 10000
    });

    try {
      const BATCH_SIZE = 250;
      let inserted = 0;

      for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
        const chunk = dedupedRows.slice(i, i + BATCH_SIZE);
        const values = [];
        const placeholders = [];

        chunk.forEach((r, idx) => {
          const offset = idx * 8;
          placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`);
          values.push(
            r.applywizz_id,
            r.question_label,
            r.field_type,
            r.value,
            r.source,
            r.confidence,
            r.created_at,
            r.updated_at
          );
        });

        const query = `
          INSERT INTO question_bank (
            applywizz_id, question_label, field_type, value, source, confidence, created_at, updated_at
          ) VALUES ${placeholders.join(', ')}
          ON CONFLICT (applywizz_id, question_label) WHERE applywizz_id IS NOT NULL DO UPDATE SET
            field_type = EXCLUDED.field_type,
            value = EXCLUDED.value,
            source = EXCLUDED.source,
            confidence = EXCLUDED.confidence,
            updated_at = EXCLUDED.updated_at;
        `;

        await pool.query(query, values);
        inserted += chunk.length;
        const pct = ((inserted / dedupedRows.length) * 100).toFixed(1);
        process.stdout.write(`\r[Upload Question Bank] Progress: [${inserted} / ${dedupedRows.length}] (${pct}%)...`);
      }

      console.log(`\n✓ Successfully synced ${inserted} Question Bank records to Supabase!`);
    } finally {
      await pool.end();
    }
  } else if (supabaseUrl && supabaseKey) {
    console.log('[Upload Question Bank] Connecting via Supabase REST API...');
    const supabase = createClient(supabaseUrl, supabaseKey);

    const BATCH_SIZE = 250;
    let inserted = 0;

    for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
      const chunk = dedupedRows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from('question_bank').upsert(chunk, {
        onConflict: 'applywizz_id,question_label'
      });

      if (error) {
        throw new Error(`Failed to upsert batch: ${error.message}`);
      }

      inserted += chunk.length;
      const pct = ((inserted / dedupedRows.length) * 100).toFixed(1);
      process.stdout.write(`\r[Upload Question Bank] Progress: [${inserted} / ${dedupedRows.length}] (${pct}%)...`);
    }

    console.log(`\n✓ Successfully synced ${inserted} Question Bank records to Supabase!`);
  } else {
    console.error('[Error] Neither DATABASE_URL nor SUPABASE_URL & SUPABASE_KEY are set in environment.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\n[Upload Error]:', err.message);
  process.exit(1);
});
