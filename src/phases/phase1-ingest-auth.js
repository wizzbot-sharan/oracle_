import fs from 'node:fs/promises';
import path from 'node:path';
import { parseOracleJobUrl } from '../shared/url.js';
import { parseCsv, formatCsv } from '../shared/csv.js';
import { stableId } from '../shared/ids.js';
import { invariant } from '../shared/errors.js';
import { config } from '../config.js';

export class Phase1IngestAuth {
  constructor({ store, runLog, oracle, mailReader, otpLock }) {
    this.store = store;
    this.runLog = runLog;
    this.oracle = oracle;
    this.mailReader = mailReader;
    this.otpLock = otpLock;
  }

  async ingestCsv(targetCsvPath, options = {}) {
    const csvPath = path.resolve(targetCsvPath ?? config.jobsCsvPath);
    const cleanCsvPath = path.resolve(options.cleanCsvPath ?? config.jobsCleanCsvPath);

    const rawText = await fs.readFile(csvPath, 'utf8');
    const rows = parseCsv(rawText);
    invariant(rows.length > 0, 'EMPTY_CSV', 'CSV contains no data rows');

    const urlToKey = new Map();
    const uniqueJobs = [];
    let counter = 1;

    for (const [index, row] of rows.entries()) {
      invariant(
        row.company_name && row.job_url && row.score !== undefined && row.client_name && row.applywizz_id,
        'INVALID_CSV_ROW',
        `Row ${index + 2} requires company_name, job_url, score, client_name, and applywizz_id`
      );

      const rawUrl = String(row.job_url).trim();
      if (!urlToKey.has(rawUrl)) {
        const jobKey = `job_${counter}`;
        counter += 1;
        urlToKey.set(rawUrl, jobKey);
        uniqueJobs.push({
          job_key: jobKey,
          job_url: rawUrl
        });
      }
      row.job_key = urlToKey.get(rawUrl);
    }

    // 1. Cleanly overwrite data/jobs.csv with unique jobs
    const jobsCsvContent = formatCsv(uniqueJobs, ['job_key', 'job_url']);
    await fs.mkdir(path.dirname(cleanCsvPath), { recursive: true });
    await fs.writeFile(cleanCsvPath, jobsCsvContent, 'utf8');

    // 2. Append/update job_key as the last column in data/oracle_jobs.csv
    const oracleJobsHeaders = ['company_name', 'job_url', 'score', 'client_name', 'applywizz_id', 'job_key'];
    const updatedOracleCsvContent = formatCsv(rows, oracleJobsHeaders);
    await fs.writeFile(csvPath, updatedOracleCsvContent, 'utf8');

    // 3. Update store state and runLog for downstream components
    const assignments = rows.map(row => {
      let parsed = {};
      try {
        parsed = parseOracleJobUrl(row.job_url);
      } catch {
        parsed = { canonicalUrl: row.job_url, sourceJobId: row.job_key, tenantHost: '', tenantKey: '' };
      }
      return {
        assignmentId: stableId('asg', `${row.applywizz_id}|${row.job_key}`),
        userId: row.applywizz_id,
        applywizzId: row.applywizz_id,
        clientName: row.client_name,
        companyName: row.company_name,
        score: Number(row.score) || 0,
        jobId: parsed.sourceJobId || row.job_key,
        jobKey: row.job_key,
        originalUrl: row.job_url,
        ...parsed
      };
    });

    const storeResult = {
      assignments,
      uniqueJobs: uniqueJobs.map(j => ({
        jobKey: j.job_key,
        jobUrl: j.job_url,
        jobId: j.job_key
      }))
    };
    await this.store.write('jobs', storeResult);
    await this.runLog.append('phase1.ingested', {
      assignments: assignments.length,
      uniqueJobs: uniqueJobs.length,
      cleanCsvPath,
      sourceCsvPath: csvPath
    });

    console.log(`[Phase 1 Ingestion] Processed ${rows.length} assignment rows.`);
    console.log(`[Phase 1 Ingestion] Identified ${uniqueJobs.length} unique URLs (job_1 to job_${uniqueJobs.length}).`);
    console.log(`[Phase 1 Ingestion] Overwrote clean jobs list: ${cleanCsvPath}`);
    console.log(`[Phase 1 Ingestion] Appended job_key to source CSV: ${csvPath}`);

    return {
      assignments,
      uniqueJobs,
      cleanCsvPath,
      sourceCsvPath: csvPath
    };
  }


  async authenticate({ applicationId, job, email, companyDomains = [] }) {
    const lockKey = `${email.toLowerCase()}|${job.tenantHost}`;
    return this.otpLock.run(lockKey, async () => {
      const session = await this.oracle.createSession({ applicationId });
      try {
        const result = await this.oracle.authenticate({
          session,
          job,
          email,
          companyDomains,
          mailReader: this.mailReader
        });
        if (result.status === 'skipped') {
          await this.oracle.closeSession(session);
          await this.runLog.append('phase1.skipped', {
            applicationId,
            jobId: job.jobId,
            tenantHost: job.tenantHost,
            reason: result.reason,
            message: result.message
          });
          return { session: null, result };
        }
        await this.runLog.append('phase1.authenticated', { applicationId, jobId: job.jobId, tenantHost: job.tenantHost });
        return { session, result };
      } catch (error) {
        await this.oracle.closeSession(session);
        await this.runLog.append('phase1.authentication_failed', { applicationId, jobId: job.jobId, code: error.code ?? 'UNKNOWN' });
        throw error;
      }
    });
  }
}
