import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CA_EMAILS_URL = 'https://applywizz-ca-management.vercel.app/api/ca/emails';
export const CA_MAPPINGS_URL = 'https://client-ca-mapping.up.railway.app/api/ca-mappings';

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
        await new Promise(r => setTimeout(r, attempt * 1000));
      } else {
        throw error;
      }
    }
  }
}

export function escapeCsvField(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

export function formatCasAsCsv(users = []) {
  const header = 'id,name,email,role';
  const rows = users.map(u => [
    escapeCsvField(u.id),
    escapeCsvField(u.name),
    escapeCsvField(u.email),
    escapeCsvField(u.role)
  ].join(','));
  return [header, ...rows].join('\n') + '\n';
}

export async function syncCAs(options = {}) {
  const dataDir = options.dataDir || path.resolve(process.cwd(), 'data');
  const caCsvPath = path.join(dataDir, 'ca.csv');
  const caMappingsPath = path.join(dataDir, 'ca-mappings.json');

  console.log('[Sync CAs] Fetching CA list from API...');
  const caResponse = await fetchWithRetry(CA_EMAILS_URL);
  const users = caResponse.users || [];
  console.log(`[Sync CAs] Fetched ${users.length} CAs.`);

  console.log('[Sync CAs] Fetching CA-client mappings from API...');
  const mappingsResponse = await fetchWithRetry(CA_MAPPINGS_URL);
  const mappingData = mappingsResponse.data || [];
  console.log(`[Sync CAs] Fetched mappings for ${mappingData.length} CAs with ${mappingsResponse.total_assigned_clients || 0} assigned clients.`);

  // Write ca.csv
  const csvContent = formatCasAsCsv(users);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(caCsvPath, csvContent, 'utf8');
  console.log(`[Sync CAs] Saved CA list to ${caCsvPath}`);

  // Create lookup maps
  const clientToCaMap = {};
  for (const ca of mappingData) {
    for (const client of (ca.clients || [])) {
      if (client.applywizz_id) {
        clientToCaMap[client.applywizz_id] = {
          caId: ca.ca_id,
          caName: ca.ca_name,
          caEmail: ca.ca_email,
          assignmentType: client.assignment_type || 'permanent'
        };
      }
    }
  }

  // Merge mapping data with full users list to ensure every CA is accounted for
  const caMapById = new Map();
  for (const ca of mappingData) {
    caMapById.set(ca.ca_id, {
      id: ca.ca_id,
      name: ca.ca_name,
      email: ca.ca_email,
      role: 'CA',
      clientCount: ca.client_count || ca.clients?.length || 0,
      clients: ca.clients || []
    });
  }

  for (const user of users) {
    if (!caMapById.has(user.id)) {
      caMapById.set(user.id, {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role || 'CA',
        clientCount: 0,
        clients: []
      });
    } else {
      const existing = caMapById.get(user.id);
      existing.role = user.role || existing.role;
    }
  }

  const enrichedCas = [...caMapById.values()].sort((a, b) => {
    // Sort active CAs first (highest client count), then alphabetically
    if (b.clientCount !== a.clientCount) {
      return b.clientCount - a.clientCount;
    }
    return a.name.localeCompare(b.name);
  });

  const outputMappings = {
    updatedAt: new Date().toISOString(),
    totalCas: enrichedCas.length,
    totalAssignedClients: Object.keys(clientToCaMap).length,
    cas: enrichedCas,
    clientToCaMap
  };

  await fs.writeFile(caMappingsPath, JSON.stringify(outputMappings, null, 2), 'utf8');
  console.log(`[Sync CAs] Saved CA mappings to ${caMappingsPath}`);

  return {
    success: true,
    totalCas: enrichedCas.length,
    totalAssignedClients: outputMappings.totalAssignedClients
  };
}

// CLI Execution entrypoint
const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  syncCAs()
    .then(res => {
      console.log('[Sync CAs] Completed successfully:', res);
      process.exit(0);
    })
    .catch(err => {
      console.error('[Sync CAs] Failed:', err);
      process.exit(1);
    });
}
