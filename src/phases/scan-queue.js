import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from '../shared/csv.js';
import { parseOracleJobUrl } from '../shared/url.js';
import { config } from '../config.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ScanQueueRunner {
  constructor({ store, runLog, oracle, phase1, phase2, config: customConfig }) {
    this.store = store;
    this.runLog = runLog;
    this.oracle = oracle;
    this.phase1 = phase1;
    this.phase2 = phase2;
    this.config = customConfig ?? config;

    this.lastLaunchTime = 0;
    this.launchLock = Promise.resolve();
  }

  async waitForLaunchSlot(throttleMs) {
    if (throttleMs <= 0) return;

    let release;
    const currentLock = this.launchLock;
    this.launchLock = new Promise(resolve => { release = resolve; });

    await currentLock;
    try {
      const now = Date.now();
      const elapsed = now - this.lastLaunchTime;
      if (this.lastLaunchTime > 0 && elapsed < throttleMs) {
        const waitMs = throttleMs - elapsed;
        await delay(waitMs);
      }
      this.lastLaunchTime = Date.now();
    } finally {
      release();
    }
  }

  async runQueue(options = {}) {
    const jobsCsvPath = path.resolve(options.jobsCsvPath ?? this.config.jobsCleanCsvPath);
    const statusPath = path.resolve(options.statusPath ?? this.config.scanner?.statusPath ?? path.resolve(this.config.dataDir, 'scan-status.json'));
    const concurrency = options.concurrency ?? this.config.scanner?.concurrency ?? 3;
    const launchThrottleMs = options.launchThrottleMs ?? this.config.scanner?.launchThrottleMs ?? 30000;
    const cooldownMs = options.cooldownMs ?? this.config.scanner?.cooldownMs ?? 10000;
    const limit = options.limit ? Number(options.limit) : Infinity;
    const force = Boolean(options.force);

    // Scanner dummy email pool
    let emails = options.scannerEmails ?? this.config.scanner?.emails;
    if (!emails || emails.length === 0) {
      const fallbackEmail = this.config.testEmail ?? 'scanner@applywizard.ai';
      emails = [fallbackEmail];
    }

    // 1. Load data/jobs.csv
    const rawCsv = await fs.readFile(jobsCsvPath, 'utf8');
    const allJobs = parseCsv(rawCsv);

    // 2. Load existing scan status and form templates for idempotency
    let scanStatus = { updatedAt: null, summary: {}, jobs: {} };
    try {
      const rawStatus = await fs.readFile(statusPath, 'utf8');
      scanStatus = JSON.parse(rawStatus);
    } catch {
      // Clean slate if file does not exist
    }

    const existingTemplates = await this.store.read('form-templates', {});

    // 3. Determine pending queue
    const queue = [];
    for (const job of allJobs) {
      const key = job.job_key;
      const existingStatus = scanStatus.jobs?.[key];
      const hasTemplate = Boolean(existingTemplates[key]);

      if (!force && (existingStatus?.status === 'completed' || existingStatus?.status === 'skipped' || hasTemplate)) {
        if (!scanStatus.jobs[key]) {
          scanStatus.jobs[key] = {
            job_key: key,
            job_url: job.job_url,
            status: hasTemplate ? 'completed' : existingStatus?.status,
            reused: true
          };
        }
        continue;
      }

      queue.push(job);
    }

    // Apply batch limit if specified
    const targetQueue = Number.isFinite(limit) && limit > 0 ? queue.slice(0, limit) : queue;

    console.log(`\n=== Oracle 3-Worker Scanner Queue ===`);
    console.log(`Total jobs in jobs.csv:  ${allJobs.length}`);
    console.log(`Already scanned/skipped: ${allJobs.length - queue.length}`);
    console.log(`Queued for this run:     ${targetQueue.length}${Number.isFinite(limit) ? ` (capped by --limit ${limit})` : ''}`);
    console.log(`Concurrency workers:     ${concurrency}`);
    console.log(`Launch throttle:         ${launchThrottleMs / 1000}s`);
    console.log(`Worker cooldown:         ${cooldownMs / 1000}s`);
    console.log(`Scanner accounts:        ${emails.join(', ')}\n`);

    const updateStatusFile = async () => {
      let completed = 0;
      let skipped = 0;
      let failed = 0;
      let inProgress = 0;

      for (const item of Object.values(scanStatus.jobs)) {
        if (item.status === 'completed') completed += 1;
        else if (item.status === 'skipped') skipped += 1;
        else if (item.status === 'failed') failed += 1;
        else if (item.status === 'in_progress') inProgress += 1;
      }

      const total = allJobs.length;
      const pending = total - (completed + skipped + failed + inProgress);

      scanStatus.updatedAt = new Date().toISOString();
      scanStatus.summary = { total, completed, skipped, failed, inProgress, pending };

      await fs.mkdir(path.dirname(statusPath), { recursive: true });
      await fs.writeFile(statusPath, JSON.stringify(scanStatus, null, 2), 'utf8');
    };

    await updateStatusFile();

    let jobIndex = 0;

    const workerLoop = async workerId => {
      const email = emails[workerId % emails.length];
      const workerTag = `[Worker ${workerId + 1}]`;

      while (true) {
        if (jobIndex >= targetQueue.length) break;
        const currentJob = targetQueue[jobIndex];
        jobIndex += 1;

        const { job_key, job_url } = currentJob;

        scanStatus.jobs[job_key] = {
          job_key,
          job_url,
          status: 'in_progress',
          workerId: workerId + 1,
          email,
          startedAt: new Date().toISOString()
        };
        await updateStatusFile();

        let parsed = {};
        try {
          parsed = parseOracleJobUrl(job_url);
        } catch {
          parsed = { canonicalUrl: job_url, sourceJobId: job_key, tenantHost: '', tenantKey: '' };
        }

        const jobData = {
          jobId: parsed.sourceJobId || job_key,
          jobKey: job_key,
          jobUrl: job_url,
          ...parsed
        };

        const executeScanAttempt = async attemptNumber => {
          console.log(`${workerTag} [${job_key}] Waiting for launch slot (${launchThrottleMs / 1000}s throttle)...`);
          await this.waitForLaunchSlot(launchThrottleMs);

          console.log(`${workerTag} [${job_key}] Launching browser session (Attempt ${attemptNumber}) using ${email}...`);
          const startTime = Date.now();

          const { session, result } = await this.phase1.authenticate({
            applicationId: `scan-${job_key}`,
            job: jobData,
            email
          });

          if (result?.status === 'skipped') {
            console.log(`${workerTag} [${job_key}] ⚠ Skipped: ${result.reason} (${result.message})`);
            scanStatus.jobs[job_key] = {
              job_key,
              job_url,
              status: 'skipped',
              reason: result.reason,
              message: result.message,
              workerId: workerId + 1,
              durationMs: Date.now() - startTime,
              completedAt: new Date().toISOString()
            };
            await updateStatusFile();
            return { skipped: true };
          }

          try {
            console.log(`${workerTag} [${job_key}] Walking and exploring form schema...`);
            const template = await this.phase2.scan({ session, job: jobData });
            const durationMs = Date.now() - startTime;

            console.log(`${workerTag} [${job_key}] ✓ Completed in ${(durationMs / 1000).toFixed(1)}s (${template.fields.length} fields, ${template.conditionalBranches.length} branches).`);

            scanStatus.jobs[job_key] = {
              job_key,
              job_url,
              status: 'completed',
              templateId: template.templateId,
              fieldsCount: template.fields.length,
              branchesCount: template.conditionalBranches.length,
              repeatableGroupsCount: template.repeatableGroups.length,
              submitPresent: template.scan?.submitPresent ?? false,
              workerId: workerId + 1,
              durationMs,
              completedAt: new Date().toISOString()
            };
            await updateStatusFile();
            return { completed: true };
          } finally {
            if (session) {
              await this.oracle.closeSession(session).catch(() => {});
            }
          }
        };

        // Execution with Retry-Once logic
        try {
          await executeScanAttempt(1);
        } catch (error) {
          console.warn(`${workerTag} [${job_key}] ⚠ Attempt 1 failed: ${error.message}. Pausing ${cooldownMs / 1000}s before retry...`);
          await delay(cooldownMs);

          try {
            await executeScanAttempt(2);
          } catch (retryError) {
            console.error(`${workerTag} [${job_key}] ✖ Failed attempt 2: ${retryError.message}`);
            scanStatus.jobs[job_key] = {
              job_key,
              job_url,
              status: 'failed',
              error: retryError.message,
              code: retryError.code ?? 'UNKNOWN',
              workerId: workerId + 1,
              failedAt: new Date().toISOString()
            };
            await updateStatusFile();
          }
        }

        console.log(`${workerTag} [${job_key}] Cooldown of ${cooldownMs / 1000}s starting...`);
        await delay(cooldownMs);
      }

      console.log(`${workerTag} Finished all assigned tasks.`);
    };

    const workerCount = Math.min(concurrency, targetQueue.length || 1);
    await Promise.all(Array.from({ length: workerCount }, (_, idx) => workerLoop(idx)));

    await updateStatusFile();

    console.log(`\n========================================`);
    console.log(`Scanner Queue Finished!`);
    console.log(`Completed: ${scanStatus.summary.completed}`);
    console.log(`Skipped:   ${scanStatus.summary.skipped}`);
    console.log(`Failed:    ${scanStatus.summary.failed}`);
    console.log(`Saved to:  ${statusPath}`);
    console.log(`========================================\n`);

    return scanStatus;
  }
}
