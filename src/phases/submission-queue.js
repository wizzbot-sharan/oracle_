import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { invariant } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import { resumeService as defaultResumeService } from '../services/resume-service.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class SubmissionQueueRunner {
  constructor({ store, runLog, oracle, phase1, phase4, sessions, resumeService, config: customConfig }) {
    this.store = store;
    this.runLog = runLog;
    this.oracle = oracle;
    this.phase1 = phase1;
    this.phase4 = phase4;
    this.sessions = sessions;
    this.resumeService = resumeService ?? defaultResumeService;
    this.config = customConfig ?? config;

    this.concurrency = this.config.submission?.concurrency ?? config.submission?.concurrency ?? 3;
    this.launchThrottleMs = this.config.submission?.launchThrottleMs ?? config.submission?.launchThrottleMs ?? 30000;
    this.cooldownMs = this.config.submission?.cooldownMs ?? config.submission?.cooldownMs ?? 10000;
    this.submitWaitMs = this.config.submission?.submitWaitMs ?? config.submission?.submitWaitMs ?? 10000;
    this.submitDir = this.config.submission?.submitDir ?? (this.config.dataDir ? path.resolve(this.config.dataDir, 'submit') : config.submission?.submitDir);
    this.dryRun = this.config.submission?.dryRun ?? false;

    this.lastLaunchTime = 0;
    this.launchLock = Promise.resolve();

    this.slots = Array.from({ length: this.concurrency }, (_, idx) => ({
      slotId: idx + 1,
      status: 'idle', // 'idle' | 'launching' | 'filling' | 'awaiting_review' | 'submitting' | 'cooldown'
      applicationId: null,
      applywizzId: null,
      jobKey: null,
      clientName: null,
      startedAt: null,
      cooldownUntil: null,
      session: null,
      error: null
    }));

    this.pendingQueue = [];
    this.activeSubmissions = new Set();
  }

  async #loadClients() {
    try {
      const raw = await fs.readFile(this.config.clientsPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  async waitForLaunchSlot(throttleMs = this.launchThrottleMs) {
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
        console.log(`[SubmissionQueue] Global launch throttle: waiting ${(waitMs / 1000).toFixed(1)}s before launching browser...`);
        await delay(waitMs);
      }
      this.lastLaunchTime = Date.now();
    } finally {
      release();
    }
  }

  getStatus() {
    const now = Date.now();
    // Refresh any expired cooldowns
    for (const slot of this.slots) {
      if (slot.status === 'cooldown' && slot.cooldownUntil && now >= slot.cooldownUntil) {
        slot.status = 'idle';
        slot.applicationId = null;
        slot.applywizzId = null;
        slot.jobKey = null;
        slot.clientName = null;
        slot.session = null;
        slot.cooldownUntil = null;
      }
    }

    const sanitizedSlots = this.slots.map(s => ({
      slotId: s.slotId,
      status: s.status,
      applicationId: s.applicationId,
      applywizzId: s.applywizzId,
      jobKey: s.jobKey,
      clientName: s.clientName,
      startedAt: s.startedAt,
      cooldownRemainingMs: s.cooldownUntil ? Math.max(0, s.cooldownUntil - now) : 0,
      error: s.error
    }));

    return {
      concurrency: this.concurrency,
      activeCount: sanitizedSlots.filter(s => s.status !== 'idle').length,
      pendingQueueLength: this.pendingQueue.length,
      pendingQueue: [...this.pendingQueue],
      slots: sanitizedSlots
    };
  }

  async enqueueApplication(applicationId) {
    invariant(applicationId, 'APPLICATION_ID_REQUIRED', 'Application ID is required');

    // Check if already in active slot or queue
    const activeSlot = this.slots.find(s => s.applicationId === applicationId && s.status !== 'idle' && s.status !== 'cooldown');
    if (activeSlot) {
      return {
        enqueued: false,
        alreadyActive: true,
        slotId: activeSlot.slotId,
        status: activeSlot.status,
        applicationId
      };
    }

    if (this.pendingQueue.includes(applicationId)) {
      return {
        enqueued: false,
        alreadyQueued: true,
        queuePosition: this.pendingQueue.indexOf(applicationId) + 1,
        applicationId
      };
    }

    // Verify application exists
    const applications = await this.store.read('applications', []);
    const app = applications.find(item => item.applicationId === applicationId);
    invariant(app, 'APPLICATION_NOT_FOUND', `Application ${applicationId} not found`);

    this.pendingQueue.push(applicationId);
    console.log(`[SubmissionQueue] Enqueued ${applicationId}. Queue length: ${this.pendingQueue.length}`);

    // Trigger dispatch asynchronously
    setImmediate(() => this.dispatchNext().catch(err => console.error('[SubmissionQueue] Dispatch error:', err)));

    return {
      enqueued: true,
      queuePosition: this.pendingQueue.length,
      applicationId
    };
  }

  async dispatchNext() {
    this.getStatus(); // refresh cooldowns

    if (this.pendingQueue.length === 0) return;

    // Find first idle slot
    const idleSlot = this.slots.find(s => s.status === 'idle');
    if (!idleSlot) {
      console.log(`[SubmissionQueue] All ${this.concurrency} slots are currently busy or in cooldown. Waiting for next slot to free...`);
      return;
    }

    const nextApplicationId = this.pendingQueue.shift();
    if (!nextApplicationId) return;

    // Launch worker asynchronously
    this.#runWorker(idleSlot, nextApplicationId).catch(err => {
      console.error(`[SubmissionQueue] Worker in Slot ${idleSlot.slotId} encountered fatal error for ${nextApplicationId}:`, err);
    });
  }

  async #runWorker(slot, applicationId) {
    slot.status = 'launching';
    slot.applicationId = applicationId;
    slot.startedAt = nowIso();
    slot.error = null;

    try {
      const applications = await this.store.read('applications', []);
      const application = applications.find(item => item.applicationId === applicationId);
      if (!application) {
        throw new Error(`Application ${applicationId} not found`);
      }

      const clients = await this.#loadClients();
      const applywizzId = application.applywizzId || application.userId;
      const client = clients[applywizzId] || clients[application.userId];

      slot.applywizzId = applywizzId;
      slot.jobKey = application.jobKey || application.jobId;
      slot.clientName = application.clientName || client?.client?.full_name || applywizzId;

      console.log(`\n=== [Submission Worker Slot ${slot.slotId}] Starting live fill for ${applywizzId} (Job: ${slot.jobKey}) ===`);

      // 1. Wait for global launch throttle (30s)
      await this.waitForLaunchSlot(this.launchThrottleMs);

      // 2. Prepare & Fill multi-pass
      slot.status = 'filling';
      const updatedApp = await this.phase4.prepare(applicationId);

      // If skipped or failed
      if (updatedApp.status === 'skipped' || updatedApp.status === 'already_applied') {
        console.log(`[Submission Worker Slot ${slot.slotId}] Application was skipped: ${updatedApp.skipReason}`);
        await this.#cooldownSlot(slot);
        return;
      }

      if (updatedApp.status === 'fill_failed') {
        slot.error = 'Form filling encountered errors';
        console.warn(`[Submission Worker Slot ${slot.slotId}] Form filling had failures; halting for operator inspection.`);
      }

      // Dry-Run Visual Audit Mode: Do not click Submit. Auto-close browser cleanly to free worker slot for queued applications.
      if (this.dryRun) {
        console.log(`[Submission Worker Slot ${slot.slotId}] Dry-Run Audit Mode: All pages filled and visual audit screenshots captured. Auto-closing session without submitting.`);
        const session = this.sessions.get(applicationId);
        if (session) {
          await this.oracle.closeSession(session).catch(() => {});
          this.sessions.delete(applicationId);
        }
        slot.session = null;
        await this.#cooldownSlot(slot);
        return;
      }

      // 3. Safety Gate Reached: Halt at final page before submit
      slot.status = 'awaiting_review';
      const session = this.sessions.get(applicationId);
      slot.session = session;

      console.log(`[Submission Worker Slot ${slot.slotId}] Strict Safety Gate: Live session halted at review step. Awaiting operator confirmation.`);

      // 4. Attach listeners on live page for manual submit or window close
      if (session?.page) {
        this.#attachLivePageObservers(slot, applicationId, session);
      }
    } catch (error) {
      console.error(`[Submission Worker Slot ${slot.slotId}] Error during fill: ${error.message}`);
      slot.error = error.message;
      await this.#cooldownSlot(slot);
    }
  }

  #attachLivePageObservers(slot, applicationId, session) {
    const { page } = session;
    if (!page || page.isClosed?.()) return;

    // Handle operator manually closing the browser window
    page.once('close', () => {
      if (slot.applicationId === applicationId && slot.status === 'awaiting_review') {
        console.log(`[Submission Worker Slot ${slot.slotId}] Operator closed the browser window manually for ${applicationId}. Freeing slot.`);
        this.sessions.delete(applicationId);
        this.#cooldownSlot(slot).catch(() => {});
      }
    });

    // Handle operator clicking submit directly on the site
    const checkInterval = setInterval(async () => {
      if (slot.applicationId !== applicationId || slot.status !== 'awaiting_review') {
        clearInterval(checkInterval);
        return;
      }
      if (page.isClosed?.()) {
        clearInterval(checkInterval);
        return;
      }

      try {
        const currentUrl = page.url();
        const isSubmittedUrl = /confirmation|thankyou|success|submitted|status/i.test(currentUrl);

        if (isSubmittedUrl && !this.activeSubmissions.has(applicationId)) {
          clearInterval(checkInterval);
          console.log(`[Submission Worker Slot ${slot.slotId}] Detected operator clicked Submit directly on site! (URL: ${currentUrl})`);
          await this.finalizeSubmission(slot, applicationId, 'site_manual');
        }
      } catch {
        // Page might be navigating or closed
      }
    }, 1500);

    if (checkInterval.unref) checkInterval.unref();
    slot.checkInterval = checkInterval;
  }

  async submitApplication(applicationId, confirmation) {
    invariant(applicationId, 'APPLICATION_ID_REQUIRED', 'Application ID is required');

    const slot = this.slots.find(s => s.applicationId === applicationId);
    const session = this.sessions.get(applicationId);

    invariant(session, 'SESSION_EXPIRED', `No active live browser session found for application ${applicationId}`);

    const applications = await this.store.read('applications', []);
    const application = applications.find(item => item.applicationId === applicationId);
    invariant(application, 'APPLICATION_NOT_FOUND', `Application ${applicationId} not found`);

    const expectedConfirm = application.jobKey || application.jobId;
    invariant(
      confirmation === expectedConfirm || confirmation === application.jobId,
      'SUBMIT_CONFIRMATION_MISMATCH',
      `Type the exact job ID (${expectedConfirm}) to confirm submission`
    );

    return await this.finalizeSubmission(slot, applicationId, 'dashboard');
  }

  async finalizeSubmission(slot, applicationId, source = 'dashboard') {
    if (this.activeSubmissions.has(applicationId)) {
      return { status: 'already_submitting' };
    }
    this.activeSubmissions.add(applicationId);

    const targetSlot = slot || this.slots.find(s => s.applicationId === applicationId);
    if (targetSlot) targetSlot.status = 'submitting';

    const session = this.sessions.get(applicationId);
    invariant(session, 'SESSION_MISSING', 'Live browser session not found');

    const applications = await this.store.read('applications', []);
    const application = applications.find(item => item.applicationId === applicationId);

    console.log(`\n=== [Submission Finalizer] Finalizing submission for ${applicationId} (Source: ${source}) ===`);

    try {
      // 1. If dashboard source, click submit programmatically via Playwright
      if (source === 'dashboard') {
        console.log(`[Submission Finalizer] Clicking submit button via Playwright...`);
        await this.oracle.clickSubmit({ session }).catch(err => {
          console.warn(`[Submission Finalizer] clickSubmit note: ${err.message}`);
        });
      }

      // 2. Wait 10 seconds post-submit on site
      console.log(`[Submission Finalizer] Waiting ${this.submitWaitMs / 1000}s post-submit settlement on site...`);
      await delay(this.submitWaitMs);

      // 3. Capture full-page receipt screenshot
      await fs.mkdir(this.submitDir, { recursive: true });
      const applywizzId = application?.applywizzId || application?.userId || 'candidate';
      const jobKey = application?.jobKey || application?.jobId || 'job';
      const receiptFilename = `${applywizzId}_${jobKey}_receipt.png`;
      const receiptPath = path.resolve(this.submitDir, receiptFilename);

      if (session.page && !session.page.isClosed?.()) {
        await session.page.screenshot({ path: receiptPath, fullPage: true }).catch(err => {
          console.warn(`[Submission Finalizer] Screenshot warning: ${err.message}`);
        });
        console.log(`[Submission Finalizer] ✓ Saved receipt screenshot to ${receiptPath}`);
      }

      // 4. Update applications.json
      const receipt = {
        source,
        screenshotPath: receiptPath,
        filename: receiptFilename,
        submittedAt: nowIso(),
        url: session.page?.isClosed?.() ? null : session.page.url()
      };

      await this.store.update('applications', [], apps => apps.map(app => {
        if (app.applicationId !== applicationId) return app;
        return {
          ...app,
          status: 'submitted',
          reviewStatus: 'submitted',
          receipt,
          updatedAt: nowIso()
        };
      }));

      await this.runLog.append('phase4.submitted', { applicationId, source, receiptFilename });

      // 5. Close session
      await this.oracle.closeSession(session).catch(() => {});
      this.sessions.delete(applicationId);

      // 6. Enter 10-second cooldown for this worker slot
      if (targetSlot) {
        await this.#cooldownSlot(targetSlot);
      }

      return {
        success: true,
        applicationId,
        status: 'submitted',
        receipt
      };
    } finally {
      this.activeSubmissions.delete(applicationId);
    }
  }

  async #cooldownSlot(slot) {
    if (slot.checkInterval) {
      clearInterval(slot.checkInterval);
      slot.checkInterval = null;
    }
    slot.status = 'cooldown';
    slot.session = null;
    slot.cooldownUntil = Date.now() + this.cooldownMs;

    console.log(`[Submission Worker Slot ${slot.slotId}] Starting ${this.cooldownMs / 1000}s worker cooldown...`);
    await delay(this.cooldownMs);

    slot.status = 'idle';
    slot.applicationId = null;
    slot.applywizzId = null;
    slot.jobKey = null;
    slot.clientName = null;
    slot.cooldownUntil = null;
    slot.error = null;

    console.log(`[Submission Worker Slot ${slot.slotId}] Cooldown completed. Slot is now idle.`);
    // Trigger dispatch for next pending item
    setImmediate(() => this.dispatchNext().catch(err => console.error('[SubmissionQueue] Post-cooldown dispatch error:', err)));
  }
}
