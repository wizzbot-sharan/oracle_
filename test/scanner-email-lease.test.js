import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanQueueRunner } from '../src/phases/scan-queue.js';

test('ScanQueueRunner email allocation rotates across workers and tenants with active leases', () => {
  const runner = new ScanQueueRunner({
    store: null,
    runLog: null,
    oracle: null,
    phase1: null,
    phase2: null,
    config: {}
  });

  const emails = [
    'email_1@applywizard.ai',
    'email_2@applywizard.ai',
    'email_3@applywizard.ai'
  ];

  const tenantEmailIndex = new Map();
  const activeEmails = new Set();

  // 1. Initial parallel launch across 3 distinct tenants
  const emailW0 = runner._selectEmailForWorkerAndTenant({
    workerId: 0,
    tenantHost: 'tenant-a.oraclecloud.com',
    emails,
    tenantEmailIndex,
    activeEmails
  });
  const emailW1 = runner._selectEmailForWorkerAndTenant({
    workerId: 1,
    tenantHost: 'tenant-b.oraclecloud.com',
    emails,
    tenantEmailIndex,
    activeEmails
  });
  const emailW2 = runner._selectEmailForWorkerAndTenant({
    workerId: 2,
    tenantHost: 'tenant-c.oraclecloud.com',
    emails,
    tenantEmailIndex,
    activeEmails
  });

  // Verify each concurrent worker got a completely unique email
  assert.equal(emailW0, 'email_1@applywizard.ai');
  assert.equal(emailW1, 'email_2@applywizard.ai');
  assert.equal(emailW2, 'email_3@applywizard.ai');
  assert.equal(activeEmails.size, 3, 'All 3 emails should be leased');

  // 2. Active lease collision prevention: If Worker 0 tries to acquire another email while all 3 are leased
  const fallback = runner._selectEmailForWorkerAndTenant({
    workerId: 0,
    tenantHost: 'tenant-d.oraclecloud.com',
    emails,
    tenantEmailIndex,
    activeEmails
  });
  assert.ok(emails.includes(fallback));

  // Release Worker 1 email
  activeEmails.delete(emailW1);
  assert.equal(activeEmails.has('email_2@applywizard.ai'), false);

  // If another worker whose preferred email is email_1 requests an email, it should pick the free email_2
  const emailNew = runner._selectEmailForWorkerAndTenant({
    workerId: 0,
    tenantHost: 'tenant-e.oraclecloud.com',
    emails,
    tenantEmailIndex,
    activeEmails
  });
  assert.equal(emailNew, 'email_2@applywizard.ai');

  // 3. Successive visits to the same tenant rotate through emails
  const tenantVisitsIndex = new Map();
  const tenantLeases = new Set();

  const visit1 = runner._selectEmailForWorkerAndTenant({
    workerId: 0,
    tenantHost: 'repeat-tenant.oraclecloud.com',
    emails,
    tenantEmailIndex: tenantVisitsIndex,
    activeEmails: tenantLeases
  });
  tenantLeases.clear(); // Simulate worker completing job 1

  const visit2 = runner._selectEmailForWorkerAndTenant({
    workerId: 0,
    tenantHost: 'repeat-tenant.oraclecloud.com',
    emails,
    tenantEmailIndex: tenantVisitsIndex,
    activeEmails: tenantLeases
  });
  tenantLeases.clear(); // Simulate worker completing job 2

  const visit3 = runner._selectEmailForWorkerAndTenant({
    workerId: 0,
    tenantHost: 'repeat-tenant.oraclecloud.com',
    emails,
    tenantEmailIndex: tenantVisitsIndex,
    activeEmails: tenantLeases
  });

  assert.equal(visit1, 'email_1@applywizard.ai');
  assert.equal(visit2, 'email_2@applywizard.ai');
  assert.equal(visit3, 'email_3@applywizard.ai');
});
