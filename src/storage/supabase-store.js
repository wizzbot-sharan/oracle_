import { createClient } from '@supabase/supabase-js';

/**
 * Supabase PostgreSQL Store
 * Centralized, multi-worker cloud persistence for Oracle workflow automation.
 * Implements the exact same interface as JsonStore (read, write, update)
 * while leveraging PostgreSQL's Hybrid Relational + JSONB model.
 */
export class SupabaseStore {
  constructor({ url, key, client } = {}) {
    this.url = url ?? process.env.SUPABASE_URL;
    this.key = key ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;
    this.client = client ?? (this.url && this.key ? createClient(this.url, this.key) : null);
  }

  isAvailable() {
    return Boolean(this.client);
  }

  /**
   * Universal read method compatible with JsonStore.read(name, fallback)
   */
  async read(name, fallback) {
    if (!this.client) return structuredClone(fallback);

    try {
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
    } catch (err) {
      console.error(`[SupabaseStore] Error reading "${name}":`, err.message);
      return structuredClone(fallback);
    }
  }

  /**
   * Universal write method compatible with JsonStore.write(name, value)
   */
  async write(name, value) {
    if (!this.client) return value;

    try {
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
        return value;
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
        return value;
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
            updated_at: new Date().toISOString()
          }));

          const { error } = await this.client.from('applications').upsert(rows, { onConflict: 'application_id' });
          if (error) throw error;
        }
        return value;
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
          duration_ms: item.durationMs || null,
          completed_at: item.completedAt || null,
          updated_at: new Date().toISOString()
        }));

        if (rows.length > 0) {
          const { error } = await this.client.from('scan_status').upsert(rows, { onConflict: 'job_key' });
          if (error) throw error;
        }
        return value;
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
        return value;
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
        return value;
      }

      return value;
    } catch (err) {
      console.error(`[SupabaseStore] Error writing "${name}":`, err.message);
      return value;
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
    if (!this.client) return { clientHistoryMap: new Map(), globalHistory: [] };

    try {
      const { data, error } = await this.client.from('question_bank').select('*');
      if (error) throw error;

      const clientHistoryMap = new Map();
      const globalHistory = [];

      for (const row of data || []) {
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
      console.error('[SupabaseStore] Error loading question_bank:', err.message);
      return { clientHistoryMap: new Map(), globalHistory: [] };
    }
  }

  /**
   * Upserts verified question bank records into Supabase question_bank table
   */
  async upsertQuestionBank(records) {
    if (!this.client || !records || records.length === 0) return [];

    try {
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
      return data;
    } catch (err) {
      console.error('[SupabaseStore] Error upserting question_bank:', err.message);
      return [];
    }
  }
}
