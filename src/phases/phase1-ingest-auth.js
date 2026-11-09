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

    // 0. Load existing jobs.csv if it exists to preserve existing job_keys and find highest index
    const urlToKey = new Map();
    const existingUniqueJobs = [];
    let maxIndex = 0;

    try {
      const existingCleanRaw = await fs.readFile(cleanCsvPath, 'utf8');
      const existingRows = parseCsv(existingCleanRaw);
      for (const r of existingRows) {
        if (r.job_key && r.job_url) {
          const u = String(r.job_url).trim();
          urlToKey.set(u, r.job_key);
          existingUniqueJobs.push({ job_key: r.job_key, job_url: u });
          const match = r.job_key.match(/^job_(\d+)$/);
          if (match) {
            maxIndex = Math.max(maxIndex, parseInt(match[1], 10));
          }
        }
      }
    } catch {
      // File does not exist yet; starts clean from job_1
    }

    // Also inspect input rows for existing assigned job_keys
    for (const row of rows) {
      if (row.job_key && row.job_url) {
        const u = String(row.job_url).trim();
        const match = row.job_key.match(/^job_(\d+)$/);
        if (match) {
          maxIndex = Math.max(maxIndex, parseInt(match[1], 10));
        }
        if (!urlToKey.has(u)) {
          urlToKey.set(u, row.job_key);
          existingUniqueJobs.push({ job_key: row.job_key, job_url: u });
        }
      }
    }

    // Process all assignment rows
    for (const [index, row] of rows.entries()) {
      invariant(
        row.company_name && row.job_url && row.score !== undefined && row.client_name && row.applywizz_id,
        'INVALID_CSV_ROW',
        `Row ${index + 2} requires company_name, job_url, score, client_name, and applywizz_id`
      );

      const rawUrl = String(row.job_url).trim();
      if (!urlToKey.has(rawUrl)) {
        maxIndex += 1;
        const jobKey = `job_${maxIndex}`;
        urlToKey.set(rawUrl, jobKey);
        existingUniqueJobs.push({
          job_key: jobKey,
          job_url: rawUrl
        });
      }
      row.job_key = urlToKey.get(rawUrl);
    }

    // Deduplicate and sort uniqueJobs by job_key numeric index
    const uniqueMap = new Map();
    for (const j of existingUniqueJobs) {
      if (!uniqueMap.has(j.job_key)) {
        uniqueMap.set(j.job_key, j);
      }
    }

    const uniqueJobs = Array.from(uniqueMap.values()).sort((a, b) => {
      const matchA = a.job_key.match(/^job_(\d+)$/);
      const matchB = b.job_key.match(/^job_(\d+)$/);
      const numA = matchA ? parseInt(matchA[1], 10) : 0;
      const numB = matchB ? parseInt(matchB[1], 10) : 0;
      return numA - numB;
    });

    // 1. Write cumulative unique jobs to data/jobs.csv
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
    console.log(`[Phase 1 Ingestion] Cumulative unique jobs: ${uniqueJobs.length} (up to job_${maxIndex}).`);
    console.log(`[Phase 1 Ingestion] Updated clean jobs list: ${cleanCsvPath}`);
    console.log(`[Phase 1 Ingestion] Saved job_key mappings to source CSV: ${csvPath}`);

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
