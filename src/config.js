import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function numberEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

export const config = Object.freeze({
  rootDir,
  port: numberEnv('PORT', 4100),
  headless: process.env.HEADLESS !== 'false',
  humanDelay: {
    min: numberEnv('HUMAN_DELAY_MIN_MS', 50),
    max: numberEnv('HUMAN_DELAY_MAX_MS', 200)
  },
  actionGap: {
    min: numberEnv('ACTION_GAP_MIN_MS', 1000),
    max: numberEnv('ACTION_GAP_MAX_MS', 2000)
  },
  postNextWait: {
    min: numberEnv('POST_NEXT_WAIT_MIN_MS', 3000),
    max: numberEnv('POST_NEXT_WAIT_MAX_MS', 5000)
  },
  pageSettle: {
    min: numberEnv('PAGE_SETTLE_MIN_MS', 5000),
    max: numberEnv('PAGE_SETTLE_MAX_MS', 10000)
  },
  mailReaderBaseUrl: process.env.MAIL_READER_BASE_URL ?? 'https://zoho-mail-reader.onrender.com/api/zoho/ui',
  testEmail: process.env.TEST_EMAIL ?? null,
  jobsCsvPath: path.resolve(rootDir, process.env.JOBS_CSV_PATH ?? 'data/jobs.sample.csv'),
  dataDir: path.resolve(rootDir, 'data'),
  runtimeDir: path.resolve(rootDir, 'data/runtime')
});
