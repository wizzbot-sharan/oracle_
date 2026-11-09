import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

export const BATCH_SIZE = 5;
export const BATCH_DELAY_MS = 2000;

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function buildClientUrl(baseUrl, applywizzId) {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('applywizz_id', applywizzId);
    return url.toString();
  } catch {
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}applywizz_id=${encodeURIComponent(applywizzId)}`;
  }
}

export async function fetchWithRetry(url, options = {}, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      if (attempt <= maxRetries) {
        const backoff = attempt * 1000;
        await sleep(backoff);
      } else {
        throw error;
      }
    }
  }
}

export function pruneInactiveClients(storedClients, activeIds) {
  const activeSet = new Set(activeIds);
  const pruned = [];
  for (const id of Object.keys(storedClients)) {
    if (!activeSet.has(id)) {
      delete storedClients[id];
      pruned.push(id);
    }
  }
  return pruned;
}

export function formatClientRecord(result) {
  return {
    client: result?.client ?? null,
    additional_information: result?.additional_information ?? null,
    ...Object.fromEntries(
      Object.entries(result || {}).filter(([k]) => k !== 'client' && k !== 'additional_information')
    )
  };
}

export async function syncClients({
  activeClientsUrl = process.env.ACTIVE_CLIENTS,
  getClientsUrl = process.env.GET_CLIENTS,
  outputFile = path.resolve('data/clients.json'),
  batchSize = BATCH_SIZE,
  batchDelayMs = BATCH_DELAY_MS,
  fetchFn = fetchWithRetry,
  store = null
} = {}) {
  console.log('=== Applywizz Client Fetcher & Synchronizer ===\n');

  if (!activeClientsUrl || !getClientsUrl) {
    const errorMsg = 'Error: ACTIVE_CLIENTS and GET_CLIENTS must be configured in your .env file.';
    console.error(errorMsg);
    console.error('Example:');
    console.error('  ACTIVE_CLIENTS=https://api.example.com/active-clients');
    console.error('  GET_CLIENTS=https://api.example.com/client\n');
    throw new Error(errorMsg);
  }

  try {
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
  } catch {}

  console.log(`[Step 1] Fetching active clients list from: ${activeClientsUrl}`);
  const activeData = await fetchFn(activeClientsUrl);
  const applywizzIds = activeData?.applywizz_ids || [];
  const totalReported = activeData?.count || applywizzIds.length;
  console.log(`✓ Received ${applywizzIds.length} active client IDs (Total reported: ${totalReported})\n`);

  // Load existing clients if file exists or from store
  let clients = {};
  if (store?.isAvailable?.()) {
    try {
      clients = await store.read('clients', {});
      console.log(`ℹ Found ${Object.keys(clients).length} recorded clients in Supabase.`);
    } catch {}
  } else {
    try {
      const existingContent = await fs.readFile(outputFile, 'utf8');
      clients = JSON.parse(existingContent);
      console.log(`ℹ Found existing ${outputFile} with ${Object.keys(clients).length} recorded clients.`);
    } catch {
      clients = {};
    }
  }

  // Prune inactive clients not in the active list
  const prunedIds = pruneInactiveClients(clients, applywizzIds);
  if (prunedIds.length > 0) {
    console.log(`✂ [Reconciliation] Pruned ${prunedIds.length} inactive client(s) no longer in active list: ${prunedIds.join(', ')}`);
    // Save immediate pruning state
    await fs.writeFile(outputFile, JSON.stringify(clients, null, 2), 'utf8');
  } else {
    console.log(`✓ [Reconciliation] No inactive clients needed pruning.`);
  }

  if (!applywizzIds.length) {
    console.warn('No active applywizz_ids returned from API.');
    return { total: 0, successCount: 0, failureCount: 0, prunedCount: prunedIds.length, clients };
  }

  console.log(`\n[Step 2] Fetching client details in batches of ${batchSize} (${batchDelayMs}ms pause between batches)...\n`);

  const totalBatches = Math.ceil(applywizzIds.length / batchSize);
  let successCount = 0;
  let failureCount = 0;

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startIndex = batchIndex * batchSize;
    const batchIds = applywizzIds.slice(startIndex, startIndex + batchSize);
    const batchNum = batchIndex + 1;

    console.log(`--- [Batch ${batchNum}/${totalBatches}] Processing ${batchIds.length} IDs (${batchIds.join(', ')}) ---`);

    await Promise.all(
      batchIds.map(async (id) => {
        const clientUrl = buildClientUrl(getClientsUrl, id);
        try {
          const result = await fetchFn(clientUrl);
          const freshData = formatClientRecord(result);

          const isUpdate = Boolean(clients[id]);
          clients[id] = freshData;

          const fullName = freshData.client?.full_name ? `(${freshData.client.full_name})` : '';
          console.log(`  ✓ [${id}] ${isUpdate ? 'Upserted' : 'Inserted'} successfully ${fullName}`);
          successCount++;
        } catch (error) {
          console.error(`  ✖ [${id}] Error fetching client: ${error.message}`);
          if (!clients[id]) {
            clients[id] = {
              error: error.message,
              failedAt: new Date().toISOString()
            };
          } else {
            console.warn(`    ↳ Retained previous data for ${id}`);
          }
          failureCount++;
        }
      })
    );

    // Save incrementally after every batch
    if (store?.isAvailable?.()) {
      try {
        await store.write('clients', clients);
      } catch (err) {
        console.warn(`[ClientSync] Supabase write warning: ${err.message}`);
      }
    }
    try {
      await fs.writeFile(outputFile, JSON.stringify(clients, null, 2), 'utf8');
    } catch {}

    // Wait 2 seconds before the next batch if more remain
    if (batchIndex < totalBatches - 1) {
      console.log(`  ⏳ Pausing ${batchDelayMs / 1000}s before next batch...\n`);
      await sleep(batchDelayMs);
    }
  }

  console.log('\n==============================================');
  console.log(`Synchronization Complete!`);
  console.log(`Active IDs processed: ${applywizzIds.length}`);
  console.log(`Success in this run:  ${successCount}`);
  console.log(`Failures in this run: ${failureCount}`);
  console.log(`Inactive Pruned:      ${prunedIds.length}`);
  console.log(`Total active stored:  ${Object.keys(clients).length}`);
  console.log(`Saved to:             ${outputFile}`);
  console.log('==============================================\n');

  return {
    total: applywizzIds.length,
    successCount,
    failureCount,
    prunedCount: prunedIds.length,
    clients
  };
}

// Auto-run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const customOutputFile = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('data/clients.json');
  syncClients({ outputFile: customOutputFile }).catch(error => {
    console.error('Fatal error:', error.message);
    process.exit(1);
  });
}
