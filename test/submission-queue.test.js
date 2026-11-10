import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { SubmissionQueueRunner } from '../src/phases/submission-queue.js';
import { ResumeService } from '../src/services/resume-service.js';
import { Phase4ApplyReviewSubmit } from '../src/phases/phase4-apply-review-submit.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function createMockPage(initialUrl = 'https://oracle.cloud/apply/section/2') {
  let url = initialUrl;
  let closed = false;
  const emitter = new EventEmitter();

  return {
    url: () => url,
    setUrl: (newUrl) => { url = newUrl; },
    isClosed: () => closed,
    close: async () => {
      closed = true;
      emitter.emit('close');
    },
    on: (evt, cb) => emitter.on(evt, cb),
    once: (evt, cb) => emitter.once(evt, cb),
    screenshot: async ({ path: p }) => {
      await fs.writeFile(p, 'fake-png-screenshot-content');
      return Buffer.from('fake');
    },
    waitForLoadState: async () => {}
  };
}

test('ResumeService downloads and caches candidate resume or uses fallback', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-test-'));
  const fallbackPath = path.join(tempDir, 'dummy.pdf');
  await fs.writeFile(fallbackPath, 'dummy-pdf-content');

  const service = new ResumeService({
    cacheDir: tempDir,
    fallbackResumePath: fallbackPath
  });

  const client = {
    additional_information: {
      resume_url: null,
      resume_path: null
    }
  };

  const cached = await service.resolveCandidateResume(client, 'AWL-999');
  assert.ok(cached.endsWith('AWL-999_resume.pdf'));
  const exists = await fs.stat(cached);
  assert.ok(exists.size > 0);

  // Second call should return cached without error
  const cachedSecond = await service.resolveCandidateResume(client, 'AWL-999');
  assert.equal(cachedSecond, cached);

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

test('waitForLaunchSlot enforces launch throttle timing', async () => {
  const runner = new SubmissionQueueRunner({
    store: {},
    runLog: { append: async () => {} },
    oracle: {},
    phase1: {},
    phase4: {},
    sessions: new Map(),
    config: { submission: { concurrency: 3, launchThrottleMs: 60 } }
  });

  const t1 = Date.now();
  await runner.waitForLaunchSlot(60);
  const t2 = Date.now();
  await runner.waitForLaunchSlot(60);
  const t3 = Date.now();

  assert.ok(t3 - t2 >= 50, `Expected throttle wait >= 50ms, got ${t3 - t2}ms`);
});

test('enforces max 3 concurrent live workers and enqueues 4th', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-queue-test-'));
  const submitDir = path.join(tempDir, 'submit');
  await fs.mkdir(submitDir, { recursive: true });

  const applications = [
    { applicationId: 'app-1', userId: 'AWL-1', jobId: 'job-1', jobKey: 'job-1', status: 'answers_resolved' },
    { applicationId: 'app-2', userId: 'AWL-2', jobId: 'job-2', jobKey: 'job-2', status: 'answers_resolved' },
    { applicationId: 'app-3', userId: 'AWL-3', jobId: 'job-3', jobKey: 'job-3', status: 'answers_resolved' },
    { applicationId: 'app-4', userId: 'AWL-4', jobId: 'job-4', jobKey: 'job-4', status: 'answers_resolved' }
  ];

  const store = {
    async read(name) {
      if (name === 'applications') return applications;
      return {};
    },
    async update(name, fallback, updater) {
      return updater(applications);
    }
  };

  const sessions = new Map();
  const mockPages = {};

  const phase4 = {
    async prepare(appId) {
      const page = createMockPage();
      mockPages[appId] = page;
      sessions.set(appId, { page });
      return { status: 'needs_review' };
    }
  };

  const runner = new SubmissionQueueRunner({
    store,
    runLog: { append: async () => {} },
    oracle: {
      clickSubmit: async () => ({ status: 'clicked' }),
      closeSession: async (sess) => { if (sess?.page) await sess.page.close(); }
    },
    phase1: {},
    phase4,
    sessions,
    config: {
      clientsPath: path.join(tempDir, 'nonexistent-clients.json'),
      submission: {
        concurrency: 3,
        launchThrottleMs: 0,
        cooldownMs: 100,
        submitWaitMs: 50,
        submitDir
      }
    }
  });

  // Enqueue 4 applications
  await runner.enqueueApplication('app-1');
  await runner.enqueueApplication('app-2');
  await runner.enqueueApplication('app-3');
  await runner.enqueueApplication('app-4');

  // Let worker event loop ticks run
  await delay(120);

  const status = runner.getStatus();
  assert.equal(status.concurrency, 3);
  assert.equal(status.slots.filter(s => s.status === 'awaiting_review').length, 3);
  assert.equal(status.pendingQueueLength, 1);
  assert.equal(status.pendingQueue[0], 'app-4');

  // Submit app-1 via Dashboard trigger
  const submitResult = await runner.submitApplication('app-1', 'job-1');
  assert.equal(submitResult.status, 'submitted');
  assert.ok(submitResult.receipt.screenshotPath.includes('AWL-1_job-1_receipt.png'));

  // Cooldown delay allows Slot 1 to finish cooldown and pick up app-4
  await delay(150);

  const updatedStatus = runner.getStatus();
  assert.equal(updatedStatus.pendingQueueLength, 0, 'app-4 should have been dequeued');
  const activeApps = updatedStatus.slots.map(s => s.applicationId);
  assert.ok(activeApps.includes('app-4'), 'app-4 should now be assigned to an active slot');

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

test('handles manual on-site submit detection and receipt capture', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-submit-test-'));
  const submitDir = path.join(tempDir, 'submit');
  await fs.mkdir(submitDir, { recursive: true });

  const applications = [
    { applicationId: 'app-site', userId: 'AWL-SITE', jobId: 'job-site', jobKey: 'job-site', status: 'answers_resolved' }
  ];

  let appStore = [...applications];
  const store = {
    async read(name) {
      if (name === 'applications') return appStore;
      return {};
    },
    async update(name, fallback, updater) {
      appStore = updater(appStore);
      return appStore;
    }
  };

  const page = createMockPage();
  const sessions = new Map();

  const phase4 = {
    async prepare(appId) {
      sessions.set(appId, { page });
      return { status: 'needs_review' };
    }
  };

  const runner = new SubmissionQueueRunner({
    store,
    runLog: { append: async () => {} },
    oracle: {
      clickSubmit: async () => {},
      closeSession: async (sess) => { if (sess?.page) await sess.page.close(); }
    },
    phase1: {},
    phase4,
    sessions,
    config: {
      clientsPath: path.join(tempDir, 'clients.json'),
      submission: {
        concurrency: 3,
        launchThrottleMs: 0,
        cooldownMs: 80,
        submitWaitMs: 40,
        submitDir
      }
    }
  });

  await runner.enqueueApplication('app-site');
  await delay(50);

  const slot = runner.slots.find(s => s.applicationId === 'app-site');
  assert.equal(slot.status, 'awaiting_review');

  // Simulate operator clicking submit on site (navigates to confirmation page)
  page.setUrl('https://oracle.cloud/apply/confirmation?reqId=job-site');

  // Allow live page observer interval to detect the submission
  await delay(1800);

  const finishedApp = appStore.find(a => a.applicationId === 'app-site');
  assert.equal(finishedApp.status, 'submitted');
  assert.equal(finishedApp.receipt.source, 'site_manual');
  assert.ok(finishedApp.receipt.screenshotPath.includes('AWL-SITE_job-site_receipt.png'));

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

test('frees worker slot when operator manually closes browser window', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'close-window-test-'));
  const applications = [
    { applicationId: 'app-close', userId: 'AWL-CLOSE', jobId: 'job-c', jobKey: 'job-c', status: 'answers_resolved' }
  ];

  const store = {
    async read(name) { return name === 'applications' ? applications : {}; },
    async update(name, fallback, updater) { return updater(applications); }
  };

  const page = createMockPage();
  const sessions = new Map();

  const phase4 = {
    async prepare(appId) {
      sessions.set(appId, { page });
      return { status: 'needs_review' };
    }
  };

  const runner = new SubmissionQueueRunner({
    store,
    runLog: { append: async () => {} },
    oracle: { closeSession: async () => {} },
    phase1: {},
    phase4,
    sessions,
    config: {
      clientsPath: path.join(tempDir, 'clients.json'),
      submission: { concurrency: 3, launchThrottleMs: 0, cooldownMs: 50, submitWaitMs: 30 }
    }
  });

  await runner.enqueueApplication('app-close');
  await delay(50);

  const slot = runner.slots.find(s => s.applicationId === 'app-close');
  assert.equal(slot.status, 'awaiting_review');

  // Operator physically closes Chromium window
  await page.close();

  // Cooldown delay completes
  await delay(100);

  assert.equal(slot.status, 'idle', 'Slot should return to idle after window close and cooldown');
  assert.equal(slot.applicationId, null);

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

test('dry-run mode auto-closes session, captures audit proofs, and transitions to cooldown without submitting', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dry-run-test-'));
  const applications = [
    { applicationId: 'app-dry-1', userId: 'AWL-DRY1', jobId: 'job-d1', jobKey: 'job-d1', status: 'answers_resolved' },
    { applicationId: 'app-dry-2', userId: 'AWL-DRY2', jobId: 'job-d2', jobKey: 'job-d2', status: 'answers_resolved' }
  ];

  let appStore = [...applications];
  const store = {
    async read(name) { return name === 'applications' ? appStore : {}; },
    async update(name, fallback, updater) {
      appStore = updater(appStore);
      return appStore;
    }
  };

  const sessions = new Map();
  let closedSessionsCount = 0;

  const phase4 = {
    async prepare(appId) {
      const page = createMockPage();
      sessions.set(appId, { page });
      return {
        status: 'filled_verified',
        reviewStatus: 'audited',
        screenshots: [
          { pageNumber: 1, step: 'before_next', filename: 'page_1_before_next.png' },
          { pageNumber: 2, step: 'final_submit', filename: 'page_2_final_submit.png' }
        ]
      };
    }
  };

  const runner = new SubmissionQueueRunner({
    store,
    runLog: { append: async () => {} },
    oracle: {
      closeSession: async () => { closedSessionsCount++; }
    },
    phase1: {},
    phase4,
    sessions,
    config: {
      clientsPath: path.join(tempDir, 'clients.json'),
      submission: {
        concurrency: 1,
        launchThrottleMs: 0,
        cooldownMs: 80,
        submitWaitMs: 30,
        dryRun: true // Explicitly enable dry run
      }
    }
  });

  // Enqueue both applications
  await runner.enqueueApplication('app-dry-1');
  await runner.enqueueApplication('app-dry-2');

  // Let worker process app-dry-1
  await delay(40);

  // During or right after prepare, slot transitions to cooldown (never stalls in awaiting_review)
  const slot = runner.slots[0];
  assert.notEqual(slot.status, 'awaiting_review', 'Slot must NOT stall in awaiting_review in dryRun mode');
  assert.equal(closedSessionsCount, 1, 'First session should have been closed automatically');

  // After cooldown finishes, Slot 1 automatically picks up app-dry-2
  await delay(120);

  assert.equal(closedSessionsCount, 2, 'Second queued session should be auto-processed and closed');
  assert.equal(runner.pendingQueue.length, 0, 'Queue should be empty');

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});
