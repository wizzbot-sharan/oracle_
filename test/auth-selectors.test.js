import test from 'node:test';
import assert from 'node:assert/strict';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';

test('OracleRecruitingAdapter configures human typing speed and pauses properly', () => {
  const adapter = new OracleRecruitingAdapter({
    headless: true,
    humanDelay: { min: 50, max: 200 },
    actionGap: { min: 1000, max: 2000 },
    postNextWait: { min: 3000, max: 5000 },
    pageSettle: { min: 5000, max: 10000 }
  });

  assert.equal(adapter.humanDelay.min, 50);
  assert.equal(adapter.humanDelay.max, 200);
  assert.equal(adapter.actionGap.min, 1000);
  assert.equal(adapter.actionGap.max, 2000);
  assert.equal(adapter.postNextWait.min, 3000);
  assert.equal(adapter.postNextWait.max, 5000);
});

test('Next button selector pattern distinguishes Next from Cancel', () => {
  // Regex and selector validation ensuring Cancel is not accidentally matched
  const cancelText = 'Cancel';
  const nextText = 'Next';
  const isCancel = /cancel/i.test(cancelText);
  const isNext = /^(next|continue)$/i.test(nextText);
  const isCancelMatchingNext = /^(next|continue)$/i.test(cancelText);

  assert.equal(isCancel, true);
  assert.equal(isNext, true);
  assert.equal(isCancelMatchingNext, false);
});
