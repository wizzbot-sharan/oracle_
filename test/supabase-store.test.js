import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStore } from '../src/storage/supabase-store.js';

function createMockSupabaseClient(tableHandlers = {}) {
  return {
    from(table) {
      const handler = tableHandlers[table] || {};
      return {
        select(cols) {
          if (handler.selectError) {
            return Promise.resolve({ data: null, error: handler.selectError });
          }
          const data = typeof handler.selectData === 'function'
            ? handler.selectData(cols)
            : (handler.selectData ?? []);

          return {
            order(col, opts) {
              return Promise.resolve({ data, error: null });
            },
            then(resolve, reject) {
              return Promise.resolve({ data, error: null }).then(resolve, reject);
            }
          };
        },
        upsert(rows, opts) {
          if (handler.onUpsert) handler.onUpsert(rows, opts);
          if (handler.upsertError) {
            return Promise.resolve({ data: null, error: handler.upsertError });
          }
          return Promise.resolve({ data: rows, error: null });
        },
        insert(rows, opts) {
          if (handler.onInsert) handler.onInsert(rows, opts);
          if (handler.insertError) {
            return Promise.resolve({ data: null, error: handler.insertError });
          }
          return Promise.resolve({ data: rows, error: null });
        }
      };
    }
  };
}

test('SupabaseStore.isAvailable() returns true when client is present and false when absent', () => {
  const emptyStore = new SupabaseStore({ url: null, key: null, client: null });
  assert.equal(emptyStore.isAvailable(), false);

  const mockClient = createMockSupabaseClient();
  const readyStore = new SupabaseStore({ client: mockClient });
  assert.equal(readyStore.isAvailable(), true);
});

test('SupabaseStore handles jobs and oracle_jobs reading and writing', async () => {
  let upsertedJobs = null;
  let upsertedOracleJobs = null;

  const client = createMockSupabaseClient({
    jobs: {
      selectData: [
        {
          job_key: 'job_101',
          job_url: 'https://oracle.com/job/101',
          tenant_host: 'oracle.com',
          tenant_key: 'ora_key',
          metadata: { title: 'Software Engineer' }
        }
      ],
      onUpsert: (rows) => { upsertedJobs = rows; }
    },
    oracle_jobs: {
      selectData: [
        {
          job_key: 'job_101',
          job_url: 'https://oracle.com/job/101',
          company_name: 'Oracle Corp',
          client_name: 'Jane Doe',
          applywizz_id: 'AWL-101',
          score: 95
        }
      ],
      onUpsert: (rows) => { upsertedOracleJobs = rows; }
    }
  });

  const store = new SupabaseStore({ client });

  // Read
  const result = await store.read('jobs', { uniqueJobs: [], assignments: [] });
  assert.equal(result.uniqueJobs.length, 1);
  assert.equal(result.uniqueJobs[0].jobKey, 'job_101');
  assert.equal(result.uniqueJobs[0].title, 'Software Engineer');
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].applywizzId, 'AWL-101');

  // Write
  await store.write('jobs', {
    uniqueJobs: [{ jobKey: 'job_202', jobUrl: 'https://oracle.com/job/202', tenantHost: 'oracle.com' }],
    assignments: [{ jobId: 'job_202', applywizzId: 'AWL-202', companyName: 'Acme', clientName: 'John', score: 80 }]
  });

  assert.equal(upsertedJobs.length, 1);
  assert.equal(upsertedJobs[0].job_key, 'job_202');
  assert.equal(upsertedOracleJobs.length, 1);
  assert.equal(upsertedOracleJobs[0].applywizz_id, 'AWL-202');
});

test('SupabaseStore handles form_templates reading and writing', async () => {
  let upsertedTemplates = null;

  const client = createMockSupabaseClient({
    form_templates: {
      selectData: [
        {
          job_key: 'job_1',
          template_id: 'tpl-1',
          version: '1.0.0',
          submit_present: true,
          fields: [{ id: 'fld_email', label: 'Email' }],
          conditional_branches: [],
          repeatable_groups: [],
          scan_metadata: { scannedAt: '2026-11-09T00:00:00Z' }
        }
      ],
      onUpsert: (rows) => { upsertedTemplates = rows; }
    }
  });

  const store = new SupabaseStore({ client });

  // Read
  const tpls = await store.read('form-templates', {});
  assert.ok(tpls.job_1);
  assert.equal(tpls.job_1.templateId, 'tpl-1');
  assert.equal(tpls.job_1.submitPresent, true);
  assert.equal(tpls.job_1.fields.length, 1);

  // Write
  await store.write('form-templates', {
    job_2: {
      templateId: 'tpl-2',
      submitPresent: false,
      fields: [{ id: 'fld_phone', label: 'Phone' }]
    }
  });

  assert.equal(upsertedTemplates.length, 1);
  assert.equal(upsertedTemplates[0].job_key, 'job_2');
  assert.equal(upsertedTemplates[0].fields_count, 1);
});

test('SupabaseStore handles applications reading and writing', async () => {
  let upsertedApps = null;

  const client = createMockSupabaseClient({
    applications: {
      selectData: [
        {
          application_id: 'app_1',
          applywizz_id: 'AWL-1',
          job_key: 'job_1',
          client_name: 'Alice',
          company_name: 'Tech Inc',
          status: 'answers_resolved',
          review_status: 'approved',
          values: { fld_name: 'Alice' },
          unresolved_fields: []
        }
      ],
      onUpsert: (rows) => { upsertedApps = rows; }
    }
  });

  const store = new SupabaseStore({ client });

  // Read
  const apps = await store.read('applications', []);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].applicationId, 'app_1');
  assert.equal(apps[0].status, 'answers_resolved');

  // Write
  await store.write('applications', [
    {
      applicationId: 'app_2',
      applywizzId: 'AWL-2',
      jobKey: 'job_2',
      status: 'needs_input',
      values: { fld_state: 'CA' },
      unresolvedFields: ['fld_city']
    }
  ]);

  assert.equal(upsertedApps.length, 1);
  assert.equal(upsertedApps[0].application_id, 'app_2');
  assert.equal(upsertedApps[0].status, 'needs_input');
});

test('SupabaseStore handles scan_status reading and writing with summary calculation', async () => {
  let upsertedStatus = null;

  const client = createMockSupabaseClient({
    scan_status: {
      selectData: [
        { job_key: 'job_1', job_url: 'https://job1', status: 'completed', worker_id: 1 },
        { job_key: 'job_2', job_url: 'https://job2', status: 'skipped', worker_id: 2 },
        { job_key: 'job_3', job_url: 'https://job3', status: 'failed', worker_id: 1 },
        { job_key: 'job_4', job_url: 'https://job4', status: 'in_progress', worker_id: 3 }
      ],
      onUpsert: (rows) => { upsertedStatus = rows; }
    }
  });

  const store = new SupabaseStore({ client });

  // Read
  const statusObj = await store.read('scan-status', {});
  assert.equal(statusObj.summary.total, 4);
  assert.equal(statusObj.summary.completed, 1);
  assert.equal(statusObj.summary.skipped, 1);
  assert.equal(statusObj.summary.failed, 1);
  assert.equal(statusObj.summary.inProgress, 1);
  assert.ok(statusObj.jobs.job_1);

  // Write
  await store.write('scan-status', {
    jobs: {
      job_5: { job_key: 'job_5', job_url: 'https://job5', status: 'completed', attempt: 1 }
    }
  });

  assert.equal(upsertedStatus.length, 1);
  assert.equal(upsertedStatus[0].job_key, 'job_5');
  assert.equal(upsertedStatus[0].status, 'completed');
});

test('SupabaseStore handles clients and run_logs read/write', async () => {
  let upsertedClients = null;
  let insertedRuns = null;

  const client = createMockSupabaseClient({
    clients: {
      selectData: [
        {
          applywizz_id: 'AWL-10',
          full_name: 'Bob',
          profile: { client: { full_name: 'Bob', personal_email: 'bob@example.com' } }
        }
      ],
      onUpsert: (rows) => { upsertedClients = rows; }
    },
    run_logs: {
      selectData: [
        {
          event_id: 'evt_1',
          type: 'phase1.auth_success',
          at: '2026-11-09T01:00:00Z',
          payload: { eventId: 'evt_1', type: 'phase1.auth_success' }
        }
      ],
      onInsert: (rows) => { insertedRuns = rows; }
    }
  });

  const store = new SupabaseStore({ client });

  // Clients Read & Write
  const clients = await store.read('clients', {});
  assert.ok(clients['AWL-10']);
  assert.equal(clients['AWL-10'].client.full_name, 'Bob');

  await store.write('clients', {
    'AWL-20': { client: { full_name: 'Charlie', personal_email: 'charlie@test.com' } }
  });
  assert.equal(upsertedClients.length, 1);
  assert.equal(upsertedClients[0].applywizz_id, 'AWL-20');

  // Runs Read & Write
  const runs = await store.read('runs', []);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].eventId, 'evt_1');

  await store.write('runs', [
    { eventId: 'evt_1', type: 'phase1.auth_success' },
    { eventId: 'evt_2', type: 'phase2.scan_success', at: '2026-11-09T01:05:00Z' }
  ]);
  assert.equal(insertedRuns.length, 1);
  assert.equal(insertedRuns[0].event_id, 'evt_2');
});

test('SupabaseStore.loadQuestionBank() and upsertQuestionBank() manage Q&A memory', async () => {
  let upsertedQB = null;

  const client = createMockSupabaseClient({
    question_bank: {
      selectData: [
        {
          id: 'uuid-1',
          applywizz_id: 'AWL-100',
          question_label: 'Are you legally authorized to work in the United States?',
          field_type: 'radio',
          value: 'Yes',
          source: 'manual',
          confidence: 1.0,
          created_at: '2026-11-09T00:00:00Z'
        },
        {
          id: 'uuid-2',
          applywizz_id: 'AWL-200',
          question_label: 'Years of Python experience',
          field_type: 'number',
          value: '5',
          source: 'ai',
          confidence: 0.95,
          created_at: '2026-11-09T00:00:00Z'
        }
      ],
      onUpsert: (rows) => { upsertedQB = rows; }
    }
  });

  const store = new SupabaseStore({ client });

  // Load question bank
  const { clientHistoryMap, globalHistory } = await store.loadQuestionBank();
  assert.equal(globalHistory.length, 2);
  assert.ok(clientHistoryMap.has('AWL-100'));
  assert.equal(clientHistoryMap.get('AWL-100')[0].value, 'Yes');
  assert.ok(clientHistoryMap.has('AWL-200'));

  // Upsert into question bank
  await store.upsertQuestionBank([
    {
      applywizz_id: 'AWL-100',
      question_label: 'Will you now or in the future require sponsorship?',
      field_type: 'radio',
      value: 'No',
      source: 'manual',
      confidence: 1.0
    }
  ]);

  assert.equal(upsertedQB.length, 1);
  assert.equal(upsertedQB[0].applywizz_id, 'AWL-100');
  assert.equal(upsertedQB[0].value, 'No');
});

test('SupabaseStore.update() atomically updates state in Supabase', async () => {
  let savedApps = null;

  const client = createMockSupabaseClient({
    applications: {
      selectData: [
        {
          application_id: 'app_atomic',
          applywizz_id: 'AWL-ATOMIC',
          job_key: 'job_atomic',
          status: 'needs_input',
          values: {}
        }
      ],
      onUpsert: (rows) => { savedApps = rows; }
    }
  });

  const store = new SupabaseStore({ client });

  const updated = await store.update('applications', [], current => {
    return current.map(app => ({
      ...app,
      status: 'answers_resolved',
      values: { ...app.values, approved: true }
    }));
  });

  assert.equal(updated.length, 1);
  assert.equal(updated[0].status, 'answers_resolved');
  assert.equal(savedApps.length, 1);
  assert.equal(savedApps[0].status, 'answers_resolved');
});

test('SupabaseStore gracefully returns fallback on query error', async () => {
  const client = createMockSupabaseClient({
    jobs: {
      selectError: new Error('PostgreSQL connection timeout')
    }
  });

  const store = new SupabaseStore({ client });
  const result = await store.read('jobs', { uniqueJobs: ['fallback'] });
  assert.deepEqual(result, { uniqueJobs: ['fallback'] });
});
