import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  pruneInactiveClients,
  formatClientRecord,
  buildClientUrl,
  syncClients
} from '../scripts/fetch_clients.mjs';

test('buildClientUrl properly adds applywizz_id as query parameter', () => {
  const url1 = buildClientUrl('https://api.example.com/client', 'AWL-1234');
  assert.equal(url1, 'https://api.example.com/client?applywizz_id=AWL-1234');

  const url2 = buildClientUrl('https://api.example.com/client?auth=token', 'AWL-5678');
  assert.equal(url2, 'https://api.example.com/client?auth=token&applywizz_id=AWL-5678');
});

test('pruneInactiveClients removes clients not present in the active list', () => {
  const stored = {
    'AWL-ACTIVE-1': { client: { full_name: 'Active One' } },
    'AWL-INACTIVE-2': { client: { full_name: 'Inactive Two' } },
    'AWL-ACTIVE-3': { client: { full_name: 'Active Three' } },
    'AWL-INACTIVE-4': { client: { full_name: 'Inactive Four' } }
  };

  const activeIds = ['AWL-ACTIVE-1', 'AWL-ACTIVE-3', 'AWL-NEW-5'];
  const pruned = pruneInactiveClients(stored, activeIds);

  assert.deepEqual(pruned.sort(), ['AWL-INACTIVE-2', 'AWL-INACTIVE-4']);
  assert.equal('AWL-ACTIVE-1' in stored, true);
  assert.equal('AWL-ACTIVE-3' in stored, true);
  assert.equal('AWL-INACTIVE-2' in stored, false);
  assert.equal('AWL-INACTIVE-4' in stored, false);
});

test('formatClientRecord captures both client and additional_information', () => {
  const apiPayload = {
    client: {
      id: 'uuid-1',
      full_name: 'Kalyani Lakkaram',
      company_email: 'kalyani@applywizard.ai'
    },
    additional_information: {
      id: 'uuid-1',
      highest_education: 'Master’s Degree',
      resume_url: 'https://s3.example.com/resume.pdf'
    },
    status: 'success'
  };

  const formatted = formatClientRecord(apiPayload);
  assert.deepEqual(formatted.client, apiPayload.client);
  assert.deepEqual(formatted.additional_information, apiPayload.additional_information);
  assert.equal(formatted.status, 'success');
});

test('syncClients prunes inactive clients and upserts fresh client + additional_information', async () => {
  const tmpDir = path.join(os.tmpdir(), 'test-sync-' + Date.now());
  const testFile = path.join(tmpDir, 'clients.json');
  await fs.mkdir(tmpDir, { recursive: true });

  // Initial file state: has an active client with OLD info, and an inactive client
  const initialData = {
    'AWL-OLD-ACTIVE': {
      client: { full_name: 'Old Name', company_email: 'old@applywizard.ai' },
      additional_information: { highest_education: 'Bachelor’s Degree' }
    },
    'AWL-OBSOLETE': {
      client: { full_name: 'Obsolete User' }
    }
  };
  await fs.writeFile(testFile, JSON.stringify(initialData, null, 2), 'utf8');

  // Mock API responses
  const activeApiResponse = {
    count: 2,
    applywizz_ids: ['AWL-OLD-ACTIVE', 'AWL-BRAND-NEW']
  };

  const clientDetails = {
    'AWL-OLD-ACTIVE': {
      client: { full_name: 'Updated Name', company_email: 'updated@applywizard.ai' },
      additional_information: { highest_education: 'PhD Degree', resume_url: 'https://s3/new.pdf' }
    },
    'AWL-BRAND-NEW': {
      client: { full_name: 'Brand New User', company_email: 'new@applywizard.ai' },
      additional_information: { highest_education: 'Master’s Degree' }
    }
  };

  const mockFetch = async (url) => {
    if (url.includes('active-clients')) return activeApiResponse;
    const match = url.match(/applywizz_id=([^&]+)/);
    const id = match ? decodeURIComponent(match[1]) : null;
    if (id && clientDetails[id]) return clientDetails[id];
    throw new Error(`Not found: ${url}`);
  };

  const result = await syncClients({
    activeClientsUrl: 'https://api.example.com/active-clients',
    getClientsUrl: 'https://api.example.com/client',
    outputFile: testFile,
    batchSize: 5,
    batchDelayMs: 0,
    fetchFn: mockFetch
  });

  assert.equal(result.total, 2);
  assert.equal(result.successCount, 2);
  assert.equal(result.prunedCount, 1);

  // Read back the saved file
  const savedClients = JSON.parse(await fs.readFile(testFile, 'utf8'));

  // Obsolete client must be pruned
  assert.equal('AWL-OBSOLETE' in savedClients, false);

  // Old active client must be replaced with fresh data
  assert.equal(savedClients['AWL-OLD-ACTIVE'].client.full_name, 'Updated Name');
  assert.equal(savedClients['AWL-OLD-ACTIVE'].additional_information.highest_education, 'PhD Degree');

  // New client must be inserted
  assert.equal(savedClients['AWL-BRAND-NEW'].client.full_name, 'Brand New User');
  assert.equal(savedClients['AWL-BRAND-NEW'].additional_information.highest_education, 'Master’s Degree');

  // Clean up test file
  await fs.rm(tmpDir, { recursive: true, force: true });
});
