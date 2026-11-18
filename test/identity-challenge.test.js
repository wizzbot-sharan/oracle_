import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIdentityChallenge, isApplicationFlowUrl } from '../src/adapters/oracle/identity-challenge.js';

function challengePage({ lastName = false, otp = false } = {}) {
  const locator = shown => ({
    or(other) { return locator(shown || other.shown); },
    first() { return this; },
    isVisible: async () => shown,
    shown
  });
  return {
    getByRole(role, options) {
      assert.equal(role, 'textbox');
      assert.match('Last Name', options.name);
      return locator(lastName);
    },
    locator(selector) {
      return locator(selector.includes('verificationCode') ? otp : lastName);
    }
  };
}

test('last name challenge is not mistaken for OTP even under a Confirm Your Identity heading', async () => {
  assert.equal(await detectIdentityChallenge(challengePage({ lastName: true })), 'last_name');
  assert.equal(await detectIdentityChallenge(challengePage({ lastName: true, otp: true })), 'last_name');
});

test('OTP requires a visible code input', async () => {
  assert.equal(await detectIdentityChallenge(challengePage({ otp: true })), 'otp');
  assert.equal(await detectIdentityChallenge(challengePage()), null);
});

test('application route is authoritative even if a challenge control lingers in the DOM', () => {
  assert.equal(isApplicationFlowUrl('https://example.oraclecloud.com/job/13082/apply/section/1'), true);
  assert.equal(isApplicationFlowUrl('https://example.oraclecloud.com/job/13082/easy-apply/email'), false);
});
