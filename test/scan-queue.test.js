import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ScanQueueRunner } from '../src/phases/scan-queue.js';

test('ScanQueueRunner respects concurrency limit and assigns dedicated dummy accounts', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-scan-queue-'));
  const jobsCsvPath = path.join(tmpDir, 'jobs.csv');
  const statusPath = path.join(tmpDir, 'scan-status.json');

  const jobsData = `job_key,job_url
job_1,https://ebez.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions/preview/101
job_2,https://ebez.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions/preview/102
job_3,https://ebez.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions/preview/103
job_4,https://ebez.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions/preview/104
`;
  await fs.writeFile(jobsCsvPath, jobsData, 'utf8');

  let activeConcurrency = 0;
  let maxObservedConcurrency = 0;
  const emailsUsed = [];

  const mockOracle = {
    createSession: async () => ({ id: Math.random().toString() }),
    closeSession: async () => {}
  };

  const mockPhase1 = {
    authenticate: async ({ job, email }) => {
      activeConcurrency += 1;
      if (activeConcurrency > maxObservedConcurrency) {
        maxObservedConcurrency = activeConcurrency;
      }
      emailsUsed.push({ jobKey: job.jobKey, email });
      await new Promise(r => setTimeout(r, 20));
      return { session: { id: 'mock-session' }, result: { status: 'authenticated' } };
    }
  };

  const mockPhase2 = {
    scan: async ({ job }) => {
      await new Promise(r => setTimeout(r, 20));
      activeConcurrency -= 1;
      const tpl = {
        templateId: `tpl-${job.jobKey}`,
        jobKey: job.jobKey,
        jobUrl: job.jobUrl,
        fields: [{ id: 'f1', label: 'First Name' }],
        conditionalBranches: [],
        repeatableGroups: []
      };
      templatesStore[job.jobKey] = tpl;
      return tpl;
    }
  };

  const templatesStore = {};
  const mockStore = {
    read: async () => templatesStore,
    update: async (name, fallback, fn) => {
      const updated = fn(templatesStore);
      Object.assign(templatesStore, updated);
      return templatesStore;
    }
  };

  const runner = new ScanQueueRunner({
    store: mockStore,
    runLog: { append: async () => {} },
    oracle: mockOracle,
    phase1: mockPhase1,
    phase2: mockPhase2,
    config: {
      dataDir: tmpDir,
      jobsCleanCsvPath: jobsCsvPath,
      scanner: {
        concurrency: 3,
        launchThrottleMs: 0,
        cooldownMs: 5,
        emails: ['dummy1@test.com', 'dummy2@test.com', 'dummy3@test.com'],
        statusPath
      }
    }
  });

  const result = await runner.runQueue({
    jobsCsvPath,
    statusPath,
    concurrency: 3,
    launchThrottleMs: 0,
    cooldownMs: 5
  });

  assert.equal(result.summary.completed, 4);
  assert.equal(result.summary.failed, 0);
  assert.ok(maxObservedConcurrency <= 3, `Max concurrency ${maxObservedConcurrency} must not exceed 3`);

  // Verify templates stored under job_key
  assert.ok(templatesStore.job_1, 'Template should be keyed by job_1');
  assert.ok(templatesStore.job_2, 'Template should be keyed by job_2');
  assert.ok(templatesStore.job_3, 'Template should be keyed by job_3');
  assert.ok(templatesStore.job_4, 'Template should be keyed by job_4');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('ScanQueueRunner enforces global launch throttle across all workers', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-scan-throttle-'));
  const jobsCsvPath = path.join(tmpDir, 'jobs.csv');
  const statusPath = path.join(tmpDir, 'scan-status.json');

  const jobsData = `job_key,job_url
job_1,https://ebez.fa.us2.oraclecloud.com/job/1
job_2,https://ebez.fa.us2.oraclecloud.com/job/2
`;
  await fs.writeFile(jobsCsvPath, jobsData, 'utf8');

  const launchTimestamps = [];

  const mockPhase1 = {
    authenticate: async () => {
      launchTimestamps.push(Date.now());
      return { session: { id: 's' }, result: { status: 'authenticated' } };
    }
  };

  const mockPhase2 = {
    scan: async ({ job }) => ({
      templateId: `tpl-${job.jobKey}`,
      fields: [],
      conditionalBranches: [],
      repeatableGroups: []
    })
  };

  const runner = new ScanQueueRunner({
    store: { read: async () => ({}), update: async () => ({}) },
    runLog: { append: async () => {} },
    oracle: { createSession: async () => ({}), closeSession: async () => {} },
    phase1: mockPhase1,
    phase2: mockPhase2
  });

  const throttleMs = 60; // 60ms throttle for test
  await runner.runQueue({
    jobsCsvPath,
    statusPath,
    concurrency: 2,
    launchThrottleMs: throttleMs,
    cooldownMs: 0
  });

  assert.equal(launchTimestamps.length, 2);
  const gap = launchTimestamps[1] - launchTimestamps[0];
  assert.ok(gap >= throttleMs - 15, `Launch gap ${gap}ms should be >= throttleMs (${throttleMs}ms)`);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('ScanQueueRunner retries once on error before marking as failed', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-scan-retry-'));
  const jobsCsvPath = path.join(tmpDir, 'jobs.csv');
  const statusPath = path.join(tmpDir, 'scan-status.json');

  const jobsData = `job_key,job_url
job_flaky,https://ebez.fa.us2.oraclecloud.com/job/flaky
job_broken,https://ebez.fa.us2.oraclecloud.com/job/broken
`;
  await fs.writeFile(jobsCsvPath, jobsData, 'utf8');

  let flakyAttempts = 0;
  let brokenAttempts = 0;

  const mockPhase1 = {
    authenticate: async ({ job }) => {
      if (job.jobKey === 'job_flaky') {
        flakyAttempts += 1;
        if (flakyAttempts === 1) throw new Error('Temporary network glitch');
        return { session: { id: 'flaky-session' }, result: { status: 'authenticated' } };
      }
      if (job.jobKey === 'job_broken') {
        brokenAttempts += 1;
        throw new Error('Persistent failure');
      }
    }
  };

  const mockPhase2 = {
    scan: async ({ job }) => ({
      templateId: `tpl-${job.jobKey}`,
      fields: [],
      conditionalBranches: [],
      repeatableGroups: []
    })
  };

  const runner = new ScanQueueRunner({
    store: { read: async () => ({}), update: async () => ({}) },
    runLog: { append: async () => {} },
    oracle: { createSession: async () => ({}), closeSession: async () => {} },
    phase1: mockPhase1,
    phase2: mockPhase2
  });

  const result = await runner.runQueue({
    jobsCsvPath,
    statusPath,
    concurrency: 1,
    launchThrottleMs: 0,
    cooldownMs: 5
  });

  assert.equal(flakyAttempts, 2, 'Flaky job should be retried once and succeed');
  assert.equal(result.jobs.job_flaky.status, 'completed');

  assert.equal(brokenAttempts, 2, 'Broken job should be retried once and fail');
  assert.equal(result.jobs.job_broken.status, 'failed');
  assert.equal(result.jobs.job_broken.error, 'Persistent failure');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('ScanQueueRunner handles skip cases and honors --limit option', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-scan-skip-limit-'));
  const jobsCsvPath = path.join(tmpDir, 'jobs.csv');
  const statusPath = path.join(tmpDir, 'scan-status.json');

  const jobsData = `job_key,job_url
job_skip_1,https://ebez.fa.us2.oraclecloud.com/job/skip1
job_skip_2,https://ebez.fa.us2.oraclecloud.com/job/skip2
job_never_reached,https://ebez.fa.us2.oraclecloud.com/job/never
`;
  await fs.writeFile(jobsCsvPath, jobsData, 'utf8');

  const mockPhase1 = {
    authenticate: async ({ job }) => {
      if (job.jobKey === 'job_skip_1') {
        return { session: null, result: { status: 'skipped', reason: 'no_apply_button', message: 'No button' } };
      }
      return { session: null, result: { status: 'skipped', reason: 'already_applied', message: 'Already submitted' } };
    }
  };

  const runner = new ScanQueueRunner({
    store: { read: async () => ({}), update: async () => ({}) },
    runLog: { append: async () => {} },
    oracle: { createSession: async () => ({}), closeSession: async () => {} },
    phase1: mockPhase1,
    phase2: { scan: async () => {} }
  });

  const result = await runner.runQueue({
    jobsCsvPath,
    statusPath,
    limit: 2, // Limit to 2 jobs
    concurrency: 2,
    launchThrottleMs: 0,
    cooldownMs: 0
  });

  assert.equal(result.summary.skipped, 2);
  assert.equal(result.jobs.job_skip_1.status, 'skipped');
  assert.equal(result.jobs.job_skip_1.reason, 'no_apply_button');
  assert.equal(result.jobs.job_skip_2.status, 'skipped');
  assert.equal(result.jobs.job_skip_2.reason, 'already_applied');
  assert.equal(result.jobs.job_never_reached, undefined, 'job_never_reached should not have run due to limit: 2');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('Phase2ScanNormalize keys form-templates store solely by jobKey', async () => {
  const { Phase2ScanNormalize } = await import('../src/phases/phase2-scan-normalize.js');

  const templatesStore = {};
  const mockStore = {
    read: async () => templatesStore,
    update: async (name, fallback, fn) => {
      const updated = fn(templatesStore);
      Object.assign(templatesStore, updated);
      return templatesStore;
    }
  };

  const mockOracle = {
    scanForm: async () => ({
      fields: [{ id: 'fname', label: 'First Name', type: 'text' }],
      conditionalBranches: [],
      repeatableGroups: [],
      scan: { submitPresent: false, scannedAt: '2026-11-05T09:00:00Z' }
    })
  };

  const phase2 = new Phase2ScanNormalize({
    store: mockStore,
    runLog: { append: async () => {} },
    oracle: mockOracle
  });

  const job = {
    jobKey: 'job_42',
    jobId: '99999',
    jobUrl: 'https://test.oraclecloud.com/job/99999',
    canonicalUrl: 'https://test.oraclecloud.com/job/99999'
  };

  const result = await phase2.scan({ session: {}, job });

  assert.equal(result.jobKey, 'job_42');
  assert.equal(result.jobUrl, 'https://test.oraclecloud.com/job/99999');
  assert.ok(templatesStore.job_42, 'Store must be keyed by job_42');
  assert.equal(templatesStore['99999'], undefined, 'Store must NOT be keyed by raw numeric jobId');
});

