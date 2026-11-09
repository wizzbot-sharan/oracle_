import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobSelector, isJobSelected, isAssignmentSelected } from '../src/shared/job-filter.js';

test('parseJobSelector handles empty options as unrestricted', () => {
  const sel = parseJobSelector({});
  assert.equal(sel.hasFilter, false);
  assert.equal(sel.range, null);
  assert.equal(isJobSelected('job_10', sel), true);
  assert.equal(isAssignmentSelected({ jobKey: 'job_10', userId: 'AWL-1' }, sel), true);
});

test('parseJobSelector parses range in different formats', () => {
  // Numeric: "50-100"
  const s1 = parseJobSelector({ range: '50-100' });
  assert.equal(s1.hasFilter, true);
  assert.equal(s1.range.start, 50);
  assert.equal(s1.range.end, 100);
  assert.equal(isJobSelected('job_49', s1), false);
  assert.equal(isJobSelected('job_50', s1), true);
  assert.equal(isJobSelected('job_75', s1), true);
  assert.equal(isJobSelected('job_100', s1), true);
  assert.equal(isJobSelected('job_101', s1), false);

  // Inverted numeric: "100-50"
  const s2 = parseJobSelector({ range: '100-50' });
  assert.equal(s2.range.start, 50);
  assert.equal(s2.range.end, 100);

  // Prefixed: "job_50-job_100"
  const s3 = parseJobSelector({ range: 'job_50-job_100' });
  assert.equal(s3.range.start, 50);
  assert.equal(s3.range.end, 100);
  assert.equal(isJobSelected('job_55', s3), true);

  // Using --from and --to
  const s4 = parseJobSelector({ from: 10, to: 20 });
  assert.equal(s4.range.start, 10);
  assert.equal(s4.range.end, 20);
  assert.equal(isJobSelected('job_15', s4), true);
  assert.equal(isJobSelected('job_25', s4), false);
});

test('parseJobSelector parses explicit job keys and lists', () => {
  const sel = parseJobSelector({ jobs: 'job_211, job_234, job_300' });
  assert.equal(sel.hasFilter, true);
  assert.equal(sel.explicitJobKeys.size, 3);
  assert.equal(isJobSelected('job_211', sel), true);
  assert.equal(isJobSelected('job_234', sel), true);
  assert.equal(isJobSelected('job_212', sel), false);
});

test('parseJobSelector handles combined range and explicit keys', () => {
  const sel = parseJobSelector({ range: '10-20', jobs: 'job_99' });
  assert.equal(isJobSelected('job_15', sel), true);
  assert.equal(isJobSelected('job_99', sel), true);
  assert.equal(isJobSelected('job_50', sel), false);
});

test('isAssignmentSelected filters by client and company', () => {
  const selClient = parseJobSelector({ client: 'awl-32411' });
  assert.equal(isAssignmentSelected({ applywizzId: 'AWL-32411', jobKey: 'job_1' }, selClient), true);
  assert.equal(isAssignmentSelected({ applywizzId: 'AWL-99999', jobKey: 'job_1' }, selClient), false);

  const selCompany = parseJobSelector({ company: 'firstenergy' });
  assert.equal(isAssignmentSelected({ companyName: 'FirstEnergy Corp', jobKey: 'job_1' }, selCompany), true);
  assert.equal(isAssignmentSelected({ companyName: 'VITAS Healthcare', jobKey: 'job_1' }, selCompany), false);

  // Combined: Range + Client
  const selCombined = parseJobSelector({ range: '200-220', client: 'AWL-39786' });
  assert.equal(isAssignmentSelected({ applywizzId: 'AWL-39786', jobKey: 'job_211' }, selCombined), true);
  assert.equal(isAssignmentSelected({ applywizzId: 'AWL-39786', jobKey: 'job_250' }, selCombined), false); // out of range
  assert.equal(isAssignmentSelected({ applywizzId: 'AWL-99999', jobKey: 'job_211' }, selCombined), false); // wrong client
});
