import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseOtpCandidate, extractOtp, scoreOtpMessage } from '../src/adapters/mail/otp-matcher.js';

const requestedAt = 1_793_624_530_000;
const base = {
  candidateEmail: 'lokesh.matla@applywizard.ai',
  requestedAt,
  tenantHost: 'egup.fa.us2.oraclecloud.com',
  tenantKey: 'egup',
  companyDomains: [],
  consumedIds: new Set()
};

test('extracts a code near OTP language instead of unrelated numbers', () => {
  assert.equal(extractOtp('Copyright 2024. Your one-time pass code is 338514. It expires soon.'), '338514');
});

test('accepts an Oracle workflow sender correlated through the tenant URL', () => {
  const summary = {
    messageId: 'm1',
    receivedTime: String(requestedAt + 1000),
    to: '&lt;lokesh.matla@applywizard.ai&gt;',
    from: 'egup.fa.sender.1@workflow.email.us-phoenix-1.ocs.oraclecloud.com',
    subject: 'Confirm your identity'
  };
  const body = { htmlContent: '<p>Your one-time pass code is <b>338514</b>. Code will expire.</p><img src="https://egup.fa.us2.oraclecloud.com/image">' };
  const result = scoreOtpMessage({ summary, body, ...base });
  assert.equal(result.accepted, true);
  assert.equal(result.code, '338514');
  assert.ok(result.score >= 80);
});

test('accepts a company sender when other signals are strong', () => {
  const summary = {
    messageId: 'm2',
    receivedTime: String(requestedAt + 1000),
    to: 'lokesh.matla@applywizard.ai',
    from: 'careers@example-company.com',
    subject: 'Verify your email'
  };
  const body = { textContent: 'Use verification code 901244 to verify your identity.', htmlContent: '<a href="https://egup.fa.us2.oraclecloud.com/hcmUI">Continue</a>' };
  const result = scoreOtpMessage({ summary, body, ...base, companyDomains: ['example-company.com'] });
  assert.equal(result.accepted, true);
  assert.equal(result.code, '901244');
});

test('rejects stale and ambiguous messages', () => {
  const summary = { messageId: 'm3', receivedTime: String(requestedAt - 60_000), to: 'lokesh.matla@applywizard.ai', from: 'no-reply@oracle.com', subject: 'Verification code' };
  const body = { textContent: 'Verification code 123456 and security code 654321' };
  const result = scoreOtpMessage({ summary, body, ...base });
  assert.equal(result.accepted, false);
  assert.ok(result.rejected.includes('too-old'));
  assert.ok(result.rejected.includes('missing-or-ambiguous-code'));
});

test('does not guess between close candidates with different codes', () => {
  const selected = chooseOtpCandidate([
    { summary: { receivedTime: '2' }, match: { accepted: true, score: 100, code: '111111' } },
    { summary: { receivedTime: '1' }, match: { accepted: true, score: 95, code: '222222' } }
  ]);
  assert.equal(selected.ambiguous, true);
});
