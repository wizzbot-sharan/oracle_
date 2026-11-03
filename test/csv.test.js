import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/shared/csv.js';

test('parses quoted CSV values and escaped quotes', () => {
  const rows = parseCsv('user_id,job_id,job_url\n"user,1",123,"https://x.test/job/123?note=""hello"""\n');
  assert.equal(rows[0].user_id, 'user,1');
  assert.equal(rows[0].job_url, 'https://x.test/job/123?note="hello"');
});

test('rejects dangerous and duplicate headers', () => {
  assert.throws(() => parseCsv('__proto__,job_id\nx,1\n'), error => error.code === 'INVALID_CSV_HEADERS');
  assert.throws(() => parseCsv('job_id,job_id\n1,2\n'), error => error.code === 'INVALID_CSV_HEADERS');
});
