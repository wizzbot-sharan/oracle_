import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseCsv, formatCsv } from '../src/shared/csv.js';
import { Phase1IngestAuth } from '../src/phases/phase1-ingest-auth.js';

test('formatCsv correctly formats rows and escapes special characters', () => {
  const rows = [
    { name: 'John Doe', city: 'New York, NY', note: 'Line 1\nLine 2', quote: 'Said "Hello"' },
    { name: 'Jane', city: 'Boston', note: 'None', quote: 'Simple' }
  ];
  const headers = ['name', 'city', 'note', 'quote'];
  const csv = formatCsv(rows, headers);

  const parsed = parseCsv(csv);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].city, 'New York, NY');
  assert.equal(parsed[0].note, 'Line 1\nLine 2');
  assert.equal(parsed[0].quote, 'Said "Hello"');
  assert.equal(parsed[1].name, 'Jane');
});

test('ingestCsv creates jobs.csv with job_key starting from job_1 and appends job_key to source CSV', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-ingest-'));
  const sourceCsvPath = path.join(tmpDir, 'source.csv');
  const cleanCsvPath = path.join(tmpDir, 'jobs.csv');

  const mockStore = {
    write: async () => {},
    read: async () => ({})
  };
  const mockRunLog = {
    append: async () => {}
  };

  const sampleCsvContent = `company_name,job_url,score,client_name,applywizz_id
Company A,https://test.oraclecloud.com/job/101?source=linkedin&utm=test,90,Alice Smith,AWL-1
Company B,https://test.oraclecloud.com/job/202,80,Bob Jones,AWL-2
Company A,https://test.oraclecloud.com/job/101?source=linkedin&utm=test,75,Charlie Brown,AWL-3
Company C,https://test.oraclecloud.com/job/303,85,Alice Smith,AWL-1
`;

  await fs.writeFile(sourceCsvPath, sampleCsvContent, 'utf8');

  const phase1 = new Phase1IngestAuth({
    store: mockStore,
    runLog: mockRunLog,
    oracle: {},
    mailReader: {},
    otpLock: { run: async (_, fn) => fn() }
  });

  const result = await phase1.ingestCsv(sourceCsvPath, { cleanCsvPath });

  // 1. Check jobs.csv
  const jobsCsvText = await fs.readFile(cleanCsvPath, 'utf8');
  const uniqueJobs = parseCsv(jobsCsvText);

  assert.equal(uniqueJobs.length, 3, 'Should have 3 unique URLs');
  assert.deepEqual(Object.keys(uniqueJobs[0]), ['job_key', 'job_url']);
  assert.equal(uniqueJobs[0].job_key, 'job_1');
  assert.equal(uniqueJobs[0].job_url, 'https://test.oraclecloud.com/job/101?source=linkedin&utm=test', 'Raw URL preserved without stripping');
  assert.equal(uniqueJobs[1].job_key, 'job_2');
  assert.equal(uniqueJobs[1].job_url, 'https://test.oraclecloud.com/job/202');
  assert.equal(uniqueJobs[2].job_key, 'job_3');
  assert.equal(uniqueJobs[2].job_url, 'https://test.oraclecloud.com/job/303');

  // 2. Check source CSV updated with job_key as last column
  const updatedSourceText = await fs.readFile(sourceCsvPath, 'utf8');
  const updatedRows = parseCsv(updatedSourceText);

  assert.equal(updatedRows.length, 4);
  assert.deepEqual(Object.keys(updatedRows[0]), ['company_name', 'job_url', 'score', 'client_name', 'applywizz_id', 'job_key']);
  assert.equal(updatedRows[0].job_key, 'job_1');
  assert.equal(updatedRows[1].job_key, 'job_2');
  assert.equal(updatedRows[2].job_key, 'job_1', 'Row with duplicate URL should receive matching job_1');
  assert.equal(updatedRows[3].job_key, 'job_3');

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('ingestCsv cleanly overwrites jobs.csv fresh from job_1 on subsequent runs', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-ingest-overwrite-'));
  const sourceCsvPath = path.join(tmpDir, 'source.csv');
  const cleanCsvPath = path.join(tmpDir, 'jobs.csv');

  const phase1 = new Phase1IngestAuth({
    store: { write: async () => {} },
    runLog: { append: async () => {} },
    oracle: {},
    mailReader: {},
    otpLock: { run: async (_, fn) => fn() }
  });

  // Run 1: 2 unique URLs
  const run1Content = `company_name,job_url,score,client_name,applywizz_id
Comp1,https://test.oraclecloud.com/job/1,90,User1,AWL-1
Comp2,https://test.oraclecloud.com/job/2,80,User2,AWL-2
`;
  await fs.writeFile(sourceCsvPath, run1Content, 'utf8');
  await phase1.ingestCsv(sourceCsvPath, { cleanCsvPath });

  let jobs = parseCsv(await fs.readFile(cleanCsvPath, 'utf8'));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].job_key, 'job_1');

  // Run 2: Completely new single URL
  const run2Content = `company_name,job_url,score,client_name,applywizz_id
CompNew,https://test.oraclecloud.com/job/999,99,UserNew,AWL-99
`;
  await fs.writeFile(sourceCsvPath, run2Content, 'utf8');
  await phase1.ingestCsv(sourceCsvPath, { cleanCsvPath });

  // Verify jobs.csv was cleanly overwritten and starts from job_1
  jobs = parseCsv(await fs.readFile(cleanCsvPath, 'utf8'));
  assert.equal(jobs.length, 1, 'Previous jobs should be cleanly overwritten');
  assert.equal(jobs[0].job_key, 'job_1');
  assert.equal(jobs[0].job_url, 'https://test.oraclecloud.com/job/999');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('ingestCsv throws INVALID_CSV_ROW if required headers are missing', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-ingest-err-'));
  const sourceCsvPath = path.join(tmpDir, 'invalid.csv');

  // Missing applywizz_id
  const invalidContent = `company_name,job_url,score,client_name
Comp1,https://test.oraclecloud.com/job/1,90,User1
`;
  await fs.writeFile(sourceCsvPath, invalidContent, 'utf8');

  const phase1 = new Phase1IngestAuth({
    store: { write: async () => {} },
    runLog: { append: async () => {} },
    oracle: {},
    mailReader: {},
    otpLock: { run: async (_, fn) => fn() }
  });

  await assert.rejects(
    async () => phase1.ingestCsv(sourceCsvPath),
    error => error.code === 'INVALID_CSV_ROW'
  );

  await fs.rm(tmpDir, { recursive: true, force: true });
});
