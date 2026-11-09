import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { workflow } from './workflow.js';
import { seedReconData } from './seed.js';
import { parseOracleJobUrl } from './shared/url.js';
import { syncClients } from '../scripts/fetch_clients.mjs';

export async function computeDashboardMetrics({ jobs, applications, templates, clientsPath }) {
  let clientsData = {};
  try {
    if (clientsPath && fs.existsSync(clientsPath)) {
      clientsData = JSON.parse(await fs.promises.readFile(clientsPath, 'utf8'));
    }
  } catch {}

  const totalClients = Object.keys(clientsData).length;
  const assignments = jobs.assignments || [];
  const uniqueJobs = jobs.uniqueJobs || [];
  const totalJobs = assignments.length;
  const uniqueUrls = uniqueJobs.length;

  const scannedTemplates = Object.entries(templates).filter(([, t]) => (t.fields?.length || 0) > 0);
  const scannedJobKeys = new Set(scannedTemplates.map(([k]) => k));
  const scannedUrls = scannedJobKeys.size;

  // Potential unlockable applications covered by scanned unique requisitions
  const unlockableApplications = assignments.filter(a =>
    scannedJobKeys.has(a.jobKey) || scannedJobKeys.has(a.jobId)
  ).length;

  let resolvedPreAiApps = 0;
  let resolvedPreAiQuestions = 0;
  let resolvedWithAiApps = 0;
  let resolvedWithAiQuestions = 0;
  let dashboardReviewApps = 0;
  let dashboardReviewQuestions = 0;
  let readyToApply = 0;
  let prepared = 0;
  let submitted = 0;

  for (const app of applications) {
    if (app.status === 'submitted') submitted++;
    else if (app.status === 'needs_review') prepared++;
    else if (app.status === 'answers_resolved' || app.reviewStatus === 'approved') readyToApply++;
    else if (app.status === 'needs_input') dashboardReviewApps++;

    let hasAi = false;

    for (const [, val] of Object.entries(app.values || {})) {
      if (!val || val.value === null || val.value === '' || (val.confidence ?? 0) < 0.80) {
        dashboardReviewQuestions++;
      } else if (val.stage === 'stage4_llm' || val.source === 'tier2_claude_llm') {
        resolvedWithAiQuestions++;
        hasAi = true;
      } else {
        resolvedPreAiQuestions++;
      }
    }

    if (app.status === 'answers_resolved') {
      if (hasAi) resolvedWithAiApps++;
      else resolvedPreAiApps++;
    }
  }

  // Unique clients and assignments for cascading filter
  const clientMap = new Map();
  for (const a of assignments) {
    const id = a.applywizzId || a.userId;
    if (id && !clientMap.has(id)) {
      clientMap.set(id, {
        applywizzId: id,
        clientName: a.clientName || clientsData[id]?.client?.full_name || id
      });
    }
  }
  const clientsList = [...clientMap.values()].sort((a, b) => a.clientName.localeCompare(b.clientName));

  return {
    metrics: {
      totalClients,
      totalJobs,
      uniqueUrls,
      scannedUrls,
      unlockableApplications,
      resolvedPreAiApps,
      resolvedPreAiQuestions,
      resolvedWithAiApps,
      resolvedWithAiQuestions,
      dashboardReviewApps,
      dashboardReviewQuestions,
      readyToApply,
      prepared,
      submitted
    },
    clients: clientsList
  };
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// Static file hosting for production Vite React dashboard build
const distDir = path.resolve(config.rootDir, 'web/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.get('/api/health', (_request, response) => response.json({ ok: true }));

// Sync exact jobs from oracle_jobs to jobs in Supabase
app.post('/api/jobs/sync', async (_request, response, next) => {
  try {
    const result = await workflow.phase1.syncJobsFromOracleJobs();
    response.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Sync candidate profiles & resumes from external API
let isClientSyncing = false;
app.post('/api/clients/sync', async (_request, response) => {
  if (isClientSyncing) {
    return response.status(409).json({ error: 'Client synchronization already in progress' });
  }
  isClientSyncing = true;
  response.status(202).json({ success: true, message: 'Client synchronization started in background' });

  syncClients({ store: workflow.store })
    .catch(err => console.error('[ClientSync Error]:', err.message))
    .finally(() => { isClientSyncing = false; });
});

// Launch scoped scanner queue in background
app.post('/api/scan/queue', async (request, response) => {
  if (workflow.scanQueue.isScanning) {
    return response.status(409).json({ error: 'Scan queue is already in progress' });
  }
  const options = request.body || {};
  response.status(202).json({ success: true, message: 'Scanner queue started in background', options });

  workflow.scanQueue.runQueue(options)
    .then(async () => {
      // Auto-resolve applications for newly scanned templates
      await workflow.phase3.createOrResolveApplications().catch(() => {});
    })
    .catch(err => console.error('[Scanner Queue Error]:', err.message));
});

// Real-time worker slots & scanner queue status
app.get('/api/scan/status', async (_request, response) => {
  const workerStatus = workflow.scanQueue.getWorkerStatus();
  const scanStatus = await workflow.store.read('scan-status', {});
  response.json({
    ...workerStatus,
    summary: scanStatus.summary || {},
    updatedAt: scanStatus.updatedAt
  });
});

// Cancel active scanner queue
app.post('/api/scan/cancel', (_request, response) => {
  const cancelled = workflow.scanQueue.cancelQueue();
  response.json({ success: cancelled, message: cancelled ? 'Cancel signal sent to workers' : 'No active queue to cancel' });
});

app.get('/api/dashboard', async (_request, response) => {
  const [jobs, applications, templates, runs] = await Promise.all([
    workflow.store.read('jobs', { assignments: [], uniqueJobs: [] }),
    workflow.store.read('applications', []),
    workflow.store.read('form-templates', {}),
    workflow.store.read('runs', [])
  ]);

  const { metrics, clients } = await computeDashboardMetrics({
    jobs,
    applications,
    templates,
    clientsPath: config.clientsPath
  });

  response.json({
    jobs,
    applications,
    templates,
    runs: runs.slice(-100).reverse(),
    metrics,
    clients,
    submissionStatus: workflow.submissionQueue.getStatus()
  });
});

app.get('/api/submission/status', (_request, response) => {
  response.json(workflow.submissionQueue.getStatus());
});

app.post('/api/seed', async (_request, response) => response.json(await seedReconData()));

app.post('/api/ingest', async (request, response) => {
  response.json(await workflow.phase1.ingestCsv(request.body.csvPath ?? config.jobsCsvPath));
});

app.post('/api/auth', async (request, response) => {
  const { target, email = config.testEmail } = request.body;
  if (!target) return response.status(400).json({ error: 'target (jobId or url) is required' });
  if (!email) return response.status(400).json({ error: 'email is required' });

  let job;
  if (target.startsWith('http://') || target.startsWith('https://')) {
    const parsed = parseOracleJobUrl(target);
    job = {
      jobId: parsed.sourceJobId,
      canonicalUrl: parsed.canonicalUrl,
      tenantHost: parsed.tenantHost,
      tenantKey: parsed.tenantKey
    };
  } else {
    const jobs = await workflow.store.read('jobs', { uniqueJobs: [] });
    job = jobs.uniqueJobs.find(item => item.jobId === target);
    if (!job) return response.status(404).json({ error: `Job ${target} not found` });
  }

  const { session, result } = await workflow.phase1.authenticate({
    applicationId: `manual-auth-${job.jobId}`,
    job,
    email
  });
  try {
    if (result?.status === 'skipped') {
      return response.json({
        success: false,
        skipped: true,
        reason: result.reason,
        message: result.message,
        jobId: job.jobId
      });
    }
    response.json({
      success: true,
      jobId: job.jobId,
      tenantHost: job.tenantHost,
      authenticatedUrl: result.url,
      authenticatedAt: result.authenticatedAt
    });
  } finally {
    if (session) await workflow.oracle.closeSession(session);
  }
});

app.post('/api/jobs/:jobId/scan', async (request, response) => {
  const jobs = await workflow.store.read('jobs', { uniqueJobs: [] });
  const job = jobs.uniqueJobs.find(item => item.jobId === request.params.jobId);
  if (!job) return response.status(404).json({ error: 'Job not found' });
  const email = request.body.email ?? config.testEmail;
  if (!email) return response.status(400).json({ error: 'Scanner email is required' });
  const { session, result } = await workflow.phase1.authenticate({ applicationId: `scan-${job.jobId}`, job, email });
  try {
    if (result?.status === 'skipped') {
      return response.json({
        skipped: true,
        reason: result.reason,
        message: result.message,
        jobId: job.jobId
      });
    }
    const template = await workflow.phase2.scan({ session, job });
    await workflow.phase3.createOrResolveApplications();
    response.json(template);
  } finally {
    if (session) await workflow.oracle.closeSession(session);
  }
});

app.post('/api/resolve', async (request, response, next) => {
  try {
    const options = request.body || {};
    response.json(await workflow.phase3.createOrResolveApplications(options));
  } catch (err) {
    next(err);
  }
});

app.put('/api/applications/:applicationId/answers', async (request, response) => {
  response.json(await workflow.phase3.saveAnswers(request.params.applicationId, request.body.updates ?? {}));
});

app.post('/api/applications/:applicationId/prepare', async (request, response) => {
  response.json(await workflow.submissionQueue.enqueueApplication(request.params.applicationId));
});

app.post('/api/applications/:applicationId/approve', async (request, response) => {
  response.json(await workflow.phase4.approve(request.params.applicationId));
});

app.post('/api/applications/:applicationId/submit', async (request, response) => {
  response.json(await workflow.submissionQueue.submitApplication(request.params.applicationId, request.body.confirmation));
});

// SPA fallback for React Dashboard routes
app.use((request, response, next) => {
  if (request.method !== 'GET' || request.path.startsWith('/api')) return next();
  const indexHtml = path.resolve(distDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    return response.sendFile(indexHtml);
  }
  next();
});

app.use((error, _request, response, _next) => {
  console.error(error.code ?? error.name, error.message);
  response.status(error.code ? 400 : 500).json({
    error: error.message,
    code: error.code ?? 'INTERNAL_ERROR',
    details: error.details ?? {}
  });
});

import { fileURLToPath } from 'node:url';

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  if (config.submission?.submitDir) fs.mkdirSync(config.submission.submitDir, { recursive: true });
  if (config.submission?.resumeDir) fs.mkdirSync(config.submission.resumeDir, { recursive: true });
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Oracle application workflow listening on http://0.0.0.0:${config.port}`);
  });
}
