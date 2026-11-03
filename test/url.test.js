import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOracleJobUrl } from '../src/shared/url.js';

test('normalizes Oracle job links and removes tracking parameters', () => {
  const result = parseOracleJobUrl('https://egup.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/job/20283127/?utm_medium=jobboard&utm_source=linkedin');
  assert.equal(result.canonicalUrl, 'https://egup.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/20283127');
  assert.equal(result.tenantHost, 'egup.fa.us2.oraclecloud.com');
  assert.equal(result.tenantKey, 'egup');
  assert.equal(result.sourceJobId, '20283127');
});

test('supports requisitions preview URL pattern', () => {
  const result = parseOracleJobUrl('https://icfcjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions/preview/99124652');
  assert.equal(result.tenantHost, 'icfcjb.fa.ocs.oraclecloud.com');
  assert.equal(result.tenantKey, 'icfcjb');
  assert.equal(result.sourceJobId, '99124652');
});

test('rejects non-Oracle hosts', () => {
  assert.throws(() => parseOracleJobUrl('https://example.com/job/123'), error => error.code === 'UNSUPPORTED_JOB_HOST');
});
