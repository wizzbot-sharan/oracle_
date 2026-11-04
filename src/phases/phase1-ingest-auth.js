import fs from 'node:fs/promises';
import { parseOracleJobUrl } from '../shared/url.js';
import { parseCsv } from '../shared/csv.js';
import { stableId } from '../shared/ids.js';
import { invariant } from '../shared/errors.js';

export class Phase1IngestAuth {
  constructor({ store, runLog, oracle, mailReader, otpLock }) {
    this.store = store;
    this.runLog = runLog;
    this.oracle = oracle;
    this.mailReader = mailReader;
    this.otpLock = otpLock;
  }

  async ingestCsv(csvPath) {
    const rows = parseCsv(await fs.readFile(csvPath, 'utf8'));
    const assignments = rows.map((row, index) => {
      invariant(row.user_id && row.job_id && row.job_url, 'INVALID_CSV_ROW', `Row ${index + 2} requires user_id, job_id and job_url`);
      const parsed = parseOracleJobUrl(row.job_url);
      invariant(String(row.job_id) === parsed.sourceJobId, 'JOB_ID_MISMATCH', `CSV job_id does not match URL on row ${index + 2}`);
      return {
        assignmentId: stableId('asg', `${row.user_id}|${row.job_id}|${parsed.canonicalUrl}`),
        userId: row.user_id,
        jobId: String(row.job_id),
        originalUrl: row.job_url,
        ...parsed
      };
    });

    const unique = new Map();
    for (const assignment of assignments) {
      const key = assignment.canonicalUrl;
      const existing = unique.get(key) ?? {
        jobId: assignment.jobId,
        canonicalUrl: assignment.canonicalUrl,
        tenantHost: assignment.tenantHost,
        tenantKey: assignment.tenantKey,
        userIds: []
      };
      if (!existing.userIds.includes(assignment.userId)) existing.userIds.push(assignment.userId);
      unique.set(key, existing);
    }

    const result = { assignments, uniqueJobs: [...unique.values()] };
    await this.store.write('jobs', result);
    await this.runLog.append('phase1.ingested', { assignments: assignments.length, uniqueJobs: unique.size });
    return result;
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
