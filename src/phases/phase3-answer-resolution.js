import { flattenTemplateFields, isFieldVisible, valueType } from '../domain/form-template.js';
import { stableId } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import { invariant } from '../shared/errors.js';

export class Phase3AnswerResolution {
  constructor({ store, runLog }) {
    this.store = store;
    this.runLog = runLog;
  }

  async createOrResolveApplications() {
    const jobs = await this.store.read('jobs', { assignments: [], uniqueJobs: [] });
    const templates = await this.store.read('form-templates', {});
    const bank = await this.store.read('question-bank', {});
    const [existing, users] = await Promise.all([
      this.store.read('applications', []),
      this.store.read('users', {})
    ]);
    const byId = new Map(existing.map(application => [application.applicationId, application]));

    for (const assignment of jobs.assignments) {
      const template = templates[assignment.jobId];
      if (!template) continue;
      const applicationId = stableId('app', `${assignment.userId}|${assignment.jobId}`);
      const current = byId.get(applicationId);
      const values = this.resolveValues(template, bank[assignment.userId] ?? {}, current?.values ?? {}, users[assignment.userId]?.files ?? {});
      const unresolvedList = this.unresolved(template, values);
      const status = unresolvedList.length ? 'needs_input' : 'answers_resolved';
      console.error(`[Phase 3] [Job ${assignment.jobId} | User ${assignment.userId}] Status: ${status} (${unresolvedList.length === 0 ? 'all required fields resolved' : `${unresolvedList.length} required fields missing`})`);

      byId.set(applicationId, {
        applicationId,
        userId: assignment.userId,
        jobId: assignment.jobId,
        templateId: template.templateId,
        canonicalUrl: assignment.canonicalUrl,
        tenantHost: assignment.tenantHost,
        tenantKey: assignment.tenantKey,
        status,
        reviewStatus: current?.reviewStatus ?? 'not_ready',
        values,
        fillResults: current?.fillResults ?? [],
        updatedAt: nowIso()
      });
    }

    const applications = [...byId.values()];
    await this.store.write('applications', applications);
    await this.runLog.append('phase3.applications_resolved', { count: applications.length });
    return applications;
  }

  resolveValues(template, userBank, existingValues = {}, userFiles = {}) {
    const values = {};
    for (const field of flattenTemplateFields(template)) {
      if (field.repeatableGroupId) continue;
      const existing = existingValues[field.id];
      const bankEntry = userBank[field.id];
      values[field.id] = field.type === 'file' && userFiles[field.id]
        ? { value: userFiles[field.id], source: 'user_files', confidence: 1, reviewed: true }
        : existing?.value !== null && existing?.value !== undefined && existing?.value !== ''
          ? existing
          : bankEntry
        ? { value: bankEntry.value, source: 'question_bank', confidence: 1, reviewed: true }
        : existing ?? { value: null, source: null, confidence: 0, reviewed: false };
    }
    return values;
  }

  unresolved(template, values) {
    return flattenTemplateFields(template).filter(field => {
      if (!field.required || field.repeatableGroupId || !isFieldVisible(field, values)) return false;
      const val = values[field.id]?.value;
      return val === null || val === undefined || val === '' || (Array.isArray(val) && val.length === 0);
    });
  }

  async saveAnswers(applicationId, updates) {
    let updatedApplication;
    await this.store.update('applications', [], applications => applications.map(application => {
      if (application.applicationId !== applicationId) return application;
      const values = { ...application.values };
      for (const [fieldId, value] of Object.entries(updates)) {
        invariant(fieldId in values, 'UNKNOWN_FIELD', `Unknown field ${fieldId}`);
        values[fieldId] = { value, source: 'dashboard', confidence: 1, reviewed: true };
      }
      updatedApplication = { ...application, values, updatedAt: nowIso() };
      return updatedApplication;
    }));
    invariant(updatedApplication, 'APPLICATION_NOT_FOUND', `Application ${applicationId} not found`);

    await this.store.update('question-bank', {}, bank => {
      const userBank = { ...(bank[updatedApplication.userId] ?? {}) };
      for (const [fieldId, value] of Object.entries(updates)) {
        userBank[fieldId] = { value, valueType: valueType(value), updatedAt: nowIso() };
      }
      return { ...bank, [updatedApplication.userId]: userBank };
    });
    await this.runLog.append('phase3.answers_saved', { applicationId, fields: Object.keys(updates) });
    console.error(`[Phase 3] [Job ${updatedApplication.jobId} | User ${updatedApplication.userId}] ${Object.keys(updates).length} answers saved`);
    return updatedApplication;
  }
}
