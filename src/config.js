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
  jobsCsvPath: path.resolve(rootDir, process.env.JOBS_CSV_PATH ?? 'data/oracle_jobs.csv'),
  jobsCleanCsvPath: path.resolve(rootDir, process.env.JOBS_CLEAN_CSV_PATH ?? 'data/jobs.csv'),
  clientsPath: path.resolve(rootDir, process.env.CLIENTS_PATH ?? 'data/clients.json'),
  questionBankCsvPath: path.resolve(rootDir, process.env.QUESTION_BANK_CSV_PATH ?? 'data/question_bank.csv'),
  dataDir: path.resolve(rootDir, 'data'),
  runtimeDir: path.resolve(rootDir, 'data/runtime'),
  llmDelayMs: numberEnv('LLM_DELAY_MS', 2000),
  llmBatchMaxQuestions: numberEnv('LLM_BATCH_MAX_QUESTIONS', 20),
  scanner: {
    concurrency: numberEnv('SCANNER_CONCURRENCY', 3),
    launchThrottleMs: numberEnv('SCANNER_LAUNCH_THROTTLE_MS', 30000),
    cooldownMs: numberEnv('SCANNER_COOLDOWN_MS', 10000),
    tenantCooldownMs: numberEnv('SCANNER_TENANT_COOLDOWN_MS', 45000),
    tenantJitterMs: {
      min: numberEnv('SCANNER_TENANT_JITTER_MIN_MS', 10000),
      max: numberEnv('SCANNER_TENANT_JITTER_MAX_MS', 20000)
    },
    captchaBackoffMs: numberEnv('SCANNER_CAPTCHA_BACKOFF_MS', 300000),
    browserChannel: process.env.BROWSER_CHANNEL ?? 'chrome',
    emails: [
      process.env.SCANNER_EMAIL_1,
      process.env.SCANNER_EMAIL_2,
      process.env.SCANNER_EMAIL_3
    ].map(e => e?.trim()).filter(Boolean),
    statusPath: path.resolve(rootDir, process.env.SCAN_STATUS_PATH ?? 'data/scan-status.json')
  },
  submission: {
    concurrency: numberEnv('SUBMISSION_CONCURRENCY', 3),
    launchThrottleMs: numberEnv('SUBMISSION_LAUNCH_THROTTLE_MS', 30000),
    cooldownMs: numberEnv('SUBMISSION_COOLDOWN_MS', 10000),
    submitWaitMs: numberEnv('SUBMISSION_SETTLE_MS', 10000),
    submitDir: path.resolve(rootDir, process.env.SUBMISSION_DIR ?? 'data/submit'),
    resumeDir: path.resolve(rootDir, process.env.RESUME_DIR ?? 'data/runtime/resumes'),
    statusPath: path.resolve(rootDir, process.env.SUBMISSION_STATUS_PATH ?? 'data/submission-status.json'),
    dryRun: process.env.SUBMISSION_DRY_RUN !== 'false'
  }
});
