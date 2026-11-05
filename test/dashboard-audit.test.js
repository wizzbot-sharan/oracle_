import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeDashboardMetrics } from '../src/server.js';
import { Phase3AnswerResolution } from '../src/phases/phase3-answer-resolution.js';

test('computeDashboardMetrics calculates accurate KPI counts and client list', async () => {
  const tmpDir = path.join(os.tmpdir(), `dashboard-metric-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const clientsPath = path.join(tmpDir, 'clients.json');
  fs.writeFileSync(clientsPath, JSON.stringify({
    'AWL-1': { client: { full_name: 'Alice Cooper' } },
    'AWL-2': { client: { full_name: 'Bob Marley' } }
  }), 'utf8');

  const jobs = {
    assignments: [
      { assignmentId: 'asg-1', applywizzId: 'AWL-1', clientName: 'Alice Cooper', jobKey: 'job_1', jobId: '101' },
      { assignmentId: 'asg-2', applywizzId: 'AWL-1', clientName: 'Alice Cooper', jobKey: 'job_2', jobId: '102' },
      { assignmentId: 'asg-3', applywizzId: 'AWL-2', clientName: 'Bob Marley', jobKey: 'job_1', jobId: '101' }
    ],
    uniqueJobs: [
      { jobKey: 'job_1', jobId: '101' },
      { jobKey: 'job_2', jobId: '102' }
    ]
  };

  const templates = {
    job_1: { fields: [{ id: 'f1', label: 'Field 1' }] }
    // job_2 is unscanned
  };

  const applications = [
    {
      applicationId: 'app-1',
      userId: 'AWL-1',
      jobKey: 'job_1',
      status: 'answers_resolved',
      values: {
        f1: { value: 'Answer 1', source: 'tier1_client_profile', stage: 'stage1_taxonomy', confidence: 1.0 }
      }
    },
    {
      applicationId: 'app-2',
      userId: 'AWL-2',
      jobKey: 'job_1',
      status: 'needs_input',
      values: {
        f1: { value: '', source: null, stage: 'stage5_operator', confidence: 0 }
      }
    }
  ];

  const result = await computeDashboardMetrics({
    jobs,
    applications,
    templates,
    clientsPath
  });

  const { metrics, clients } = result;

  assert.equal(metrics.totalClients, 2);
  assert.equal(metrics.totalJobs, 3);
  assert.equal(metrics.uniqueUrls, 2);
  assert.equal(metrics.scannedUrls, 1);
  assert.equal(metrics.unlockableApplications, 2, 'Should unlock 2 assignments matching job_1');
  assert.equal(metrics.resolvedPreAiApps, 1);
  assert.equal(metrics.resolvedPreAiQuestions, 1);
  assert.equal(metrics.dashboardReviewApps, 1);
  assert.equal(metrics.dashboardReviewQuestions, 1);

  assert.equal(clients.length, 2);
  assert.equal(clients[0].applywizzId, 'AWL-1');
  assert.equal(clients[0].clientName, 'Alice Cooper');
});

test('saveAnswers performs in-place upsert in question_bank.csv with zero row duplication', async () => {
  const tmpDir = path.join(os.tmpdir(), `upsert-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const qbCsvPath = path.join(tmpDir, 'question_bank.csv');
  const existingId = 'existing-uuid-1234';
  const initialTimestamp = '2026-10-01T12:00:00.000Z';

  // Seed CSV with one existing record for AWL-TEST-1
  const initialCsv = [
    'id,applywizz_id,question_label,field_type,value,source,confidence,created_at,updated_at',
    `${existingId},AWL-TEST-1,"What is your permanent city?",text,Dallas,ai,0.85,${initialTimestamp},${initialTimestamp}`
  ].join('\n') + '\n';

  fs.writeFileSync(qbCsvPath, initialCsv, 'utf8');

  const inMemoryStore = {
    data: {
      'form-templates': {
        job_1: {
          fields: [
            { id: 'city_field', label: 'What is your permanent city?', type: 'text', required: true },
            { id: 'brand_new_field', label: 'Preferred Office Location', type: 'text', required: false }
          ]
        }
      },
      applications: [
        {
          applicationId: 'app-test-1',
          userId: 'AWL-TEST-1',
          jobKey: 'job_1',
          status: 'needs_input',
          values: {
            city_field: { value: 'Dallas', source: 'ai', confidence: 0.85, reviewed: false },
            brand_new_field: { value: null, source: null, confidence: 0, reviewed: false }
          }
        }
      ]
    },
    async read(key) { return this.data[key] ?? []; },
    readSync(key) { return this.data[key] ?? []; },
    async update(key, fallback, fn) { this.data[key] = fn(this.data[key] ?? fallback); }
  };

  const phase3 = new Phase3AnswerResolution({
    store: inMemoryStore,
    config: { questionBankCsvPath: qbCsvPath }
  });

  // Operator updates existing city_field from "Dallas" to "Austin"
  await phase3.saveAnswers('app-test-1', {
    city_field: 'Austin'
  });

  const linesAfterUpdate = fs.readFileSync(qbCsvPath, 'utf8').trim().split('\n');
  assert.equal(linesAfterUpdate.length, 2, 'Row count should remain exactly 2 (Header + 1 record) without duplicate rows');
  assert.ok(linesAfterUpdate[1].includes(existingId), 'Must preserve original record ID');
  assert.ok(linesAfterUpdate[1].includes('Austin'), 'Record must be updated in place with new value');
  assert.ok(linesAfterUpdate[1].includes('manual'), 'Record source must be updated to manual');
  assert.ok(linesAfterUpdate[1].includes('1.0'), 'Record confidence must be updated to 1.0');

  // Now operator saves brand_new_field (should append new row)
  await phase3.saveAnswers('app-test-1', {
    brand_new_field: 'Austin Tech Hub'
  });

  const linesAfterInsert = fs.readFileSync(qbCsvPath, 'utf8').trim().split('\n');
  assert.equal(linesAfterInsert.length, 3, 'Row count should now be 3 (Header + 2 records)');
  assert.ok(linesAfterInsert[2].includes('Preferred Office Location'));
  assert.ok(linesAfterInsert[2].includes('Austin Tech Hub'));
});
