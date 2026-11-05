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
    this.questionBankCsvPath = cfg?.questionBankCsvPath ?? path.resolve(process.cwd(), 'data/question_bank.csv');
  }

  /**
   * Loads and indexes historical records from data/question_bank.csv.
   */
  async loadQuestionBank() {
    try {
      if (!fs.existsSync(this.questionBankCsvPath)) {
        return { clientHistoryMap: new Map(), globalHistory: [] };
      }
      const raw = await fs.promises.readFile(this.questionBankCsvPath, 'utf8');
      const records = parseCsv(raw);

      const clientHistoryMap = new Map();
      const globalHistory = [];

      for (const record of records) {
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
   * Loads candidate profiles from data/clients.json.
   */
  async loadClients() {
    try {
      if (fs.existsSync(this.clientsPath)) {
        const raw = await fs.promises.readFile(this.clientsPath, 'utf8');
        return JSON.parse(raw);
      }
      return await this.store.read('clients', {});
    } catch (err) {
      console.error('[Phase 3] Warning: Failed to load clients.json:', err.message);
      return {};
    }
  }

  /**
   * Creates or resolves application instances across all assignments that have templates.
   */
  async createOrResolveApplications({ limit, jobKey, jobUrl } = {}) {
    const jobs = await this.store.read('jobs', { assignments: [], uniqueJobs: [] });
    const templates = await this.store.read('form-templates', {});
    const existing = await this.store.read('applications', []);
    const byId = new Map(existing.map(application => [application.applicationId, application]));

    const [clients, { clientHistoryMap, globalHistory }] = await Promise.all([
      this.loadClients(),
      this.loadQuestionBank()
    ]);

    let assignments = jobs.assignments || [];
    if (jobKey) {
      const keys = Array.isArray(jobKey)
        ? jobKey
        : String(jobKey).split(',').map(k => k.trim()).filter(Boolean);
      const keySet = new Set(keys);
      assignments = assignments.filter(a => keySet.has(a.jobKey) || keySet.has(a.jobId));
    }
    if (jobUrl) {
      assignments = assignments.filter(a => a.canonicalUrl === jobUrl || a.originalUrl === jobUrl);
    }

    // Filter to assignments that have scanned templates
    assignments = assignments.filter(a => Boolean(templates[a.jobKey] || templates[a.jobId]));
    if (limit && limit > 0) {
      assignments = assignments.slice(0, limit);
    }

    let resolvedCount = 0;
    let needsInputCount = 0;

    for (const assignment of assignments) {
      const template = templates[assignment.jobKey] || templates[assignment.jobId];

      const applywizzId = assignment.applywizzId || assignment.userId;
      const client = clients[applywizzId];
      const clientHistory = clientHistoryMap.get(applywizzId) || [];

      const applicationId = stableId('app', `${applywizzId}|${assignment.jobKey || assignment.jobId}`);
      const current = byId.get(applicationId);

      const values = await this.resolveValues(template, client, clientHistory, globalHistory, current?.values ?? {});
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

    return applications;
  }

  /**
   * Resolves values for all fields in a template using the cascading resolution engine.
   */
  async resolveValues(template, client, clientHistory = [], globalHistory = [], existingValues = {}) {
    const values = {};
    const resumeText = client?.additional_information?.experience || client?.additional_information?.role || '';

    for (const field of flattenTemplateFields(template)) {
      if (field.repeatableGroupId) continue;

      // Preserve previously operator-reviewed values
      const existing = existingValues[field.id];
      if (existing?.reviewed === true && existing?.value !== null && existing?.value !== undefined && existing?.value !== '') {
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

    // 2. Upsert confirmed answers into data/question_bank.csv (in-place modification, no duplicates)
    try {
      const templates = await this.store.read('form-templates', {});
      const template = templates[updatedApplication.jobKey] || templates[updatedApplication.jobId];
      const templateFields = template ? flattenTemplateFields(template) : [];
      const fieldMap = new Map(templateFields.map(f => [f.id, f]));

      const timestamp = nowIso();
      const candidateId = updatedApplication.userId || updatedApplication.applywizzId || '';

      if (fs.existsSync(this.questionBankCsvPath)) {
        const rawCsv = await fs.promises.readFile(this.questionBankCsvPath, 'utf8');
        const existingRecords = parseCsv(rawCsv);
        let updatedCount = 0;
        let insertedCount = 0;

        for (const [fieldId, value] of Object.entries(updates)) {
          if (value === null || value === undefined || value === '') continue;

          const field = fieldMap.get(fieldId);
          const questionLabel = field?.label || fieldId;
          const fieldType = field?.type || field?.role || 'text';
          const strValue = Array.isArray(value) ? JSON.stringify(value) : String(value);

          // Find existing record for this candidate and question
          const match = existingRecords.find(r =>
            r.applywizz_id === candidateId &&
            r.question_label?.trim().toLowerCase() === questionLabel.trim().toLowerCase()
          );

          if (match) {
            match.value = strValue;
            match.source = 'manual';
            match.confidence = '1.0';
            match.updated_at = timestamp;
            updatedCount++;
          } else {
            existingRecords.push({
              id: randomUUID(),
              applywizz_id: candidateId,
              question_label: questionLabel,
              field_type: fieldType,
              value: strValue,
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
      console.error('[Phase 3] Warning: Failed to upsert answers to question_bank.csv:', err.message);
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
