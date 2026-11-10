import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { seedReconData } from './seed.js';
import { workflow } from './workflow.js';
import { parseOracleJobUrl } from './shared/url.js';
import { parseCsv } from './shared/csv.js';

let [command, ...args] = process.argv.slice(2);

// If a URL is passed directly as the first argument, default to the 'scan' command
if (command && (command.startsWith('http://') || command.startsWith('https://'))) {
  args = [command, ...args];
  command = 'scan';
}

async function jobById(target) {
  const storeData = await workflow.store.read('jobs', { uniqueJobs: [], assignments: [] });
  let jobRecord = (storeData.uniqueJobs ?? []).find(
    item => item.jobKey === target || item.jobId === target || item.sourceJobId === target
  );
  if (!jobRecord) {
    jobRecord = (storeData.assignments ?? []).find(
      item => item.jobKey === target || item.jobId === target || item.sourceJobId === target
    );
  }

  if (!jobRecord) {
    try {
      const csvPath = path.resolve(config.jobsCleanCsvPath ?? 'data/jobs.csv');
      const rawCsv = await fs.readFile(csvPath, 'utf8');
      const rows = parseCsv(rawCsv);
      const row = rows.find(r => r.job_key === target || r.job_url?.includes(target));
      if (row) {
        jobRecord = {
          jobKey: row.job_key,
          jobUrl: row.job_url,
          jobId: row.job_key
        };
      }
    } catch {
      // Ignore if jobs.csv does not exist
    }
  }

  if (!jobRecord) {
    throw new Error(`Unknown job "${target}"; verify that the jobKey exists in data/jobs.csv or data/jobs.json`);
  }

  const rawUrl = jobRecord.canonicalUrl || jobRecord.jobUrl || jobRecord.originalUrl;
  let parsed = {};
  if (rawUrl) {
    try {
      parsed = parseOracleJobUrl(rawUrl);
    } catch {
      // Ignore non-standard url
    }
  }

  return {
    ...jobRecord,
    jobKey: jobRecord.jobKey || target,
    jobId: parsed.sourceJobId || jobRecord.sourceJobId || jobRecord.jobId || target,
    sourceJobId: parsed.sourceJobId || jobRecord.sourceJobId,
    canonicalUrl: parsed.canonicalUrl || rawUrl,
    tenantHost: parsed.tenantHost || jobRecord.tenantHost,
    tenantKey: parsed.tenantKey || jobRecord.tenantKey
  };
}

async function main() {
  if (command === 'seed') return seedReconData();
  if (command === 'ingest') return workflow.phase1.ingestCsv(args[0] ?? config.jobsCsvPath);
  if (command === 'auth') {
    let target;
    let email;
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '--job' || args[i] === '--jobKey' || args[i] === '-j') && args[i + 1]) {
        target = args[i + 1];
        i++;
      } else if ((args[i] === '--email' || args[i] === '-e') && args[i + 1]) {
        email = args[i + 1];
        i++;
      } else if (!target && !args[i].startsWith('-')) {
        target = args[i];
      } else if (!email && !args[i].startsWith('-')) {
        email = args[i];
      }
    }
    target = target ?? '20283127';
    email = email ?? config.testEmail;
    if (!email) throw new Error('Email is required (pass as second argument or set TEST_EMAIL in .env)');

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
      job = await jobById(target);
    }

    console.error(`Starting manual authentication for job ${job.jobKey || job.jobId} (${job.tenantHost}) using email: ${email}`);
    const { session, result } = await workflow.phase1.authenticate({
      applicationId: `manual-auth-${job.jobKey || job.jobId}`,
      job,
      email
    });
    try {
      if (result?.status === 'skipped') {
        return {
          success: false,
          skipped: true,
          reason: result.reason,
          message: result.message,
          jobKey: job.jobKey,
          jobId: job.jobId,
          tenantHost: job.tenantHost
        };
      }
      return {
        success: true,
        jobKey: job.jobKey,
        jobId: job.jobId,
        tenantHost: job.tenantHost,
        authenticatedUrl: result.url,
        authenticatedAt: result.authenticatedAt
      };
    } finally {
      if (session) await workflow.oracle.closeSession(session);
    }
  }
  if (command === 'scan') {
    let target;
    let email;
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '--job' || args[i] === '--jobKey' || args[i] === '-j') && args[i + 1]) {
        target = args[i + 1];
        i++;
      } else if ((args[i] === '--email' || args[i] === '-e') && args[i + 1]) {
        email = args[i + 1];
        i++;
      } else if (!target && !args[i].startsWith('-')) {
        target = args[i];
      } else if (!email && !args[i].startsWith('-')) {
        email = args[i];
      }
    }
    target = target ?? '20283127';
    email = email ?? config.testEmail;
    if (!email) throw new Error('Email is required (pass as second argument or set TEST_EMAIL in .env)');

    let job;
    if (target.startsWith('http://') || target.startsWith('https://')) {
      const parsed = parseOracleJobUrl(target);
      job = {
        jobId: parsed.sourceJobId,
        canonicalUrl: parsed.canonicalUrl,
        tenantHost: parsed.tenantHost,
        tenantKey: parsed.tenantKey
      };
      // Ensure the job is registered in the jobs store so Phase 3 creates an application instance for the dashboard
      await workflow.store.update('jobs', { assignments: [], uniqueJobs: [] }, current => {
        const unique = current.uniqueJobs ?? [];
        if (!unique.some(j => j.jobId === job.jobId)) unique.push(job);
        const assignments = current.assignments ?? [];
        if (!assignments.some(a => a.jobId === job.jobId)) {
          assignments.push({
            assignmentId: `asg-${job.jobId}`,
            userId: 'scanner-user',
            jobId: job.jobId,
            ...job
          });
        }
        return { assignments, uniqueJobs: unique };
      });
    } else {
      job = await jobById(target);
      // Ensure the job is registered in the jobs store so Phase 3 creates an application instance for the dashboard
      await workflow.store.update('jobs', { assignments: [], uniqueJobs: [] }, current => {
        const unique = current.uniqueJobs ?? [];
        if (!unique.some(j => (job.jobKey && j.jobKey === job.jobKey) || j.jobId === job.jobId)) unique.push(job);
        const assignments = current.assignments ?? [];
        if (!assignments.some(a => (job.jobKey && a.jobKey === job.jobKey) || a.jobId === job.jobId)) {
          assignments.push({
            assignmentId: `asg-${job.jobKey || job.jobId}`,
            userId: 'scanner-user',
            jobId: job.jobId,
            jobKey: job.jobKey,
            ...job
          });
        }
        return { assignments, uniqueJobs: unique };
      });
    }

    console.error(`Starting scan for job ${job.jobKey || job.jobId} (${job.tenantHost}) using email: ${email}`);
    const { session, result } = await workflow.phase1.authenticate({ applicationId: `scan-${job.jobKey || job.jobId}`, job, email });
    try {
      if (result?.status === 'skipped') {
        console.error(`[Phase 1] Job ${job.jobKey || job.jobId} skipped: ${result.reason} - ${result.message}`);
        return {
          skipped: true,
          reason: result.reason,
          message: result.message,
          jobKey: job.jobKey,
          jobId: job.jobId,
          tenantHost: job.tenantHost
        };
      }
      const template = await workflow.phase2.scan({ session, job });
      await workflow.phase3.createOrResolveApplications({ jobKey: job.jobKey });
      return {
        templateId: template.templateId,
        version: template.version,
        jobKey: template.jobKey || job.jobKey,
        jobId: template.source?.jobId ?? job.jobId,
        fields: template.fields.length,
        conditionalBranches: template.conditionalBranches.length,
        repeatableGroups: template.repeatableGroups.length,
        submitPresent: template.scan.submitPresent,
        artifactDir: template.scan.artifactDir
      };
    } finally {
      if (session) await workflow.oracle.closeSession(session);
    }
  }
  if (command === 'scan:queue') {
    let limit;
    let force = false;
    let jobKey;
    let range;
    let from;
    let to;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--limit' && args[i + 1]) {
        limit = Number(args[i + 1]);
        i++;
      } else if (args[i] === '--force') {
        force = true;
      } else if ((args[i] === '--job' || args[i] === '--jobs' || args[i] === '--jobKey' || args[i] === '-j') && args[i + 1]) {
        jobKey = jobKey ? `${jobKey},${args[i + 1]}` : args[i + 1];
        i++;
      } else if ((args[i] === '--range' || args[i] === '-r') && args[i + 1]) {
        range = args[i + 1];
        i++;
      } else if (args[i] === '--from' && args[i + 1]) {
        from = args[i + 1];
        i++;
      } else if (args[i] === '--to' && args[i + 1]) {
        to = args[i + 1];
        i++;
      } else if (!isNaN(Number(args[i]))) {
        limit = Number(args[i]);
      }
    }
    return workflow.scanQueue.runQueue({ limit, force, jobKey, range, from, to });
  }
  if (command === 'resolve' || command === 'resolve:answers') {
    let limit;
    let jobKey;
    let range;
    let from;
    let to;
    let client;
    let company;
    let force = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--limit' && args[i + 1]) {
        limit = Number(args[i + 1]);
        i++;
      } else if (args[i] === '--force' || args[i] === '-f') {
        force = true;
      } else if ((args[i] === '--job' || args[i] === '--jobs' || args[i] === '--jobKey' || args[i] === '-j') && args[i + 1]) {
        jobKey = jobKey ? `${jobKey},${args[i + 1]}` : args[i + 1];
        i++;
      } else if ((args[i] === '--range' || args[i] === '-r') && args[i + 1]) {
        range = args[i + 1];
        i++;
      } else if (args[i] === '--from' && args[i + 1]) {
        from = args[i + 1];
        i++;
      } else if (args[i] === '--to' && args[i + 1]) {
        to = args[i + 1];
        i++;
      } else if ((args[i] === '--client' || args[i] === '--user' || args[i] === '-c') && args[i + 1]) {
        client = args[i + 1];
        i++;
      } else if (args[i] === '--company' && args[i + 1]) {
        company = args[i + 1];
        i++;
      }
    }
    const applications = await workflow.phase3.createOrResolveApplications({
      limit,
      jobKey,
      range,
      from,
      to,
      client,
      company,
      force
    });
    return {
      scope: applications.batchSummary?.scope || 'All',
      batchSummary: applications.batchSummary,
      globalSummary: applications.globalSummary
    };
  }
  if (command === 'prepare') return workflow.phase4.prepare(args[0]);
  throw new Error('Usage: node src/cli.js <seed|ingest|auth [jobKey|jobId|url] [email]|scan [jobKey|jobId|url] [email]|scan:queue [--range N-M] [--jobs k1,k2] [--limit N] [--force]|resolve [--range N-M] [--jobs k1,k2] [--client ID] [--company name] [--limit N]|prepare applicationId>');
}

main()
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(JSON.stringify({ error: error.message, code: error.code, details: error.details }, null, 2));
    process.exitCode = 1;
  });
