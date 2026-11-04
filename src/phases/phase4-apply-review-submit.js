import { flattenTemplateFields, isFieldVisible } from '../domain/form-template.js';
import { invariant } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';

export class Phase4ApplyReviewSubmit {
  constructor({ store, runLog, oracle, phase1, sessions }) {
    this.store = store;
    this.runLog = runLog;
    this.oracle = oracle;
    this.phase1 = phase1;
    this.sessions = sessions;
  }

  async prepare(applicationId) {
    const application = await this.#application(applicationId);
    const users = await this.store.read('users', {});
    const templates = await this.store.read('form-templates', {});
    const user = users[application.userId];
    const template = templates[application.jobId];
    invariant(user?.email, 'USER_EMAIL_MISSING', `No email configured for ${application.userId}`);
    invariant(template, 'TEMPLATE_MISSING', `No form template for job ${application.jobId}`);

    const effectiveValues = structuredClone(application.values);
    for (const field of flattenTemplateFields(template)) {
      if (field.type === 'file' && user.files?.[field.id]) {
        effectiveValues[field.id] = { value: user.files[field.id], source: 'user_files', confidence: 1, reviewed: true };
      }
    }
    const missing = flattenTemplateFields(template).filter(field =>
      field.required && !field.repeatableGroupId && isFieldVisible(field, effectiveValues) && !effectiveValues[field.id]?.value
    );
    invariant(!missing.length, 'UNRESOLVED_REQUIRED_FIELDS', 'Required answers are still missing', { fields: missing.map(field => field.id) });

    const job = {
      jobId: application.jobId,
      canonicalUrl: application.canonicalUrl,
      tenantHost: application.tenantHost,
      tenantKey: application.tenantKey
    };
    const { session, result } = await this.phase1.authenticate({ applicationId, job, email: user.email });
    if (result?.status === 'skipped') {
      if (session) await this.oracle.closeSession(session);
      const updated = await this.#patch(applicationId, {
        status: result.reason === 'ALREADY_APPLIED' ? 'already_applied' : 'skipped',
        reviewStatus: 'skipped',
        skipReason: result.reason,
        skipMessage: result.message,
        updatedAt: nowIso()
      });
      await this.runLog.append('phase4.skipped', { applicationId, reason: result.reason });
      return updated;
    }
    this.sessions.set(applicationId, session);
    const fillTemplate = { ...template, fields: flattenTemplateFields(template).filter(field => !field.repeatableGroupId) };
    const fillResults = await this.oracle.fillApplication({
      session,
      template: fillTemplate,
      values: effectiveValues,
      files: user.files ?? {},
      context: { jobId: application.jobId, userId: application.userId }
    });
    const failures = fillResults.filter(result => result.status === 'failed');
    const updated = await this.#patch(applicationId, {
      status: failures.length ? 'fill_failed' : 'needs_review',
      reviewStatus: failures.length ? 'not_ready' : 'pending',
      fillResults,
      updatedAt: nowIso()
    });
    await this.runLog.append('phase4.fill_complete', { applicationId, failures: failures.length });
    return updated;
  }

  async approve(applicationId) {
    const application = await this.#application(applicationId);
    invariant(application.status === 'needs_review', 'NOT_REVIEW_READY', 'Application is not ready for review approval');
    invariant(application.fillResults.every(result => result.status === 'verified'), 'UNVERIFIED_FIELDS', 'Every filled field must be verified');
    const updated = await this.#patch(applicationId, { reviewStatus: 'approved', status: 'approved', updatedAt: nowIso() });
    await this.runLog.append('phase4.review_approved', { applicationId });
    return updated;
  }

  async submit(applicationId, confirmation) {
    const application = await this.#application(applicationId);
    invariant(application.reviewStatus === 'approved', 'REVIEW_NOT_APPROVED', 'Review approval is required before submission');
    invariant(confirmation === application.jobId, 'SUBMIT_CONFIRMATION_MISMATCH', 'Type the exact job ID to confirm submission');
    const session = this.sessions.get(applicationId);
    invariant(session, 'LIVE_SESSION_MISSING', 'The reviewed browser session has expired; prepare the application again');
    const receipt = await this.oracle.clickSubmit({ session });
    await this.oracle.closeSession(session);
    this.sessions.delete(applicationId);
    const updated = await this.#patch(applicationId, { status: 'submitted', reviewStatus: 'submitted', receipt, updatedAt: nowIso() });
    await this.runLog.append('phase4.submitted', { applicationId, jobId: application.jobId });
    return updated;
  }

  async #application(applicationId) {
    const applications = await this.store.read('applications', []);
    const application = applications.find(item => item.applicationId === applicationId);
    invariant(application, 'APPLICATION_NOT_FOUND', `Application ${applicationId} not found`);
    return application;
  }

  async #patch(applicationId, patch) {
    let updated;
    await this.store.update('applications', [], applications => applications.map(application => {
      if (application.applicationId !== applicationId) return application;
      updated = { ...application, ...patch };
      return updated;
    }));
    return updated;
  }
}
