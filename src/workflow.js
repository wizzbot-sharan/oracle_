import { config } from './config.js';
import { JsonStore } from './storage/json-store.js';
import { RunLog } from './storage/run-log.js';
import { KeyedLock } from './shared/locks.js';
import { ZohoMailReader } from './adapters/mail/zoho-mail-reader.js';
import { OracleRecruitingAdapter, SessionRegistry } from './adapters/oracle/oracle-recruiting.js';
import { Phase1IngestAuth } from './phases/phase1-ingest-auth.js';
import { Phase2ScanNormalize } from './phases/phase2-scan-normalize.js';
import { Phase3AnswerResolution } from './phases/phase3-answer-resolution.js';
import { Phase4ApplyReviewSubmit } from './phases/phase4-apply-review-submit.js';
import { ScanQueueRunner } from './phases/scan-queue.js';
import { SubmissionQueueRunner } from './phases/submission-queue.js';
import { resumeService } from './services/resume-service.js';

const store = new JsonStore(config.dataDir);
const runLog = new RunLog(store);
const otpLock = new KeyedLock();
const sessions = new SessionRegistry();
const mailReader = new ZohoMailReader({ baseUrl: config.mailReaderBaseUrl });
const oracle = new OracleRecruitingAdapter({
  headless: config.headless,
  humanDelay: config.humanDelay,
  actionGap: config.actionGap,
  postNextWait: config.postNextWait,
  pageSettle: config.pageSettle,
  runtimeDir: config.runtimeDir
});
const phase1 = new Phase1IngestAuth({ store, runLog, oracle, mailReader, otpLock });
const phase2 = new Phase2ScanNormalize({ store, runLog, oracle });
const phase3 = new Phase3AnswerResolution({ store, runLog, config });
const phase4 = new Phase4ApplyReviewSubmit({ store, runLog, oracle, phase1, sessions, resumeService, config });
const scanQueue = new ScanQueueRunner({ store, runLog, oracle, phase1, phase2, config });
const submissionQueue = new SubmissionQueueRunner({ store, runLog, oracle, phase1, phase4, sessions, resumeService, config });

export const workflow = { store, runLog, oracle, mailReader, sessions, phase1, phase2, phase3, phase4, scanQueue, submissionQueue, resumeService };
