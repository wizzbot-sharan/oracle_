import test from 'node:test';
import assert from 'node:assert/strict';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';
import { Phase1IngestAuth } from '../src/phases/phase1-ingest-auth.js';
import { Phase4ApplyReviewSubmit } from '../src/phases/phase4-apply-review-submit.js';

test('adapter.authenticate skips with NO_APPLY_BUTTON when no apply button is visible', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 },
    initialWait: 0
  });

  const mockPage = {
    url: () => 'https://test.oraclecloud.com/job/12345',
    goto: async () => {},
    waitForLoadState: async () => {},
    locator: () => {
      const loc = {
        count: async () => 0,
        waitFor: async () => { throw new Error('Timeout waiting for visible'); },
        first: () => loc
      };
      return loc;
    }
  };

  const job = { jobId: '12345', canonicalUrl: 'https://test.oraclecloud.com/job/12345', tenantHost: 'test.oraclecloud.com' };
  const result = await adapter.authenticate({ session: { page: mockPage }, job, email: 'test@example.com' });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'NO_APPLY_BUTTON');
});

test('adapter.authenticate skips with ALREADY_APPLIED when job page indicates candidate already applied', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 },
    initialWait: 0
  });

  const mockPage = {
    url: () => 'https://test.oraclecloud.com/job/12345',
    goto: async () => {},
    waitForLoadState: async () => {},
    locator: (selector) => {
      if (selector.includes('applied to this job') || selector.includes('already applied')) {
        const loc = {
          count: async () => 1,
          first: () => loc
        };
        return loc;
      }
      const loc = {
        count: async () => 0,
        waitFor: async () => { throw new Error('Timeout waiting for visible'); },
        first: () => loc
      };
      return loc;
    }
  };

  const job = { jobId: '12345', canonicalUrl: 'https://test.oraclecloud.com/job/12345', tenantHost: 'test.oraclecloud.com' };
  const result = await adapter.authenticate({ session: { page: mockPage }, job, email: 'test@example.com' });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'ALREADY_APPLIED');
});

test('adapter.authenticate skips with ALREADY_APPLIED when post-login page shows applied to this job', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 },
    initialWait: 0
  });

  let onEntryScreen = false;
  let postLoginReached = false;

  const makeMockLocator = (props = {}) => {
    const loc = {
      count: async () => 0,
      waitFor: async () => {},
      scrollIntoViewIfNeeded: async () => {},
      click: async () => {},
      fill: async () => {},
      pressSequentially: async () => {},
      isChecked: async () => false,
      first: () => loc,
      last: () => loc,
      ...props
    };
    return loc;
  };

  const mockApplyButton = makeMockLocator({
    count: async () => 1,
    click: async () => { onEntryScreen = true; }
  });

  const mockEmailInput = makeMockLocator({
    count: async () => (onEntryScreen ? 1 : 0)
  });

  const mockNextButton = makeMockLocator({
    count: async () => (onEntryScreen ? 1 : 0),
    click: async () => { postLoginReached = true; }
  });

  const mockAppliedText = makeMockLocator({
    count: async () => (postLoginReached ? 1 : 0)
  });

  const mockPage = {
    url: () => (postLoginReached ? 'https://test.oraclecloud.com/apply/section/1' : 'https://test.oraclecloud.com/job/12345'),
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForURL: async () => {},
    getByRole: () => ({
      or: () => ({
        first: () => makeMockLocator()
      })
    }),
    locator: (selector) => {
      if (selector.includes('Apply Now') || selector.includes('Apply')) {
        return mockApplyButton;
      }
      if (selector.includes('primary-email') || selector.includes('email')) {
        return mockEmailInput;
      }
      if (selector.includes('apply-flow-pagination__button') || selector.includes('Next')) {
        return mockNextButton;
      }
      if (selector.includes('applied to this job') || selector.includes('already applied')) {
        return mockAppliedText;
      }
      return makeMockLocator();
    }
  };

  const job = { jobId: '12345', canonicalUrl: 'https://test.oraclecloud.com/job/12345', tenantHost: 'test.oraclecloud.com' };
  const result = await adapter.authenticate({ session: { page: mockPage }, job, email: 'test@example.com' });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'ALREADY_APPLIED');
});

test('Phase1IngestAuth logs phase1.skipped and closes session when adapter returns skipped', async () => {
  let sessionClosed = false;
  const loggedEvents = [];

  const mockOracle = {
    createSession: async () => ({ id: 'mock-session' }),
    closeSession: async () => { sessionClosed = true; },
    authenticate: async () => ({
      status: 'skipped',
      reason: 'ALREADY_APPLIED',
      message: 'Candidate has already applied to this job'
    })
  };

  const mockRunLog = {
    append: async (event, payload) => {
      loggedEvents.push({ event, payload });
    }
  };

  const mockLock = {
    run: async (_key, fn) => fn()
  };

  const phase1 = new Phase1IngestAuth({
    store: {},
    runLog: mockRunLog,
    oracle: mockOracle,
    mailReader: {},
    otpLock: mockLock
  });

  const job = { jobId: '12345', canonicalUrl: 'https://test.oraclecloud.com/job/12345', tenantHost: 'test.oraclecloud.com' };
  const { session, result } = await phase1.authenticate({
    applicationId: 'app-test',
    job,
    email: 'test@example.com'
  });

  assert.equal(session, null);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'ALREADY_APPLIED');
  assert.equal(sessionClosed, true);
  assert.equal(loggedEvents.some(e => e.event === 'phase1.skipped' && e.payload.reason === 'ALREADY_APPLIED'), true);
});

test('Phase 4 prepare marks application as already_applied when phase1 returns skipped', async () => {
  let patchedApp = null;
  const store = {
    async read(name) {
      if (name === 'applications') {
        return [{
          applicationId: 'app-1',
          jobId: '123',
          userId: 'user-1',
          canonicalUrl: 'https://test.com',
          tenantHost: 'test.com',
          values: {}
        }];
      }
      if (name === 'users') {
        return { 'user-1': { email: 'user@example.com' } };
      }
      if (name === 'form-templates') {
        return { '123': { fields: [] } };
      }
      return {};
    },
    async update(name, fallback, updater) {
      const apps = [{
        applicationId: 'app-1',
        jobId: '123',
        userId: 'user-1',
        canonicalUrl: 'https://test.com',
        tenantHost: 'test.com',
        values: {}
      }];
      await updater(apps);
      patchedApp = apps[0];
    }
  };

  const logged = [];
  const phase4 = new Phase4ApplyReviewSubmit({
    store,
    runLog: { append: async (evt, payload) => logged.push({ evt, payload }) },
    oracle: { closeSession: async () => {} },
    phase1: {
      authenticate: async () => ({
        session: null,
        result: { status: 'skipped', reason: 'ALREADY_APPLIED', message: 'Candidate has already applied' }
      })
    },
    sessions: new Map()
  });

  const updated = await phase4.prepare('app-1');
  assert.equal(updated.status, 'already_applied');
  assert.equal(updated.reviewStatus, 'skipped');
  assert.equal(updated.skipReason, 'ALREADY_APPLIED');
  assert.equal(logged.some(e => e.evt === 'phase4.skipped'), true);
});
