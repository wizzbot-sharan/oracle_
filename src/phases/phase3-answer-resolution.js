import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { flattenTemplateFields, isFieldVisible, valueType } from '../domain/form-template.js';
import { stableId } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import { invariant } from '../shared/errors.js';
import { parseCsv, formatCsv, formatCsvRow } from '../shared/csv.js';
import { ResolutionEngine } from '../domain/resolution-engine.js';
import { ClaudeService } from '../services/claude-service.js';
import { parseJobSelector, isAssignmentSelected } from '../shared/job-filter.js';

const QB_HEADERS = [
  'id',
  'applywizz_id',
  'question_label',
  'field_type',
  'value',
  'source',
  'confidence',
  'created_at',
  'updated_at'
];

export class Phase3AnswerResolution {
  constructor({ store, runLog, engine, config: cfg } = {}) {
    this.store = store;
    this.runLog = runLog;
    this.engine = engine ?? new ResolutionEngine({
      claudeService: new ClaudeService()
    });
    this.clientsPath = cfg?.clientsPath ?? path.resolve(process.cwd(), 'data/clients.json');
    this.profilesPath = cfg?.profilesPath ?? path.resolve(process.cwd(), 'data/profiles.csv');
    this.questionBankCsvPath = cfg?.questionBankCsvPath ?? path.resolve(process.cwd(), 'data/question_bank.csv');
  }

  /**
   * Loads and indexes historical records from Supabase question_bank table or data/question_bank.csv.
   */
  async loadQuestionBank() {
    try {
      if (typeof this.store?.loadQuestionBank === 'function' && this.store?.isAvailable?.()) {
        const storeResult = await this.store.loadQuestionBank();
        if (storeResult && (storeResult.globalHistory?.length > 0 || storeResult.clientHistoryMap?.size > 0)) {
          return storeResult;
        }
      }

      if (!fs.existsSync(this.questionBankCsvPath)) {
        return { clientHistoryMap: new Map(), globalHistory: [] };
      }
      const raw = await fs.promises.readFile(this.questionBankCsvPath, 'utf8');
      const records = parseCsv(raw);

      const clientHistoryMap = new Map();
      const globalHistory = [];

      for (const record of records) {
        // Purge/skip poisoned placeholder values
        if (record.value && /^\s*professional\s*experience\s*$/i.test(record.value)) {
          continue;
        }

        const applywizzId = record.applywizz_id?.trim();
        const numConfidence = Number(record.confidence);
        const parsedRecord = {
          id: record.id,
          applywizz_id: applywizzId,
          question_label: record.question_label?.trim(),
          field_type: record.field_type?.trim(),
          value: record.value,
          source: record.source || 'manual',
          confidence: Number.isFinite(numConfidence) ? numConfidence : 1.0,
          created_at: record.created_at,
          updated_at: record.updated_at
        };

        globalHistory.push(parsedRecord);

        if (applywizzId) {
          if (!clientHistoryMap.has(applywizzId)) {
            clientHistoryMap.set(applywizzId, []);
          }
          clientHistoryMap.get(applywizzId).push(parsedRecord);
        }
      }

      return { clientHistoryMap, globalHistory };
    } catch (err) {
      console.error('[Phase 3] Warning: Failed to load question_bank.csv:', err.message);
      return { clientHistoryMap: new Map(), globalHistory: [] };
    }
  }

  /**
   * Loads candidate profiles from data/clients.json and fuses data/profiles.csv if available.
   */
  async loadClients() {
    let clients = {};
    try {
      if (fs.existsSync(this.clientsPath)) {
        const raw = await fs.promises.readFile(this.clientsPath, 'utf8');
        clients = JSON.parse(raw);
      } else {
        clients = await this.store.read('clients', {});
      }
    } catch (err) {
      console.error('[Phase 3] Warning: Failed to load clients.json:', err.message);
    }

    // Merge profiles.csv if available
    try {
      if (fs.existsSync(this.profilesPath)) {
        const rawCsv = await fs.promises.readFile(this.profilesPath, 'utf8');
        const profiles = parseCsv(rawCsv);
        for (const p of profiles) {
          const id = p.applywizz_id?.trim();
          if (!id || !clients[id]) continue; // Skip: Only merge onto EXISTING CRM clients

          let edArray = [];
          if (p.education) {
            try { edArray = JSON.parse(p.education); } catch {}
          }
          let expArray = [];
          if (p.work_experience) {
            try { expArray = JSON.parse(p.work_experience); } catch {}
          }

          const c = clients[id];
          if (!c.client) c.client = {};
          if (!c.additional_information) c.additional_information = {};

          if (!c.client.full_name && p.client_name) c.client.full_name = p.client_name;
          if (p.first_name) c.client.first_name = p.first_name;
          if (p.last_name) c.client.last_name = p.last_name;
          if (p.email) c.client.personal_email = p.email;
          if (p.company_email) c.client.company_email = p.company_email;
          if (p.phone) {
            c.client.callable_phone = p.phone;
            c.additional_information.primary_phone = p.phone;
          }

          c.additional_information.location = p.location || c.additional_information.location || '';
          c.additional_information.country = p.country || c.additional_information.country || 'United States';
          c.additional_information.country_code = p.country_code || c.additional_information.country_code || '1';
          if (p.linkedin_url && p.linkedin_url !== 'N/A' && p.linkedin_url !== 'NULL') c.additional_information.linkedin_url = p.linkedin_url;
          if (p.github_url && p.github_url !== 'N/A' && p.github_url !== 'NULL') c.additional_information.github_url = p.github_url;
          if (p.website_url && p.website_url !== 'N/A' && p.website_url !== 'NULL') c.additional_information.website_url = p.website_url;
          if (p.work_authorization) c.additional_information.work_authorization = p.work_authorization;
          if (p.requires_sponsorship !== undefined) c.additional_information.requires_sponsorship = p.requires_sponsorship === 'TRUE' || p.requires_sponsorship === true;
          if (edArray.length > 0) c.additional_information.education_records = edArray;
          if (expArray.length > 0) c.additional_information.experience_records = expArray;
          if (p.resume_text) c.additional_information.resume_text = p.resume_text;
          if (p.resume_url) c.additional_information.resume_url = p.resume_url;
        }
      }
    } catch (err) {
      console.error('[Phase 3] Warning: Failed to load profiles.csv:', err.message);
    }

    return clients;
  }

  /**
   * Creates or resolves application instances across all assignments that have templates.
   */
  async createOrResolveApplications(options = {}) {
    const { limit, jobUrl, force = false } = options;
    const selector = parseJobSelector(options);

    const jobs = await this.store.read('jobs', { assignments: [], uniqueJobs: [] });
    const templates = await this.store.read('form-templates', {});
    const existing = await this.store.read('applications', []);
    const byId = new Map(existing.map(application => [application.applicationId, application]));

    const [clients, { clientHistoryMap, globalHistory }] = await Promise.all([
      this.loadClients(),
      this.loadQuestionBank()
    ]);

    let assignments = jobs.assignments || [];
    if (selector.hasFilter) {
      assignments = assignments.filter(a => isAssignmentSelected(a, selector));
    }
    if (jobUrl) {
      assignments = assignments.filter(a => a.canonicalUrl === jobUrl || a.originalUrl === jobUrl);
    }

    const targetedJobKeys = new Set(assignments.map(a => a.jobKey || a.jobId));
    // Filter to assignments that have scanned templates
    const matchedAssignments = assignments.filter(a => Boolean(templates[a.jobKey] || templates[a.jobId]));
    const matchedJobKeys = new Set(matchedAssignments.map(a => a.jobKey || a.jobId));

    let toProcess = matchedAssignments;
    if (limit && limit > 0) {
      toProcess = toProcess.slice(0, limit);
    }

    let resolvedCount = 0;
    let needsInputCount = 0;
    const candidateResumeCache = new Map();

    for (const assignment of toProcess) {
      const template = templates[assignment.jobKey] || templates[assignment.jobId];

      const applywizzId = assignment.applywizzId || assignment.userId;
      const client = clients[applywizzId];
      
      // Gatekeeper: Enforce clients.json presence
      if (!client || !client.client || Object.keys(client.client).length === 0) {
        console.log(`[Phase 3] Skipping Job ${assignment.jobKey || assignment.jobId} for ${applywizzId}: candidate not found or incomplete in clients.json`);
        continue;
      }

      const clientHistory = clientHistoryMap.get(applywizzId) || [];

      // Extract raw resume text from profile (profiles.csv), Supabase storage, or profile summary
      let resumeText = candidateResumeCache.get(applywizzId);
      if (resumeText === undefined) {
        resumeText = client?.additional_information?.resume_text || '';
        if (!resumeText && this.store?.client?.storage && applywizzId) {
          try {
            const { data: fileData, error: dlErr } = await this.store.client.storage
              .from('resumes')
              .download(`${applywizzId}.pdf`);
            if (!dlErr && fileData) {
              const arrayBuf = await fileData.arrayBuffer();
              const { PDFParse } = await import('pdf-parse');
              const parser = new PDFParse(new Uint8Array(arrayBuf));
              const res = await parser.getText();
              resumeText = res.text || '';
            }
          } catch {}
        }
        if (!resumeText) {
          resumeText = client?.additional_information?.experience || client?.additional_information?.role || client?.additional_information?.skills || '';
        }
        candidateResumeCache.set(applywizzId, resumeText);
      }

      const applicationId = stableId('app', `${applywizzId}|${assignment.jobKey || assignment.jobId}`);
      const current = byId.get(applicationId);

      const values = await this.resolveValues(template, client, clientHistory, globalHistory, current?.values ?? {}, resumeText, force);
      const unresolvedList = this.unresolved(template, values);

      // Status rule: Only required visible fields block status.
      // Every required visible field must have confidence >= 0.80.
      const status = unresolvedList.length === 0 ? 'answers_resolved' : 'needs_input';
      if (status === 'answers_resolved') resolvedCount++;
      else needsInputCount++;

      console.error(`[Phase 3] [Job ${assignment.jobKey || assignment.jobId} | Client ${applywizzId}] Status: ${status} (${unresolvedList.length === 0 ? 'all required fields resolved >= 0.80' : `${unresolvedList.length} required fields missing/low confidence`})`);

      byId.set(applicationId, {
        applicationId,
        userId: applywizzId,
        applywizzId,
        clientName: assignment.clientName || client?.client?.full_name,
        companyName: assignment.companyName,
        jobId: assignment.jobId,
        jobKey: assignment.jobKey || assignment.jobId,
        templateId: template.templateId,
        canonicalUrl: assignment.canonicalUrl,
        tenantHost: assignment.tenantHost,
        tenantKey: assignment.tenantKey,
        status,
        reviewStatus: current?.reviewStatus ?? 'not_ready',
        values,
        unresolvedFields: unresolvedList.map(f => f.id),
        fillResults: current?.fillResults ?? [],
        updatedAt: nowIso()
      });
    }

    const applications = [...byId.values()];
    await this.store.write('applications', applications);
    if (this.runLog) {
      await this.runLog.append('phase3.applications_resolved', {
        count: applications.length,
        resolved: resolvedCount,
        needsInput: needsInputCount
      });
    }

    const globalResolved = applications.filter(a => a.status === 'answers_resolved').length;
    const globalNeedsInput = applications.filter(a => a.status === 'needs_input').length;

    applications.target = {
      description: selector.description,
      hasFilter: selector.hasFilter,
      targetedJobsCount: targetedJobKeys.size,
      matchedTemplatesCount: matchedJobKeys.size
    };

    applications.batchSummary = {
      scope: selector.description,
      targetedJobs: targetedJobKeys.size,
      matchedTemplates: matchedJobKeys.size,
      candidateApplications: toProcess.length,
      resolved: resolvedCount,
      needsInput: needsInputCount,
      resolutionRate: toProcess.length > 0 ? `${((resolvedCount / toProcess.length) * 100).toFixed(1)}%` : '0%'
    };

    applications.globalSummary = {
      totalApplications: applications.length,
      totalResolved: globalResolved,
      totalNeedsInput: globalNeedsInput,
      globalResolutionRate: applications.length > 0 ? `${((globalResolved / applications.length) * 100).toFixed(1)}%` : '0%'
    };

    return applications;
  }

  /**
   * Resolves values for all fields in a template using the cascading resolution engine.
   */
  async resolveValues(template, client, clientHistory = [], globalHistory = [], existingValues = {}, customResumeText = null, force = false) {
    const values = {};
    const resumeText = customResumeText || client?.additional_information?.experience || client?.additional_information?.role || '';

    for (const field of flattenTemplateFields(template)) {
      if (field.repeatableGroupId) continue;

      // Preserve previously operator-reviewed values (saved manually via dashboard / saveAnswers)
      const existing = existingValues[field.id];
      const isOperatorReviewed = !force && existing && (existing.source === 'dashboard' || existing.source === 'operator' || existing.source === 'manual');
      if (isOperatorReviewed && existing.value !== null && existing.value !== undefined && existing.value !== '') {
        values[field.id] = existing;
        continue;
      }

      // Execute 3-Tier, 5-Stage Cascade
      const resolved = await this.engine.resolveField({
        field,
        client,
        clientHistory,
        globalHistory,
        resumeText
      });

      values[field.id] = resolved;
    }

    return values;
  }

  /**
   * Identifies unresolved fields.
   * Only required visible fields block status; required fields must reach confidence >= 0.80.
   */
  unresolved(template, values) {
    return flattenTemplateFields(template).filter(field => {
      if (!field.required || field.repeatableGroupId || !isFieldVisible(field, values)) {
        return false;
      }
      const entry = values[field.id];
      if (!entry) return true;
      const val = entry.value;
      if (val === null || val === undefined || val === '') return true;
      if (Array.isArray(val) && val.length === 0) return true;
      // Confidence cutoff: must be >= 0.80
      return (entry.confidence ?? 0) < 0.80;
    });
  }

  /**
   * Saves operator-verified answers from dashboard.
   * Updates applications.json and appends newly verified Q&As directly to data/question_bank.csv.
   */
  async saveAnswers(applicationId, updates) {
    let updatedApplication;

    // 1. Update application in applications store
    await this.store.update('applications', [], applications => applications.map(application => {
      if (application.applicationId !== applicationId) return application;

      const values = { ...application.values };
      for (const [fieldId, value] of Object.entries(updates)) {
        const existingEntry = values[fieldId] || {};
        values[fieldId] = {
          ...existingEntry,
          value,
          source: 'dashboard',
          stage: 'stage5_operator',
          tier: 1,
          confidence: 1.0,
          reviewed: true
        };
      }

      // Re-evaluate application status
      const templates = this.store.readSync ? this.store.readSync('form-templates', {}) : {};
      const template = templates[application.jobKey] || templates[application.jobId];
      let unresolvedList = [];
      if (template) {
        unresolvedList = this.unresolved(template, values);
      }

      const status = unresolvedList.length === 0 ? 'answers_resolved' : 'needs_input';

      updatedApplication = {
        ...application,
        status,
        values,
        unresolvedFields: unresolvedList.map(f => f.id),
        updatedAt: nowIso()
      };
      return updatedApplication;
    }));

    invariant(updatedApplication, 'APPLICATION_NOT_FOUND', `Application ${applicationId} not found`);

    // 2. Upsert confirmed answers into Supabase question_bank table or data/question_bank.csv
    try {
      const templates = await this.store.read('form-templates', {});
      const template = templates[updatedApplication.jobKey] || templates[updatedApplication.jobId];
      const templateFields = template ? flattenTemplateFields(template) : [];
      const fieldMap = new Map(templateFields.map(f => [f.id, f]));

      const timestamp = nowIso();
      const candidateId = updatedApplication.userId || updatedApplication.applywizzId || '';

      const recordsToUpsert = [];
      for (const [fieldId, value] of Object.entries(updates)) {
        if (value === null || value === undefined || value === '') continue;

        const field = fieldMap.get(fieldId);
        const questionLabel = field?.label || fieldId;
        const fieldType = field?.type || field?.role || 'text';
        const strValue = Array.isArray(value) ? JSON.stringify(value) : String(value);

        recordsToUpsert.push({
          applywizz_id: candidateId,
          question_label: questionLabel,
          field_type: fieldType,
          value: strValue,
          source: 'manual',
          confidence: 1.0
        });
      }

      if (recordsToUpsert.length > 0 && typeof this.store?.upsertQuestionBank === 'function' && this.store?.isAvailable?.()) {
        await this.store.upsertQuestionBank(recordsToUpsert);
        console.error(`[Phase 3] Question Bank synchronized to Supabase: ${recordsToUpsert.length} records`);
      }

      if (fs.existsSync(this.questionBankCsvPath)) {
        const rawCsv = await fs.promises.readFile(this.questionBankCsvPath, 'utf8');
        const existingRecords = parseCsv(rawCsv);
        let updatedCount = 0;
        let insertedCount = 0;

        for (const rec of recordsToUpsert) {
          // Find existing record for this candidate and question
          const match = existingRecords.find(r =>
            r.applywizz_id === rec.applywizz_id &&
            r.question_label?.trim().toLowerCase() === rec.question_label.trim().toLowerCase()
          );

          if (match) {
            match.value = rec.value;
            match.source = 'manual';
            match.confidence = '1.0';
            match.updated_at = timestamp;
            updatedCount++;
          } else {
            existingRecords.push({
              id: randomUUID(),
              applywizz_id: rec.applywizz_id,
              question_label: rec.question_label,
              field_type: rec.field_type,
              value: rec.value,
              source: 'manual',
              confidence: '1.0',
              created_at: timestamp,
              updated_at: timestamp
            });
            insertedCount++;
          }
        }

        const newCsv = formatCsv(existingRecords, QB_HEADERS);
        await fs.promises.writeFile(this.questionBankCsvPath, newCsv, 'utf8');
        console.error(`[Phase 3] Question Bank synchronized: ${updatedCount} updated in-place, ${insertedCount} newly inserted`);
      }
    } catch (err) {
      console.error('[Phase 3] Warning: Failed to upsert answers to question_bank:', err.message);
    }

    // 3. Update legacy question-bank store for backward compatibility
    await this.store.update('question-bank', {}, bank => {
      const userBank = { ...(bank[updatedApplication.userId] ?? {}) };
      for (const [fieldId, value] of Object.entries(updates)) {
        userBank[fieldId] = { value, valueType: valueType(value), updatedAt: nowIso() };
      }
      return { ...bank, [updatedApplication.userId]: userBank };
    });

    if (this.runLog) {
      await this.runLog.append('phase3.answers_saved', {
        applicationId,
        fields: Object.keys(updates)
      });
    }

    console.error(`[Phase 3] [Job ${updatedApplication.jobId} | Client ${updatedApplication.userId}] ${Object.keys(updates).length} answers saved`);
    return updatedApplication;
  }
}
