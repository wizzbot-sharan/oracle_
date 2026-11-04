import express from 'express';
import { config } from './config.js';
import { workflow } from './workflow.js';
import { seedReconData } from './seed.js';
import { parseOracleJobUrl } from './shared/url.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_request, response) => response.json({ ok: true }));

app.get('/api/dashboard', async (_request, response) => {
  const [jobs, applications, templates, runs] = await Promise.all([
    workflow.store.read('jobs', { assignments: [], uniqueJobs: [] }),
    workflow.store.read('applications', []),
    workflow.store.read('form-templates', {}),
    workflow.store.read('runs', [])
  ]);
  response.json({ jobs, applications, templates, runs: runs.slice(-100).reverse() });
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

app.post('/api/resolve', async (_request, response) => response.json(await workflow.phase3.createOrResolveApplications()));

app.put('/api/applications/:applicationId/answers', async (request, response) => {
  response.json(await workflow.phase3.saveAnswers(request.params.applicationId, request.body.updates ?? {}));
});

app.post('/api/applications/:applicationId/prepare', async (request, response) => {
  response.json(await workflow.phase4.prepare(request.params.applicationId));
});

app.post('/api/applications/:applicationId/approve', async (request, response) => {
  response.json(await workflow.phase4.approve(request.params.applicationId));
});

app.post('/api/applications/:applicationId/submit', async (request, response) => {
  response.json(await workflow.phase4.submit(request.params.applicationId, request.body.confirmation));
});

app.use((error, _request, response, _next) => {
  console.error(error.code ?? error.name, error.message);
  response.status(error.code ? 400 : 500).json({
    error: error.message,
    code: error.code ?? 'INTERNAL_ERROR',
    details: error.details ?? {}
  });
});

app.listen(config.port, () => {
  console.log(`Oracle application workflow listening on http://localhost:${config.port}`);
});
