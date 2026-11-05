import fs from 'node:fs/promises';
import path from 'node:path';
import { flattenTemplateFields, isFieldVisible } from '../domain/form-template.js';
import { invariant } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import { resumeService } from '../services/resume-service.js';
import { config } from '../config.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Phase4ApplyReviewSubmit {
  constructor({ store, runLog, oracle, phase1, sessions, resumeService: customResumeService, config: customConfig }) {
    this.store = store;
    this.runLog = runLog;
    this.oracle = oracle;
    this.phase1 = phase1;
    this.sessions = sessions;
    this.resumeService = customResumeService ?? resumeService;
    this.config = customConfig ?? config;
  }

  async #loadClients() {
    try {
      const raw = await fs.readFile(this.config.clientsPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  async prepare(applicationId) {
    const application = await this.#application(applicationId);
    const clients = await this.#loadClients();
    const users = await this.store.read('users', {});
    const templates = await this.store.read('form-templates', {});

    const applywizzId = application.applywizzId || application.userId;
    const client = clients[applywizzId] || clients[application.userId];
    const user = users[application.userId] || {};

    const candidateEmail = client?.client?.company_email || client?.company_email || user.email;
    invariant(candidateEmail, 'USER_EMAIL_MISSING', `No company email configured for candidate ${applywizzId || application.userId}`);

    const template = templates[application.jobKey] || templates[application.jobId];
    invariant(template, 'TEMPLATE_MISSING', `No form template for job ${application.jobKey || application.jobId}`);

    // Resolve candidate resume to local file path
    let candidateResumePath = null;
    try {
      candidateResumePath = await this.resumeService.resolveCandidateResume(client, applywizzId);
    } catch (err) {
      console.warn(`[Phase 4] Resume resolution note for ${applywizzId}: ${err.message}`);
    }

    const effectiveValues = structuredClone(application.values || {});
    const files = { ...(user.files || {}) };

    for (const field of flattenTemplateFields(template)) {
      if (field.type === 'file') {
        const isResume = field.id?.toLowerCase().includes('resume') || field.label?.toLowerCase().includes('resume');
        if (isResume && candidateResumePath) {
          effectiveValues[field.id] = {
            value: candidateResumePath,
            source: 'candidate_resume',
            confidence: 1,
            reviewed: true
          };
          files[field.id] = candidateResumePath;
        } else if (user.files?.[field.id]) {
          effectiveValues[field.id] = {
            value: user.files[field.id],
            source: 'user_files',
            confidence: 1,
            reviewed: true
          };
          files[field.id] = user.files[field.id];
        }
      }
    }

    const missing = flattenTemplateFields(template).filter(field =>
      field.required && !field.repeatableGroupId && isFieldVisible(field, effectiveValues) && !effectiveValues[field.id]?.value
    );
    invariant(!missing.length, 'UNRESOLVED_REQUIRED_FIELDS', 'Required answers are still missing', { fields: missing.map(field => field.id) });

    const job = {
      jobId: application.jobId,
      jobKey: application.jobKey || application.jobId,
      canonicalUrl: application.canonicalUrl,
      tenantHost: application.tenantHost,
      tenantKey: application.tenantKey
    };

    console.log(`[Phase 4] Authenticating ${applywizzId} using real candidate company_email: ${candidateEmail}...`);
    const { session, result } = await this.phase1.authenticate({ applicationId, job, email: candidateEmail });
    if (result?.status === 'skipped') {
      if (session) await this.oracle.closeSession(session).catch(() => {});
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
      files,
      context: { jobId: application.jobId, userId: applywizzId }
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
    invariant(application.reviewStatus === 'approved' || application.status === 'needs_review', 'REVIEW_NOT_APPROVED', 'Review approval is required before submission');
    invariant(
      confirmation === application.jobId || confirmation === application.jobKey,
      'SUBMIT_CONFIRMATION_MISMATCH',
      'Type the exact job ID to confirm submission'
    );

    const session = this.sessions.get(applicationId);
    invariant(session, 'LIVE_SESSION_MISSING', 'The reviewed browser session has expired; prepare the application again');

    const submitResult = await this.oracle.clickSubmit({ session });

    // 10-second post-submit wait for confirmation page settlement
    const submitWaitMs = this.config?.submission?.submitWaitMs ?? 10000;
    console.log(`[Phase 4] [${applicationId}] Waiting ${submitWaitMs / 1000}s post-submit settlement on site...`);
    await delay(submitWaitMs);

    // Capture receipt screenshot
    const submitDir = this.config?.submission?.submitDir ?? path.resolve(this.config.dataDir, 'submit');
    await fs.mkdir(submitDir, { recursive: true });

    const applywizzId = application.applywizzId || application.userId || 'candidate';
    const jobKey = application.jobKey || application.jobId || 'job';
    const receiptFilename = `${applywizzId}_${jobKey}_receipt.png`;
    const receiptPath = path.resolve(submitDir, receiptFilename);

    try {
      if (session.page && !session.page.isClosed?.()) {
        await session.page.screenshot({ path: receiptPath, fullPage: true });
        console.log(`[Phase 4] [${applicationId}] Saved receipt screenshot to ${receiptPath}`);
      }
    } catch (err) {
      console.warn(`[Phase 4] [${applicationId}] Receipt screenshot warning: ${err.message}`);
    }

    const receipt = {
      ...(submitResult || {}),
      screenshotPath: receiptPath,
      filename: receiptFilename,
      submittedAt: nowIso()
    };

    await this.oracle.closeSession(session).catch(() => {});
    this.sessions.delete(applicationId);

    const updated = await this.#patch(applicationId, {
      status: 'submitted',
      reviewStatus: 'submitted',
      receipt,
      updatedAt: nowIso()
    });
    await this.runLog.append('phase4.submitted', { applicationId, jobId: application.jobId, receiptFilename });
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
