import test from 'node:test';
import assert from 'node:assert/strict';
import { Phase4ApplyReviewSubmit } from '../src/phases/phase4-apply-review-submit.js';

function fixture(application) {
  const store = {
    async read(name) { return name === 'applications' ? [application] : {}; },
    async update(_name, _fallback, updater) { await updater([application]); }
  };
  return new Phase4ApplyReviewSubmit({
    store,
    runLog: { append: async () => {} },
    oracle: { clickSubmit: async () => { throw new Error('must not run'); } },
    phase1: {},
    sessions: { get: () => null }
  });
}

test('submission requires approved review', async () => {
  const phase = fixture({ applicationId: 'app-1', jobId: '123', reviewStatus: 'pending' });
  await assert.rejects(() => phase.submit('app-1', '123'), error => error.code === 'REVIEW_NOT_APPROVED');
});

test('submission requires exact job ID confirmation', async () => {
  const phase = fixture({ applicationId: 'app-1', jobId: '123', reviewStatus: 'approved' });
  await assert.rejects(() => phase.submit('app-1', 'wrong'), error => error.code === 'SUBMIT_CONFIRMATION_MISMATCH');
});

test('fillApplication traverses multiple pages and halts safely when Submit is detected', async () => {
  const { OracleRecruitingAdapter } = await import('../src/adapters/oracle/oracle-recruiting.js');
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  let currentPage = 1;
  const clicks = [];
  const typedValues = {};

  const makeFieldLocator = (name) => {
    const isVisibleNow = () => ((currentPage === 1 && (name === 'first_name' || name === 'country')) || (currentPage === 2 && name === 'last_name'));
    const item = {
      count: async () => (isVisibleNow() ? 1 : 0),
      isVisible: async () => isVisibleNow(),
      boundingBox: async () => ({ x: 0, y: 100 }),
      evaluate: async () => {},
      scrollIntoViewIfNeeded: async () => {},
      getAttribute: async (attr) => (attr === 'aria-controls' ? 'country-listbox' : null),
      click: async () => {
        if (name === 'country') typedValues[name] = 'United States';
      },
      dispatchEvent: async () => {},
      hover: async () => {},
      fill: async () => {},
      pressSequentially: async (c) => { typedValues[name] = (typedValues[name] || '') + c; },
      press: async (key) => {
        if (key === 'Enter') {
          typedValues[name] = typedValues[name] || 'United States';
        }
      },
      inputValue: async () => typedValues[name],
      waitFor: async () => {},
      locator: () => item,
      filter: () => item,
      or: () => item,
      first: () => item,
      last: () => item
    };
    return item;
  };

  const nextBtnLocator = {
    count: async () => (currentPage === 1 ? 1 : 0),
    first: () => ({
      count: async () => (currentPage === 1 ? 1 : 0),
      isVisible: async () => currentPage === 1,
      boundingBox: async () => ({ x: 0, y: 800 }),
      evaluate: async () => {},
      scrollIntoViewIfNeeded: async () => {},
      click: async () => {
        clicks.push('next');
        currentPage = 2;
      }
    }),
    last: () => ({
      count: async () => (currentPage === 1 ? 1 : 0),
      isVisible: async () => currentPage === 1,
      evaluate: async () => {},
      scrollIntoViewIfNeeded: async () => {}
    })
  };

  const submitBtnLocator = {
    count: async () => (currentPage === 2 ? 1 : 0),
    first: () => ({
      count: async () => (currentPage === 2 ? 1 : 0),
      isVisible: async () => currentPage === 2,
      boundingBox: async () => ({ x: 0, y: 800 }),
      evaluate: async () => {},
      scrollIntoViewIfNeeded: async () => {},
      click: async () => {
        clicks.push('submit');
      }
    }),
    last: () => ({
      count: async () => (currentPage === 2 ? 1 : 0),
      isVisible: async () => currentPage === 2,
      evaluate: async () => {},
      scrollIntoViewIfNeeded: async () => {}
    })
  };

  const mockPage = {
    url: () => `https://test.oraclecloud.com/apply/section/${currentPage}`,
    waitForLoadState: async () => {},
    evaluate: async () => {},
    viewportSize: () => ({ height: 900 }),
    mouse: { wheel: async () => {} },
    locator: (selector) => {
      if (selector.includes('first_name')) return makeFieldLocator('first_name');
      if (selector.includes('country')) return makeFieldLocator('country');
      if (selector.includes('last_name')) return makeFieldLocator('last_name');
      if (selector.includes('apply-flow-pagination') || selector.includes('pagination__button')) return nextBtnLocator;
      return { count: async () => 0, first: () => ({ count: async () => 0, isVisible: async () => false, evaluate: async () => {} }), last: () => ({ count: async () => 0, isVisible: async () => false, evaluate: async () => {} }) };
    },
    getByRole: (role, opts) => {
      if (role === 'button' && opts?.name?.test?.('Submit')) return submitBtnLocator;
      return { count: async () => 0, first: () => ({ count: async () => 0, isVisible: async () => false }) };
    },
    getByLabel: (label) => {
      if (label === 'First Name') return makeFieldLocator('first_name');
      if (label === 'Country') return makeFieldLocator('country');
      if (label === 'Last Name') return makeFieldLocator('last_name');
      return { count: async () => 0, first: () => ({ count: async () => 0, isVisible: async () => false }) };
    }
  };

  const template = {
    fields: [
      { id: 'first_name', label: 'First Name', type: 'text', sourceId: 'first_name' },
      { id: 'country', label: 'Country', type: 'combobox', sourceId: 'country' },
      { id: 'last_name', label: 'Last Name', type: 'text', sourceId: 'last_name' }
    ]
  };

  const values = {
    first_name: { value: 'Alice' },
    country: { value: 'United States' },
    last_name: { value: 'Smith' }
  };

  const results = await adapter.fillApplication({
    session: { page: mockPage },
    template,
    values,
    context: { jobId: 'test-job', userId: 'user-1' }
  });

  assert.equal(results.length, 3);
  assert.equal(results[0].fieldId, 'first_name');
  assert.equal(results[0].status, 'verified');
  assert.equal(results[1].fieldId, 'country');
  assert.equal(results[1].status, 'verified');
  assert.equal(results[2].fieldId, 'last_name');
  assert.equal(results[2].status, 'verified');
  assert.deepEqual(clicks, ['next']); // Clicked next, halted safely before submit!
  assert.equal(currentPage, 2);
});
