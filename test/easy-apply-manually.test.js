import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';

test('authenticate detects /easy-apply and clicks manually link', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 },
    initialWait: 0,
    runtimeDir: path.join(os.tmpdir(), 'oracle-test-' + Date.now())
  });

  let currentUrl = 'https://test.oraclecloud.com/job/13095';
  let manualClicked = false;

  const mockLocator = (selector) => {
    const loc = {
      count: async () => {
        if (selector.includes('manually')) return 1;
        if (selector.includes('Apply Now') || selector.includes('Apply')) return 1;
        if (selector.includes('Next')) return 1;
        if (selector.includes('email')) return 1;
        return 0;
      },
      first: () => loc,
      nth: () => loc,
      or: () => loc,
      waitFor: async () => {},
      scrollIntoViewIfNeeded: async () => {},
      click: async () => {
        if (selector.includes('manually')) {
          manualClicked = true;
          currentUrl = 'https://test.oraclecloud.com/job/13095/apply/section/1';
        } else if (selector.includes('Apply Now') || selector.includes('Apply')) {
          currentUrl = 'https://test.oraclecloud.com/job/13095/apply/email';
        } else if (selector.includes('Next')) {
          currentUrl = 'https://test.oraclecloud.com/job/13095/easy-apply';
        }
      },
      isVisible: async () => {
        if (selector.includes('manually')) return true;
        if (selector.includes('applied to this job')) return false;
        if (selector.includes('email')) return true;
        return false;
      },
      fill: async () => {},
      pressSequentially: async () => {},
      innerText: async () => '',
      isChecked: async () => false,
      evaluate: async () => ({})
    };
    return loc;
  };

  const mockPage = {
    url: () => currentUrl,
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForURL: async () => {},
    evaluate: async () => ({ groups: [], handledCheckboxIds: [] }),
    locator: mockLocator,
    getByRole: (role, opts) => mockLocator(String(opts?.name ?? ''))
  };

  const job = {
    jobId: '13095',
    canonicalUrl: 'https://test.oraclecloud.com/job/13095',
    tenantHost: 'test.oraclecloud.com'
  };

  const result = await adapter.authenticate({
    session: { page: mockPage },
    job,
    email: 'test@example.com'
  });

  assert.equal(result.status, 'authenticated');
  assert.equal(manualClicked, true, 'Should have clicked manually link');
});

test('scanForm clicks manually link if current URL is on /easy-apply before extracting fields', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 },
    initialWait: 0,
    runtimeDir: path.join(os.tmpdir(), 'oracle-test-' + Date.now())
  });

  let currentUrl = 'https://test.oraclecloud.com/job/13095/easy-apply';
  let manualClicked = false;

  const mockLocator = (selector) => {
    const loc = {
      count: async () => {
        if (selector.includes('manually')) return 1;
        return 0;
      },
      first: () => loc,
      nth: () => loc,
      waitFor: async () => {},
      click: async () => {
        if (selector.includes('manually')) {
          manualClicked = true;
          currentUrl = 'https://test.oraclecloud.com/job/13095/apply/section/1';
        }
      },
      isVisible: async () => selector.includes('manually'),
      evaluateAll: async () => [],
      evaluate: async () => ({})
    };
    return loc;
  };

  const mockPage = {
    url: () => currentUrl,
    waitForLoadState: async () => {},
    waitForURL: async () => {},
    evaluate: async () => ({ groups: [], handledCheckboxIds: [] }),
    content: async () => '<html></html>',
    screenshot: async () => {},
    locator: mockLocator,
    getByRole: (role, opts) => mockLocator(String(opts?.name ?? ''))
  };

  const job = {
    jobId: '13095',
    jobKey: 'job_4',
    canonicalUrl: 'https://test.oraclecloud.com/job/13095'
  };

  const template = await adapter.scanForm({
    session: { page: mockPage },
    job
  });

  assert.equal(manualClicked, true, 'Should click manually link at start of scanForm');
  assert.ok(template, 'Template should be returned');
});

test('fillApplication clicks manually link if starting on /easy-apply splash screen', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 },
    initialWait: 0,
    runtimeDir: path.join(os.tmpdir(), 'oracle-test-' + Date.now())
  });

  let currentUrl = 'https://test.oraclecloud.com/job/13095/easy-apply';
  let manualClicked = false;

  const mockLocator = (selector) => {
    const loc = {
      count: async () => selector.includes('manually') ? 1 : 0,
      first: () => loc,
      nth: () => loc,
      waitFor: async () => {},
      click: async () => {
        if (selector.includes('manually')) {
          manualClicked = true;
          currentUrl = 'https://test.oraclecloud.com/job/13095/apply/section/1';
        }
      },
      isVisible: async () => selector.includes('manually'),
      evaluateAll: async () => [],
      evaluate: async () => ({})
    };
    return loc;
  };

  const mockPage = {
    url: () => currentUrl,
    waitForLoadState: async () => {},
    waitForURL: async () => {},
    evaluate: async () => ({ groups: [], handledCheckboxIds: [] }),
    content: async () => '<html></html>',
    screenshot: async () => {},
    locator: mockLocator,
    getByRole: (role, opts) => mockLocator(String(opts?.name ?? ''))
  };

  const result = await adapter.fillApplication({
    session: { page: mockPage },
    template: { fields: [] },
    values: {},
    context: { jobId: '13095', userId: 'user-1' }
  });

  assert.equal(manualClicked, true, 'Should click manually link at start of fillApplication');
  assert.ok(result, 'Fill result should be returned');
});
