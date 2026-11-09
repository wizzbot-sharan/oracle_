import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from '../shared/csv.js';
import { parseOracleJobUrl } from '../shared/url.js';
import { parseJobSelector, isJobSelected } from '../shared/job-filter.js';
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

    this.isScanning = false;
    this.cancelRequested = false;
    this.workerSlots = Array.from({ length: 3 }, (_, idx) => ({
      slotId: idx + 1,
      workerId: idx + 1,
      status: 'idle', // 'idle' | 'waiting' | 'authenticating' | 'scanning' | 'cooldown'
      jobKey: null,
      jobUrl: null,
      email: null,
      step: null,
      startedAt: null,
      cooldownUntil: null
    }));
  }

  getWorkerStatus() {
    const now = Date.now();
    for (const s of this.workerSlots) {
      if (s.status === 'cooldown' && s.cooldownUntil && now >= s.cooldownUntil) {
        s.status = 'idle';
        s.jobKey = null;
        s.step = null;
      }
    }
    return {
      isScanning: this.isScanning,
      slots: this.workerSlots.map(s => ({ ...s }))
    };
  }

  cancelQueue() {
    if (this.isScanning) {
      this.cancelRequested = true;
      return true;
    }
    return false;
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

  static interleaveByTenant(jobs) {
    const buckets = new Map();
    for (const job of jobs) {
      const key = job.tenantHost || 'unknown';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(job);
    }

    const interleaved = [];
    let remaining = jobs.length;
    while (remaining > 0) {
      for (const bucket of buckets.values()) {
        if (bucket.length > 0) {
          interleaved.push(bucket.shift());
          remaining -= 1;
        }
      }
    }
    return interleaved;
  }

  async runQueue(options = {}) {
    const jobsCsvPath = path.resolve(options.jobsCsvPath ?? this.config.jobsCleanCsvPath);
    const statusPath = path.resolve(options.statusPath ?? this.config.scanner?.statusPath ?? path.resolve(this.config.dataDir, 'scan-status.json'));
    const concurrency = options.concurrency ?? this.config.scanner?.concurrency ?? 3;
    const launchThrottleMs = options.launchThrottleMs ?? this.config.scanner?.launchThrottleMs ?? 30000;
    const tenantCooldownBaseMs = options.tenantCooldownMs ?? options.cooldownMs ?? this.config.scanner?.tenantCooldownMs ?? 45000;
    const hasCustomCooldown = options.cooldownMs !== undefined || options.tenantCooldownMs !== undefined;
    const jitterMinMs = options.jitterMinMs ?? (hasCustomCooldown ? 0 : (this.config.scanner?.tenantJitterMs?.min ?? 10000));
    const jitterMaxMs = options.jitterMaxMs ?? (hasCustomCooldown ? 0 : (this.config.scanner?.tenantJitterMs?.max ?? 20000));
    const captchaBackoffMs = options.captchaBackoffMs ?? this.config.scanner?.captchaBackoffMs ?? 300000;
    const limit = options.limit ? Number(options.limit) : Infinity;
    const force = Boolean(options.force);

    // Scanner dummy email pool
    let emails = options.scannerEmails ?? this.config.scanner?.emails;
    if (!emails || emails.length === 0) {
      const fallbackEmail = this.config.testEmail ?? 'scanner@applywizard.ai';
      emails = [fallbackEmail];
    }

    // 1. Load jobs: Prefer SupabaseStore, fallback to CSV
    let allJobs = [];
    if (typeof this.store?.isAvailable === 'function' && this.store.isAvailable()) {
      try {
        const jobsData = await this.store.read('jobs', { uniqueJobs: [] });
        allJobs = (jobsData.uniqueJobs || []).map(j => ({
          job_key: j.jobKey || j.job_key,
          job_url: j.jobUrl || j.job_url,
          tenant_host: j.tenantHost || j.tenant_host
        }));
      } catch (err) {
        console.warn(`[Scanner] Supabase jobs read failed, falling back to CSV: ${err.message}`);
      }
    }

    if (allJobs.length === 0) {
      try {
        const rawCsv = await fs.readFile(jobsCsvPath, 'utf8');
        allJobs = parseCsv(rawCsv);
      } catch (err) {
        console.warn(`[Scanner] Could not read ${jobsCsvPath}: ${err.message}`);
      }
    }

    // 2. Load existing scan status and form templates for idempotency
    let scanStatus = { updatedAt: null, summary: {}, jobs: {} };
    if (typeof this.store?.isAvailable === 'function' && this.store.isAvailable()) {
      try {
        scanStatus = await this.store.read('scan-status', scanStatus);
      } catch (err) {
        console.warn(`[Scanner] Supabase scan_status read warning: ${err.message}`);
      }
    } else {
      try {
        const rawStatus = await fs.readFile(statusPath, 'utf8');
        scanStatus = JSON.parse(rawStatus);
      } catch {
        // Clean slate if file does not exist
      }
    }

    if (!scanStatus.jobs) scanStatus.jobs = {};

    const existingTemplates = await this.store.read('form-templates', {});

    const selector = parseJobSelector(options);

    // 3. Determine pending queue and parse tenantHost
    let totalInScope = 0;
    const queue = [];
    for (const job of allJobs) {
      const key = job.job_key;
      if (!isJobSelected(key, selector)) {
        continue;
      }
      totalInScope += 1;

      let parsed = {};
      try {
        parsed = parseOracleJobUrl(job.job_url);
      } catch {
        parsed = { canonicalUrl: job.job_url, sourceJobId: key, tenantHost: 'unknown', tenantKey: '' };
      }
      job.tenantHost = parsed.tenantHost || 'unknown';
      job.parsedUrl = parsed;

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

    // Apply batch limit if specified, then interleave by tenantHost
    const targetQueue = Number.isFinite(limit) && limit > 0 ? queue.slice(0, limit) : queue;
    const pendingJobs = ScanQueueRunner.interleaveByTenant(targetQueue);

    console.log(`\n=== Oracle 3-Worker Scanner Queue ===`);
    if (selector.hasFilter) {
      console.log(`Target Scope:            ${selector.description}`);
      console.log(`Jobs matching scope:     ${totalInScope}`);
      console.log(`Already scanned/skipped: ${totalInScope - queue.length}`);
    } else {
      console.log(`Total jobs in jobs.csv:  ${allJobs.length}`);
      console.log(`Already scanned/skipped: ${allJobs.length - queue.length}`);
    }
    console.log(`Queued for this run:     ${pendingJobs.length}${Number.isFinite(limit) ? ` (capped by --limit ${limit})` : ''}`);
    console.log(`Concurrency workers:     ${concurrency}`);
    console.log(`Launch throttle:         ${launchThrottleMs / 1000}s`);
    console.log(`Tenant cooldown:         ${tenantCooldownBaseMs / 1000}s base (+${jitterMinMs / 1000}s-${jitterMaxMs / 1000}s jitter)`);
    console.log(`CAPTCHA backoff:         ${captchaBackoffMs / 1000}s`);
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
        else if (item.status === 'in_progress' || item.status === 'retry_backoff') inProgress += 1;
      }

      const total = allJobs.length;
      const pending = total - (completed + skipped + failed + inProgress);

      scanStatus.updatedAt = new Date().toISOString();
      scanStatus.summary = { total, completed, skipped, failed, inProgress, pending };

      if (typeof this.store?.isAvailable === 'function' && this.store.isAvailable()) {
        try {
          await this.store.write('scan-status', scanStatus);
        } catch (err) {
          console.warn(`[Scanner] Warning: Failed to persist scan-status to Supabase: ${err.message}`);
        }
      }

      try {
        await fs.mkdir(path.dirname(statusPath), { recursive: true });
        await fs.writeFile(statusPath, JSON.stringify(scanStatus, null, 2), 'utf8');
      } catch {}
    };

    await updateStatusFile();

    this.isScanning = true;
    this.cancelRequested = false;

    try {
      const activeTenants = new Set();
      const tenantCooldowns = new Map();
      const tenantEmailIndex = new Map();
      const jobAttemptCount = new Map();

      const getNextEligibleJob = () => {
        const now = Date.now();
        for (let i = 0; i < pendingJobs.length; i++) {
          const candidate = pendingJobs[i];
          const tenant = candidate.tenantHost;

          if (activeTenants.has(tenant)) continue;

          const cooldownExpiry = tenantCooldowns.get(tenant) ?? 0;
          if (cooldownExpiry > now) continue;

          pendingJobs.splice(i, 1);
          activeTenants.add(tenant);
          return { job: candidate, waitMs: 0 };
        }

        if (pendingJobs.length === 0) {
          return { job: null, waitMs: 0 };
        }

        let minWait = Infinity;
        for (const candidate of pendingJobs) {
          const tenant = candidate.tenantHost;
          if (!activeTenants.has(tenant)) {
            const cooldownExpiry = tenantCooldowns.get(tenant) ?? 0;
            const wait = Math.max(0, cooldownExpiry - now);
            if (wait < minWait) minWait = wait;
          }
        }

        if (!Number.isFinite(minWait) || minWait === 0) {
          minWait = 500;
        }

        return { job: null, waitMs: minWait };
      };

      const getEmailForTenant = tenant => {
        const idx = tenantEmailIndex.get(tenant) ?? 0;
        tenantEmailIndex.set(tenant, idx + 1);
        return emails[idx % emails.length];
      };

      const workerLoop = async workerId => {
        const workerTag = `[Worker ${workerId + 1}]`;
        const slot = this.workerSlots[workerId];

        while (true) {
          if (this.cancelRequested) {
            console.log(`${workerTag} Queue cancel requested. Halting worker.`);
            if (slot) { slot.status = 'idle'; slot.jobKey = null; slot.step = null; }
            break;
          }

          if (slot) {
            slot.status = 'waiting';
            slot.step = 'Waiting for eligible job';
          }

          let eligible = getNextEligibleJob();
          while (!eligible.job && pendingJobs.length > 0) {
            if (this.cancelRequested) break;
            const sleepTime = Math.min(eligible.waitMs, 5000);
            await delay(sleepTime);
            eligible = getNextEligibleJob();
          }

          if (this.cancelRequested || !eligible.job) break;

          const currentJob = eligible.job;
          const { job_key, job_url, tenantHost, parsedUrl } = currentJob;
          const email = getEmailForTenant(tenantHost);

          if (slot) {
            slot.status = 'authenticating';
            slot.jobKey = job_key;
            slot.jobUrl = job_url;
            slot.email = email;
            slot.step = 'Authenticating with Oracle';
            slot.startedAt = new Date().toISOString();
          }

          scanStatus.jobs[job_key] = {
            job_key,
            job_url,
            status: 'in_progress',
            workerId: workerId + 1,
            email,
            startedAt: new Date().toISOString()
          };
          await updateStatusFile();

          const parsed = parsedUrl || { canonicalUrl: job_url, sourceJobId: job_key, tenantHost, tenantKey: '' };
          const jobData = {
            jobId: parsed.sourceJobId || job_key,
            jobKey: job_key,
            jobUrl: job_url,
            ...parsed
          };

          const releaseTenant = (customCooldown = null) => {
            activeTenants.delete(tenantHost);
            const cooldownTime = customCooldown !== null
              ? customCooldown
              : (jitterMinMs >= jitterMaxMs
                ? tenantCooldownBaseMs + jitterMinMs
                : tenantCooldownBaseMs + Math.floor(Math.random() * (jitterMaxMs - jitterMinMs + 1)) + jitterMinMs);

            tenantCooldowns.set(tenantHost, Date.now() + cooldownTime);
            if (slot) {
              slot.status = 'cooldown';
              slot.step = `Cooldown (${(cooldownTime / 1000).toFixed(0)}s)`;
              slot.cooldownUntil = Date.now() + cooldownTime;
            }
          };

          const executeScanAttempt = async attemptNumber => {
            console.log(`${workerTag} [${job_key}] Waiting for launch slot (${launchThrottleMs / 1000}s throttle)...`);
            if (slot) slot.step = 'Waiting for launch slot';
            await this.waitForLaunchSlot(launchThrottleMs);

            console.log(`${workerTag} [${job_key}] Launching browser session (Attempt ${attemptNumber}) on ${tenantHost} using ${email}...`);
            if (slot) {
              slot.status = 'authenticating';
              slot.step = `Logging in (Attempt ${attemptNumber})`;
            }
            const startTime = Date.now();

            const { session, result } = await this.phase1.authenticate({
              applicationId: `scan-${job_key}`,
              job: jobData,
              email
            });

            if (result?.status === 'skipped') {
              if (result?.reason === 'captcha_required') {
                const attempts = (jobAttemptCount.get(job_key) ?? 0) + 1;
                jobAttemptCount.set(job_key, attempts);

                if (attempts < 2) {
                  console.warn(`${workerTag} [${job_key}] ⚠ CAPTCHA encountered on ${tenantHost}. Applying 5-minute penalty cooldown and re-enqueuing for retry.`);
                  releaseTenant(captchaBackoffMs);
                  scanStatus.jobs[job_key] = {
                    job_key,
                    job_url,
                    status: 'retry_backoff',
                    reason: 'captcha_backoff',
                    workerId: workerId + 1,
                    attempt: attempts,
                    updatedAt: new Date().toISOString()
                  };
                  await updateStatusFile();
                  pendingJobs.push(currentJob);
                  return { handled: true };
                } else {
                  console.error(`${workerTag} [${job_key}] ✖ CAPTCHA persisted after backoff retry. Marking as skipped.`);
                  releaseTenant();
                  scanStatus.jobs[job_key] = {
                    job_key,
                    job_url,
                    status: 'skipped',
                    reason: 'captcha_required',
                    message: 'CAPTCHA persisted after backoff retry',
                    workerId: workerId + 1,
                    attempt: attempts,
                    durationMs: Date.now() - startTime,
                    completedAt: new Date().toISOString()
                  };
                  await updateStatusFile();
                  return { handled: true };
                }
              } else {
                console.log(`${workerTag} [${job_key}] ⚠ Skipped: ${result.reason} (${result.message})`);
                releaseTenant();
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
                return { handled: true };
              }
            }

            try {
              console.log(`${workerTag} [${job_key}] Walking and exploring form schema...`);
              if (slot) {
                slot.status = 'scanning';
                slot.step = 'Exploring form DOM';
              }
              const template = await this.phase2.scan({ session, job: jobData });
              const durationMs = Date.now() - startTime;

              console.log(`${workerTag} [${job_key}] ✓ Completed in ${(durationMs / 1000).toFixed(1)}s (${template.fields.length} fields, ${template.conditionalBranches.length} branches).`);

              // Persist template directly to SupabaseStore or JSON
              if (typeof this.store?.write === 'function') {
                try {
                  await this.store.write('form-templates', { [job_key]: template });
                } catch (err) {
                  console.warn(`[Scanner] Warning: Failed to persist template to Supabase: ${err.message}`);
                }
              }

              releaseTenant();
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

          // Execution with Retry-Once logic for transient errors
          try {
            const outcome = await executeScanAttempt(1);
            if (outcome?.handled || outcome?.completed) continue;
          } catch (error) {
            console.warn(`${workerTag} [${job_key}] ⚠ Attempt 1 failed: ${error.message}. Pausing before retry...`);
            const retryWait = tenantCooldownBaseMs > 0 ? Math.min(tenantCooldownBaseMs, 5000) : 5;
            await delay(retryWait);

            try {
              const retryOutcome = await executeScanAttempt(2);
              if (retryOutcome?.handled || retryOutcome?.completed) continue;
            } catch (retryError) {
              console.error(`${workerTag} [${job_key}] ✖ Failed attempt 2: ${retryError.message}`);
              releaseTenant();
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
        }

        if (slot) {
          slot.status = 'idle';
          slot.jobKey = null;
          slot.step = null;
        }
        console.log(`${workerTag} Finished all assigned tasks.`);
      };

      const workerCount = Math.min(concurrency, targetQueue.length || 1);
      await Promise.all(Array.from({ length: workerCount }, (_, idx) => workerLoop(idx)));

      await updateStatusFile();

      console.log(`\n========================================`);
      console.log(`Scanner Queue Finished!`);
      if (selector.hasFilter) {
        console.log(`Scope:     ${selector.description}`);
      }
      console.log(`Completed: ${scanStatus.summary.completed}`);
      console.log(`Skipped:   ${scanStatus.summary.skipped}`);
      console.log(`Failed:    ${scanStatus.summary.failed}`);
      console.log(`Saved to:  ${statusPath}`);
      console.log(`========================================\n`);

      return scanStatus;
    } finally {
      this.isScanning = false;
      this.cancelRequested = false;
      for (const slot of this.workerSlots) {
        slot.status = 'idle';
        slot.jobKey = null;
        slot.step = null;
      }
    }
  }
}
