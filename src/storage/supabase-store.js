import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { JsonStore } from './json-store.js';
import { config } from '../config.js';

const { Pool } = pg;

/**
 * Supabase PostgreSQL Store
 * Centralized, multi-worker cloud persistence for Oracle workflow automation.
 * Supports:
 *  1. Direct PostgreSQL connection via DATABASE_URL and pg.Pool (Primary)
 *  2. REST API via @supabase/supabase-js (Fallback)
 *  3. Local disk via JsonStore (Graceful Dual-Mode Offline Fallback)
 */
export class SupabaseStore {
  constructor({ connectionString, pool, url, key, client, fallbackStore } = {}) {
    if (pool !== undefined) {
      this.pool = pool;
      this.connectionString = connectionString || null;
    } else if (connectionString !== undefined) {
      this.connectionString = connectionString;
      this.pool = this.connectionString ? new Pool({
        connectionString: this.connectionString,
        ssl: { rejectUnauthorized: false },
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
      }) : null;
    } else if (client !== undefined) {
      this.connectionString = null;
      this.pool = null;
    } else if (process.env.DATABASE_URL) {
      this.connectionString = process.env.DATABASE_URL;
      this.pool = new Pool({
        connectionString: this.connectionString,
        ssl: { rejectUnauthorized: false },
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
      });
    } else {
      this.connectionString = null;
      this.pool = null;
    }

    if (this.pool) {
      this.pool.on('error', (err) => {
        console.warn('[SupabaseStore] Unexpected error on idle PostgreSQL client:', err.message);
      });
    }

    if (client !== undefined) {
      this.client = client;
    } else if (url !== undefined || key !== undefined) {
      this.url = url;
      this.key = key;
      this.client = (this.url && this.key) ? createClient(this.url, this.key) : null;
    } else if (process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)) {
      this.url = process.env.SUPABASE_URL;
      this.key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
      this.client = createClient(this.url, this.key);
    } else {
      this.client = null;
    }

    this.fallbackStore = fallbackStore !== undefined ? fallbackStore : new JsonStore(config.dataDir);
  }

  isAvailable() {
    return Boolean(this.pool || this.client);
  }

  /**
   * Helper to run queries using pg.Pool with error propagation
   */
  async query(text, params = []) {
    if (!this.pool) throw new Error('PostgreSQL pool is not configured');
    return this.pool.query(text, params);
  }

  /**
   * Helper to serialize JSONB columns safely
   */
  toJson(val, defaultVal = null) {
    if (val === undefined || val === null) return defaultVal ? JSON.stringify(defaultVal) : null;
    return typeof val === 'string' ? val : JSON.stringify(val);
  }

  /**
   * Helper to parse JSONB return values safely
   */
  fromJson(val, defaultVal = null) {
    if (val === undefined || val === null) return defaultVal;
    if (typeof val === 'object') return val;
    try {
      return JSON.parse(val);
    } catch {
      return defaultVal;
    }
  }

  /**
   * Universal read method compatible with JsonStore.read(name, fallback)
   */
  async read(name, fallback) {
    if (!this.isAvailable()) {
      return this.fallbackStore ? this.fallbackStore.read(name, fallback) : structuredClone(fallback);
    }

    try {
      if (this.pool) {
        return await this._readFromPg(name, fallback);
      }
      return await this._readFromRest(name, fallback);
    } catch (err) {
      console.warn(`[SupabaseStore] Error reading "${name}" from PostgreSQL: ${err.message}. Using local fallback.`);
      if (this.fallbackStore) {
        return await this.fallbackStore.read(name, fallback);
      }
      return structuredClone(fallback);
    }
  }

  async _readFromPg(name, fallback) {
    if (name === 'jobs') {
      const [jobsRes, oracleJobsRes] = await Promise.all([
        this.query('SELECT job_key, job_url, tenant_host, tenant_key, metadata FROM jobs'),
        this.query('SELECT job_key, job_url, company_name, client_name, applywizz_id, score FROM oracle_jobs')
      ]);

      const uniqueJobs = (jobsRes.rows || []).map(row => ({
        jobKey: row.job_key,
        jobUrl: row.job_url,
        jobId: row.job_key,
        tenantHost: row.tenant_host,
        tenantKey: row.tenant_key,
        ...(this.fromJson(row.metadata, {}))
      }));

      const assignments = (oracleJobsRes.rows || []).map(row => ({
        assignmentId: `asg_${row.applywizz_id}_${row.job_key}`,
        userId: row.applywizz_id,
        applywizzId: row.applywizz_id,
        clientName: row.client_name,
        companyName: row.company_name,
        score: row.score,
        jobId: row.job_key,
        jobKey: row.job_key,
        originalUrl: row.job_url,
        canonicalUrl: row.job_url
      }));

      return { uniqueJobs, assignments };
    }

    if (name === 'form-templates') {
      const res = await this.query('SELECT job_key, template_id, version, submit_present, fields, conditional_branches, repeatable_groups, scan_metadata FROM form_templates');
      const templates = {};
      for (const row of res.rows || []) {
        templates[row.job_key] = {
          templateId: row.template_id,
          version: row.version,
          jobKey: row.job_key,
          submitPresent: Boolean(row.submit_present),
          fields: this.fromJson(row.fields, []),
          conditionalBranches: this.fromJson(row.conditional_branches, []),
          repeatableGroups: this.fromJson(row.repeatable_groups, []),
          scan: this.fromJson(row.scan_metadata, {})
        };
      }
      return templates;
    }

    if (name === 'applications') {
      const res = await this.query(`
        SELECT application_id, applywizz_id, job_key, client_name, company_name,
               template_id, canonical_url, tenant_host, tenant_key, status,
               review_status, "values", unresolved_fields, fill_results,
               submission_result, screenshots, fill_logs, fill_completed_at, receipt,
               created_at, updated_at
        FROM applications
      `);

      return (res.rows || []).map(row => ({
        applicationId: row.application_id,
        applywizzId: row.applywizz_id,
        userId: row.applywizz_id,
        clientName: row.client_name,
        companyName: row.company_name,
        jobId: row.job_key,
        jobKey: row.job_key,
        templateId: row.template_id,
        canonicalUrl: row.canonical_url,
        tenantHost: row.tenant_host,
        tenantKey: row.tenant_key,
        status: row.status,
        reviewStatus: row.review_status,
        values: this.fromJson(row.values, {}),
        unresolvedFields: this.fromJson(row.unresolved_fields, []),
        fillResults: this.fromJson(row.fill_results, []),
        submissionResult: this.fromJson(row.submission_result, null),
        screenshots: this.fromJson(row.screenshots, []),
        fillLogs: this.fromJson(row.fill_logs, []),
        fillCompletedAt: row.fill_completed_at,
        receipt: this.fromJson(row.receipt, null),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    }

    if (name === 'scan-status') {
      const res = await this.query(`
        SELECT job_key, job_url, status, worker_id, attempt, reason,
               message, error, duration_ms, completed_at
        FROM scan_status
      `);

      const jobs = {};
      let completed = 0;
      let skipped = 0;
      let failed = 0;
      let inProgress = 0;

      for (const row of res.rows || []) {
        jobs[row.job_key] = {
          job_key: row.job_key,
          job_url: row.job_url,
          status: row.status,
          workerId: row.worker_id,
          attempt: row.attempt,
          reason: row.reason,
          message: row.message,
          error: row.error,
          durationMs: row.duration_ms,
          completedAt: row.completed_at
        };

        if (row.status === 'completed') completed++;
        else if (row.status === 'skipped') skipped++;
        else if (row.status === 'failed') failed++;
        else if (row.status === 'in_progress' || row.status === 'retry_backoff') inProgress++;
      }

      const total = (res.rows || []).length;
      const pending = Math.max(0, total - (completed + skipped + failed + inProgress));

      return {
        updatedAt: new Date().toISOString(),
        summary: { total, completed, skipped, failed, inProgress, pending },
        jobs
      };
    }

    if (name === 'clients') {
      const res = await this.query('SELECT applywizz_id, profile FROM clients');
      const clients = {};
      for (const row of res.rows || []) {
        clients[row.applywizz_id] = this.fromJson(row.profile, {});
      }
      return clients;
    }

    if (name === 'runs') {
      const res = await this.query('SELECT event_id, type, at, payload FROM run_logs ORDER BY at ASC');
      return (res.rows || []).map(row => ({
        eventId: row.event_id,
        type: row.type,
        at: row.at,
        ...(this.fromJson(row.payload, {}))
      }));
    }

    if (name === 'cas') {
      const res = await this.query('SELECT id, name, email, role, created_at, updated_at FROM career_associates ORDER BY name ASC');
      return (res.rows || []).map(row => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role || 'CA'
      }));
    }

    if (name === 'ca-mappings') {
      const res = await this.query('SELECT id, ca_id, applywizz_id, client_email, full_name, assignment_type FROM ca_client_mappings');
      const clientToCaMap = {};
      const mappingsByCa = {};
      for (const row of res.rows || []) {
        clientToCaMap[row.applywizz_id] = {
          caId: row.ca_id,
          applywizzId: row.applywizz_id,
          clientEmail: row.client_email,
          clientName: row.full_name,
          assignmentType: row.assignment_type
        };
        if (!mappingsByCa[row.ca_id]) mappingsByCa[row.ca_id] = [];
        mappingsByCa[row.ca_id].push(row);
      }
      return { clientToCaMap, mappingsByCa, rows: res.rows || [] };
    }

    if (name === 'reference-metadata' || name === 'locations') {
      const res = await this.query("SELECT payload FROM reference_metadata WHERE key = 'oracle_us_locations'");
      if (res.rows?.[0]?.payload) {
        return this.fromJson(res.rows[0].payload, fallback);
      }
      return structuredClone(fallback);
    }

    return structuredClone(fallback);
  }

  async _readFromRest(name, fallback) {
    if (name === 'jobs') {
      const [jobsRes, oracleJobsRes] = await Promise.all([
        this.client.from('jobs').select('*'),
        this.client.from('oracle_jobs').select('*')
      ]);
      if (jobsRes.error) throw jobsRes.error;
      if (oracleJobsRes.error) throw oracleJobsRes.error;

      const uniqueJobs = (jobsRes.data || []).map(row => ({
        jobKey: row.job_key,
        jobUrl: row.job_url,
        jobId: row.job_key,
        tenantHost: row.tenant_host,
        tenantKey: row.tenant_key,
        ...(row.metadata || {})
      }));

      const assignments = (oracleJobsRes.data || []).map(row => ({
        assignmentId: `asg_${row.applywizz_id}_${row.job_key}`,
        userId: row.applywizz_id,
        applywizzId: row.applywizz_id,
        clientName: row.client_name,
        companyName: row.company_name,
        score: row.score,
        jobId: row.job_key,
        jobKey: row.job_key,
        originalUrl: row.job_url,
        canonicalUrl: row.job_url
      }));

      return { uniqueJobs, assignments };
    }

    if (name === 'form-templates') {
      const { data, error } = await this.client.from('form_templates').select('*');
      if (error) throw error;
      const templates = {};
      for (const row of data || []) {
        templates[row.job_key] = {
          templateId: row.template_id,
          version: row.version,
          jobKey: row.job_key,
          submitPresent: row.submit_present,
          fields: row.fields || [],
          conditionalBranches: row.conditional_branches || [],
          repeatableGroups: row.repeatable_groups || [],
          scan: row.scan_metadata || {}
        };
      }
      return templates;
    }

    if (name === 'applications') {
      const { data, error } = await this.client.from('applications').select('*');
      if (error) throw error;
      return (data || []).map(row => ({
        applicationId: row.application_id,
        applywizzId: row.applywizz_id,
        userId: row.applywizz_id,
        clientName: row.client_name,
        companyName: row.company_name,
        jobId: row.job_key,
        jobKey: row.job_key,
        templateId: row.template_id,
        canonicalUrl: row.canonical_url,
        tenantHost: row.tenant_host,
        tenantKey: row.tenant_key,
        status: row.status,
        reviewStatus: row.review_status,
        values: row.values || {},
        unresolvedFields: row.unresolved_fields || [],
        fillResults: row.fill_results || [],
        submissionResult: row.submission_result || null,
        screenshots: row.screenshots || [],
        fillLogs: row.fill_logs || [],
        fillCompletedAt: row.fill_completed_at || null,
        receipt: row.receipt || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    }

    if (name === 'scan-status') {
      const { data, error } = await this.client.from('scan_status').select('*');
      if (error) throw error;
      const jobs = {};
      let completed = 0;
      let skipped = 0;
      let failed = 0;
      let inProgress = 0;

      for (const row of data || []) {
        jobs[row.job_key] = {
          job_key: row.job_key,
          job_url: row.job_url,
          status: row.status,
          workerId: row.worker_id,
          attempt: row.attempt,
          reason: row.reason,
          message: row.message,
          error: row.error,
          durationMs: row.duration_ms,
          completedAt: row.completed_at
        };

        if (row.status === 'completed') completed++;
        else if (row.status === 'skipped') skipped++;
        else if (row.status === 'failed') failed++;
        else if (row.status === 'in_progress' || row.status === 'retry_backoff') inProgress++;
      }

      const total = (data || []).length;
      const pending = Math.max(0, total - (completed + skipped + failed + inProgress));

      return {
        updatedAt: new Date().toISOString(),
        summary: { total, completed, skipped, failed, inProgress, pending },
        jobs
      };
    }

    if (name === 'clients') {
      const { data, error } = await this.client.from('clients').select('*');
      if (error) throw error;
      const clients = {};
      for (const row of data || []) {
        clients[row.applywizz_id] = row.profile || {};
      }
      return clients;
    }

    if (name === 'runs') {
      const { data, error } = await this.client.from('run_logs').select('*').order('at', { ascending: true });
      if (error) throw error;
      return (data || []).map(row => ({
        eventId: row.event_id,
        type: row.type,
        at: row.at,
        ...(row.payload || {})
      }));
    }

    return structuredClone(fallback);
  }

  /**
   * Universal write method compatible with JsonStore.write(name, value)
   */
  async write(name, value) {
    // In dual-mode: persist to local fallback cache in parallel
    if (this.fallbackStore) {
      try {
        await this.fallbackStore.write(name, value);
      } catch (e) {
        console.warn(`[SupabaseStore] Fallback write warning for "${name}":`, e.message);
      }
    }

    if (!this.isAvailable()) return value;

    try {
      if (this.pool) {
        await this._writeToPg(name, value);
      } else if (this.client) {
        await this._writeToRest(name, value);
      }
      return value;
    } catch (err) {
      console.warn(`[SupabaseStore] Error writing "${name}" to PostgreSQL: ${err.message}. Local fallback updated.`);
      return value;
    }
  }

  async _writeToPg(name, value) {
    if (name === 'jobs') {
      const uniqueJobs = value?.uniqueJobs || [];
      for (const j of uniqueJobs) {
        const key = j.jobKey || j.job_key;
        const url = j.jobUrl || j.job_url || j.canonicalUrl;
        const tenantHost = j.tenantHost || 'unknown';
        const tenantKey = j.tenantKey || '';
        const metadata = this.toJson(j, {});

        await this.query(`
          INSERT INTO jobs (job_key, job_url, tenant_host, tenant_key, metadata, updated_at)
          VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
          ON CONFLICT (job_key) DO UPDATE SET
            job_url = EXCLUDED.job_url,
            tenant_host = EXCLUDED.tenant_host,
            tenant_key = EXCLUDED.tenant_key,
            metadata = EXCLUDED.metadata,
            updated_at = NOW()
        `, [key, url, tenantHost, tenantKey, metadata]);
      }

      const assignments = value?.assignments || [];
      for (const a of assignments) {
        const jobKey = a.jobKey || a.jobId;
        const url = a.originalUrl || a.jobUrl || a.canonicalUrl;
        const comp = a.companyName || '';
        const clientName = a.clientName || '';
        const applywizzId = a.applywizzId || a.userId;
        const score = a.score || 0;

        await this.query(`
          INSERT INTO oracle_jobs (job_key, job_url, company_name, client_name, applywizz_id, score)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (job_key, applywizz_id) DO UPDATE SET
            job_url = EXCLUDED.job_url,
            company_name = EXCLUDED.company_name,
            client_name = EXCLUDED.client_name,
            score = EXCLUDED.score
        `, [jobKey, url, comp, clientName, applywizzId, score]);
      }
      return;
    }

    if (name === 'form-templates') {
      const templates = value || {};
      for (const [key, tpl] of Object.entries(templates)) {
        const templateId = tpl.templateId || `tpl-${key}`;
        const version = tpl.version || '1.0.0';
        const submitPresent = Boolean(tpl.submitPresent || tpl.scan?.submitPresent);
        const fields = this.toJson(tpl.fields || []);
        const branches = this.toJson(tpl.conditionalBranches || []);
        const groups = this.toJson(tpl.repeatableGroups || []);
        const scan = this.toJson(tpl.scan || {});
        const fieldsCount = tpl.fields?.length || 0;
        const branchesCount = tpl.conditionalBranches?.length || 0;
        const groupsCount = tpl.repeatableGroups?.length || 0;

        await this.query(`
          INSERT INTO form_templates (
            job_key, template_id, version, submit_present, fields_count, branches_count,
            repeatable_groups_count, fields, conditional_branches, repeatable_groups, scan_metadata, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, NOW())
          ON CONFLICT (job_key) DO UPDATE SET
            template_id = EXCLUDED.template_id,
            version = EXCLUDED.version,
            submit_present = EXCLUDED.submit_present,
            fields_count = EXCLUDED.fields_count,
            branches_count = EXCLUDED.branches_count,
            repeatable_groups_count = EXCLUDED.repeatable_groups_count,
            fields = EXCLUDED.fields,
            conditional_branches = EXCLUDED.conditional_branches,
            repeatable_groups = EXCLUDED.repeatable_groups,
            scan_metadata = EXCLUDED.scan_metadata,
            updated_at = NOW()
        `, [key, templateId, version, submitPresent, fieldsCount, branchesCount, groupsCount, fields, branches, groups, scan]);
      }
      return;
    }

    if (name === 'applications') {
      const apps = Array.isArray(value) ? value : Object.values(value || {});
      for (const app of apps) {
        const appId = app.applicationId;
        const applywizzId = app.applywizzId || app.userId;
        const jobKey = app.jobKey || app.jobId;
        const clientName = app.clientName || '';
        const companyName = app.companyName || '';
        const templateId = app.templateId || null;
        const canonicalUrl = app.canonicalUrl || null;
        const tenantHost = app.tenantHost || null;
        const tenantKey = app.tenantKey || null;
        const status = app.status || 'needs_input';
        const reviewStatus = app.reviewStatus || 'not_ready';
        const valuesJson = this.toJson(app.values || {});
        const unresolvedJson = this.toJson(app.unresolvedFields || []);
        const fillResultsJson = this.toJson(app.fillResults || []);
        const submissionResultJson = this.toJson(app.submissionResult || null);
        const screenshotsJson = this.toJson(app.screenshots || []);
        const fillLogsJson = this.toJson(app.fillLogs || []);
        const fillCompletedAt = app.fillCompletedAt || null;
        const receiptJson = this.toJson(app.receipt || null);

        await this.query(`
          INSERT INTO applications (
            application_id, applywizz_id, job_key, client_name, company_name, template_id,
            canonical_url, tenant_host, tenant_key, status, review_status, "values",
            unresolved_fields, fill_results, submission_result, screenshots, fill_logs,
            fill_completed_at, receipt, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19::jsonb, NOW())
          ON CONFLICT (application_id) DO UPDATE SET
            applywizz_id = EXCLUDED.applywizz_id,
            job_key = EXCLUDED.job_key,
            client_name = EXCLUDED.client_name,
            company_name = EXCLUDED.company_name,
            template_id = EXCLUDED.template_id,
            canonical_url = EXCLUDED.canonical_url,
            tenant_host = EXCLUDED.tenant_host,
            tenant_key = EXCLUDED.tenant_key,
            status = EXCLUDED.status,
            review_status = EXCLUDED.review_status,
            "values" = EXCLUDED."values",
            unresolved_fields = EXCLUDED.unresolved_fields,
            fill_results = EXCLUDED.fill_results,
            submission_result = EXCLUDED.submission_result,
            screenshots = EXCLUDED.screenshots,
            fill_logs = EXCLUDED.fill_logs,
            fill_completed_at = EXCLUDED.fill_completed_at,
            receipt = EXCLUDED.receipt,
            updated_at = NOW()
        `, [
          appId, applywizzId, jobKey, clientName, companyName, templateId,
          canonicalUrl, tenantHost, tenantKey, status, reviewStatus, valuesJson,
          unresolvedJson, fillResultsJson, submissionResultJson,
          screenshotsJson, fillLogsJson, fillCompletedAt, receiptJson
        ]);
      }
      return;
    }

    if (name === 'scan-status') {
      const jobs = value?.jobs || {};
      for (const item of Object.values(jobs)) {
        await this.query(`
          INSERT INTO scan_status (
            job_key, job_url, status, worker_id, attempt, reason, message, error, duration_ms, completed_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
          ON CONFLICT (job_key) DO UPDATE SET
            job_url = EXCLUDED.job_url,
            status = EXCLUDED.status,
            worker_id = EXCLUDED.worker_id,
            attempt = EXCLUDED.attempt,
            reason = EXCLUDED.reason,
            message = EXCLUDED.message,
            error = EXCLUDED.error,
            duration_ms = EXCLUDED.duration_ms,
            completed_at = EXCLUDED.completed_at,
            updated_at = NOW()
        `, [
          item.job_key, item.job_url, item.status || 'pending', item.workerId || null,
          item.attempt || 1, item.reason || null, item.message || null, item.error || null,
          item.durationMs || null, item.completedAt || null
        ]);
      }
      return;
    }

    if (name === 'clients') {
      const clientEntries = Object.entries(value || {});
      for (const [applywizzId, profile] of clientEntries) {
        const fullName = profile.client?.full_name || null;
        const email = profile.client?.personal_email || null;
        const phone = profile.client?.callable_phone || null;
        const profileJson = this.toJson(profile, {});

        await this.query(`
          INSERT INTO clients (applywizz_id, full_name, email, phone, profile, updated_at)
          VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
          ON CONFLICT (applywizz_id) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            email = EXCLUDED.email,
            phone = EXCLUDED.phone,
            profile = EXCLUDED.profile,
            updated_at = NOW()
        `, [applywizzId, fullName, email, phone, profileJson]);
      }
      return;
    }

    if (name === 'runs') {
      const events = Array.isArray(value) ? value : [];
      if (events.length > 0) {
        const lastEvent = events[events.length - 1];
        if (lastEvent) {
          await this.query(`
            INSERT INTO run_logs (event_id, type, at, payload)
            VALUES ($1, $2, $3, $4::jsonb)
          `, [
            lastEvent.eventId,
            lastEvent.type,
            lastEvent.at || new Date().toISOString(),
            this.toJson(lastEvent, {})
          ]);
        }
      }
      return;
    }

    if (name === 'cas') {
      const cas = Array.isArray(value) ? value : (value?.cas || []);
      for (const ca of cas) {
        if (!ca.id || !ca.email) continue;
        await this.query(`
          INSERT INTO career_associates (id, name, email, role, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            email = EXCLUDED.email,
            role = EXCLUDED.role,
            updated_at = NOW()
        `, [ca.id, ca.name || '', ca.email, ca.role || 'CA']);
      }
      return;
    }

    if (name === 'ca-mappings') {
      const mappings = Array.isArray(value) ? value : (value?.mappings || value?.rows || []);
      for (const m of mappings) {
        if (!m.ca_id && !m.caId) continue;
        const caId = m.ca_id || m.caId;
        const applywizzId = m.applywizz_id || m.applywizzId;
        const email = m.client_email || m.clientEmail || null;
        const name = m.full_name || m.clientName || null;
        const type = m.assignment_type || m.assignmentType || 'permanent';

        await this.query(`
          INSERT INTO ca_client_mappings (ca_id, applywizz_id, client_email, full_name, assignment_type, updated_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (ca_id, applywizz_id) DO UPDATE SET
            client_email = EXCLUDED.client_email,
            full_name = EXCLUDED.full_name,
            assignment_type = EXCLUDED.assignment_type,
            updated_at = NOW()
        `, [caId, applywizzId, email, name, type]);
      }
      return;
    }

    if (name === 'reference-metadata' || name === 'locations') {
      const key = value?.key || 'oracle_us_locations';
      const payload = value?.payload || value;
      await this.query(`
        INSERT INTO reference_metadata (key, payload, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET
          payload = EXCLUDED.payload,
          updated_at = NOW()
      `, [key, this.toJson(payload, {})]);
      return;
    }
  }

  async _writeToRest(name, value) {
    if (name === 'jobs') {
      const uniqueJobs = value?.uniqueJobs || [];
      if (uniqueJobs.length > 0) {
        const rows = uniqueJobs.map(j => ({
          job_key: j.jobKey || j.job_key,
          job_url: j.jobUrl || j.job_url || j.canonicalUrl,
          tenant_host: j.tenantHost || 'unknown',
          tenant_key: j.tenantKey || '',
          metadata: j
        }));
        const { error } = await this.client.from('jobs').upsert(rows, { onConflict: 'job_key' });
        if (error) throw error;
      }

      const assignments = value?.assignments || [];
      if (assignments.length > 0) {
        const rows = assignments.map(a => ({
          job_key: a.jobKey || a.jobId,
          job_url: a.originalUrl || a.jobUrl || a.canonicalUrl,
          company_name: a.companyName,
          client_name: a.clientName,
          applywizz_id: a.applywizzId || a.userId,
          score: a.score || 0
        }));
        const { error } = await this.client.from('oracle_jobs').upsert(rows, { onConflict: 'job_key,applywizz_id' });
        if (error) throw error;
      }
      return;
    }

    if (name === 'form-templates') {
      const templates = value || {};
      const rows = Object.entries(templates).map(([key, tpl]) => ({
        job_key: key,
        template_id: tpl.templateId || `tpl-${key}`,
        version: tpl.version || '1.0.0',
        submit_present: Boolean(tpl.submitPresent || tpl.scan?.submitPresent),
        fields_count: tpl.fields?.length || 0,
        branches_count: tpl.conditionalBranches?.length || 0,
        repeatable_groups_count: tpl.repeatableGroups?.length || 0,
        fields: tpl.fields || [],
        conditional_branches: tpl.conditionalBranches || [],
        repeatable_groups: tpl.repeatableGroups || [],
        scan_metadata: tpl.scan || {},
        updated_at: new Date().toISOString()
      }));

      if (rows.length > 0) {
        const { error } = await this.client.from('form_templates').upsert(rows, { onConflict: 'job_key' });
        if (error) throw error;
      }
      return;
    }

    if (name === 'applications') {
      const apps = Array.isArray(value) ? value : Object.values(value || {});
      if (apps.length > 0) {
        const rows = apps.map(app => ({
          application_id: app.applicationId,
          applywizz_id: app.applywizzId || app.userId,
          job_key: app.jobKey || app.jobId,
          client_name: app.clientName,
          company_name: app.companyName,
          template_id: app.templateId,
          canonical_url: app.canonicalUrl,
          tenant_host: app.tenantHost,
          tenant_key: app.tenantKey,
          status: app.status || 'needs_input',
          review_status: app.reviewStatus || 'not_ready',
          values: app.values || {},
          unresolved_fields: app.unresolvedFields || [],
          fill_results: app.fillResults || [],
          submission_result: app.submissionResult || null,
          screenshots: app.screenshots || [],
          fill_logs: app.fillLogs || [],
          fill_completed_at: app.fillCompletedAt || null,
          receipt: app.receipt || null,
          updated_at: new Date().toISOString()
        }));

        const { error } = await this.client.from('applications').upsert(rows, { onConflict: 'application_id' });
        if (error) throw error;
      }
      return;
    }

    if (name === 'scan-status') {
      const jobs = value?.jobs || {};
      const rows = Object.values(jobs).map(item => ({
        job_key: item.job_key,
        job_url: item.job_url,
        status: item.status || 'pending',
        worker_id: item.workerId || null,
        attempt: item.attempt || 1,
        reason: item.reason || null,
        message: item.message || null,
        error: item.error || null,
        duration_ms: item.duration_ms || null,
        completed_at: item.completedAt || null,
        updated_at: new Date().toISOString()
      }));

      if (rows.length > 0) {
        const { error } = await this.client.from('scan_status').upsert(rows, { onConflict: 'job_key' });
        if (error) throw error;
      }
      return;
    }

    if (name === 'clients') {
      const clientEntries = Object.entries(value || {});
      if (clientEntries.length > 0) {
        const rows = clientEntries.map(([applywizzId, profile]) => ({
          applywizz_id: applywizzId,
          full_name: profile.client?.full_name,
          email: profile.client?.personal_email,
          phone: profile.client?.callable_phone,
          profile,
          updated_at: new Date().toISOString()
        }));
        const { error } = await this.client.from('clients').upsert(rows, { onConflict: 'applywizz_id' });
        if (error) throw error;
      }
      return;
    }

    if (name === 'runs') {
      const events = Array.isArray(value) ? value : [];
      if (events.length > 0) {
        const lastEvent = events[events.length - 1];
        if (lastEvent) {
          const { error } = await this.client.from('run_logs').insert([{
            event_id: lastEvent.eventId,
            type: lastEvent.type,
            at: lastEvent.at || new Date().toISOString(),
            payload: lastEvent
          }]);
          if (error) throw error;
        }
      }
    }
  }

  /**
   * Universal update method compatible with JsonStore.update(name, fallback, updater)
   */
  async update(name, fallback, updater) {
    const current = await this.read(name, fallback);
    const updated = await updater(structuredClone(current));
    await this.write(name, updated);
    return updated;
  }

  // --------------------------------------------------------------------------
  // Dedicated Domain Helper Methods for Supabase
  // --------------------------------------------------------------------------

  /**
   * Fetches historical question bank records from Supabase question_bank table
   */
  async loadQuestionBank() {
    if (!this.isAvailable()) {
      if (this.fallbackStore && typeof this.fallbackStore.loadQuestionBank === 'function') {
        return this.fallbackStore.loadQuestionBank();
      }
      return { clientHistoryMap: new Map(), globalHistory: [] };
    }

    try {
      let records = [];
      if (this.pool) {
        const res = await this.query(`
          SELECT id, applywizz_id, question_label, field_type, value, source, confidence, created_at, updated_at
          FROM question_bank
        `);
        records = res.rows || [];
      } else if (this.client) {
        const { data, error } = await this.client.from('question_bank').select('*');
        if (error) throw error;
        records = data || [];
      }

      const clientHistoryMap = new Map();
      const globalHistory = [];

      for (const row of records) {
        if (row.value && /^\s*professional\s*experience\s*$/i.test(row.value)) {
          continue;
        }
        const applywizzId = row.applywizz_id?.trim();
        const record = {
          id: row.id,
          applywizz_id: applywizzId,
          question_label: row.question_label?.trim(),
          field_type: row.field_type?.trim(),
          value: row.value,
          source: row.source || 'manual',
          confidence: Number(row.confidence) || 1.0,
          created_at: row.created_at,
          updated_at: row.updated_at
        };

        globalHistory.push(record);
        if (applywizzId) {
          if (!clientHistoryMap.has(applywizzId)) {
            clientHistoryMap.set(applywizzId, []);
          }
          clientHistoryMap.get(applywizzId).push(record);
        }
      }

      return { clientHistoryMap, globalHistory };
    } catch (err) {
      console.warn('[SupabaseStore] Error loading question_bank from PostgreSQL:', err.message);
      if (this.fallbackStore && typeof this.fallbackStore.loadQuestionBank === 'function') {
        return this.fallbackStore.loadQuestionBank();
      }
      return { clientHistoryMap: new Map(), globalHistory: [] };
    }
  }

  /**
   * Upserts verified question bank records into Supabase question_bank table
   */
  async upsertQuestionBank(records) {
    if (!records || records.length === 0) return [];

    // Fallback sync to local question_bank.csv in parallel
    if (this.fallbackStore && typeof this.fallbackStore.upsertQuestionBank === 'function') {
      try {
        await this.fallbackStore.upsertQuestionBank(records);
      } catch (e) {
        console.warn('[SupabaseStore] Local fallback upsertQuestionBank warning:', e.message);
      }
    }

    if (!this.isAvailable()) return records;

    try {
      if (this.pool) {
        for (const r of records) {
          if (r.applywizz_id) {
            await this.query(`
              INSERT INTO question_bank (
                applywizz_id, question_label, field_type, value, source, confidence, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
              ON CONFLICT (applywizz_id, question_label) WHERE applywizz_id IS NOT NULL DO UPDATE SET
                field_type = EXCLUDED.field_type,
                value = EXCLUDED.value,
                source = EXCLUDED.source,
                confidence = EXCLUDED.confidence,
                updated_at = NOW()
            `, [
              r.applywizz_id,
              r.question_label || '',
              r.field_type || null,
              r.value || '',
              r.source || 'manual',
              r.confidence || 1.0
            ]);
          } else {
            await this.query(`
              INSERT INTO question_bank (
                applywizz_id, question_label, field_type, value, source, confidence, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
            `, [
              null,
              r.question_label || '',
              r.field_type || null,
              r.value || '',
              r.source || 'manual',
              r.confidence || 1.0
            ]);
          }
        }
        return records;
      }

      if (this.client) {
        const rows = records.map(r => ({
          applywizz_id: r.applywizz_id,
          question_label: r.question_label,
          field_type: r.field_type,
          value: r.value,
          source: r.source || 'manual',
          confidence: r.confidence || 1.0,
          updated_at: new Date().toISOString()
        }));
        const { data, error } = await this.client.from('question_bank').upsert(rows);
        if (error) throw error;
        return data || records;
      }

      return records;
    } catch (err) {
      console.warn('[SupabaseStore] Error upserting question_bank to PostgreSQL:', err.message);
      return records;
    }
  }

  /**
   * Graceful cleanup when shutting down
   */
  async close() {
    if (this.pool) {
      try {
        await this.pool.end();
      } catch (err) {
        console.warn('[SupabaseStore] Error closing pool:', err.message);
      }
    }
  }
}
