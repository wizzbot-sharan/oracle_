import { config } from './config.js';
import { seedReconData } from './seed.js';
import { workflow } from './workflow.js';
import { parseOracleJobUrl } from './shared/url.js';

let [command, ...args] = process.argv.slice(2);

// If a URL is passed directly as the first argument, default to the 'scan' command
if (command && (command.startsWith('http://') || command.startsWith('https://'))) {
  args = [command, ...args];
  command = 'scan';
}

async function jobById(jobId) {
  const jobs = await workflow.store.read('jobs', { uniqueJobs: [] });
  const job = jobs.uniqueJobs.find(item => item.jobId === jobId);
  if (!job) throw new Error(`Unknown job ${jobId}; run npm run ingest first`);
  return job;
}

async function main() {
  if (command === 'seed') return seedReconData();
  if (command === 'ingest') return workflow.phase1.ingestCsv(args[0] ?? config.jobsCsvPath);
  if (command === 'resolve') return workflow.phase3.createOrResolveApplications();
  if (command === 'auth') {
    const target = args[0] ?? '20283127';
    const email = args[1] ?? config.testEmail;
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

    console.error(`Starting manual authentication for job ${job.jobId} (${job.tenantHost}) using email: ${email}`);
    const { session, result } = await workflow.phase1.authenticate({
      applicationId: `manual-auth-${job.jobId}`,
      job,
      email
    });
    try {
      return {
        success: true,
        jobId: job.jobId,
        tenantHost: job.tenantHost,
        authenticatedUrl: result.url,
        authenticatedAt: result.authenticatedAt
      };
    } finally {
      await workflow.oracle.closeSession(session);
    }
  }
  if (command === 'scan') {
    const target = args[0] ?? '20283127';
    const email = args[1] ?? config.testEmail;
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
    }

    console.error(`Starting scan for job ${job.jobId} (${job.tenantHost}) using email: ${email}`);
    const { session } = await workflow.phase1.authenticate({ applicationId: `scan-${job.jobId}`, job, email });
    try {
      const template = await workflow.phase2.scan({ session, job });
      await workflow.phase3.createOrResolveApplications();
      return {
        templateId: template.templateId,
        version: template.version,
        jobId: template.source.jobId,
        fields: template.fields.length,
        conditionalBranches: template.conditionalBranches.length,
        repeatableGroups: template.repeatableGroups.length,
        submitPresent: template.scan.submitPresent,
        artifactDir: template.scan.artifactDir
      };
    } finally {
      await workflow.oracle.closeSession(session);
    }
  }
  if (command === 'prepare') return workflow.phase4.prepare(args[0]);
  throw new Error('Usage: node src/cli.js <seed|ingest|auth [jobId|url] [email]|scan [jobId]|resolve|prepare applicationId>');
}

main()
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(JSON.stringify({ error: error.message, code: error.code, details: error.details }, null, 2));
    process.exitCode = 1;
  });
