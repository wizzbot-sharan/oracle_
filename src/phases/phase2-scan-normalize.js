import { stableId } from '../shared/ids.js';

export class Phase2ScanNormalize {
  constructor({ store, runLog, oracle }) {
    this.store = store;
    this.runLog = runLog;
    this.oracle = oracle;
  }

  async scan({ session, job }) {
    const scanned = await this.oracle.scanForm({ session, job });
    const template = this.#applyConditions(scanned);
    const templates = await this.store.read('form-templates', {});
    const primaryKey = job.jobKey ?? job.jobId;
    const version = (templates[primaryKey]?.version ?? 0) + 1;
    const templateId = stableId('tpl', `${job.canonicalUrl}|${template.scan.scannedAt}`);
    const versioned = {
      templateId,
      version,
      jobKey: job.jobKey ?? primaryKey,
      jobUrl: job.jobUrl ?? job.canonicalUrl,
      ...template
    };
    await this.store.update('form-templates', {}, current => ({ ...current, [primaryKey]: versioned }));
    await this.runLog.append('phase2.template_ready', {
      jobId: job.jobId,
      jobKey: primaryKey,
      templateId,
      fields: template.fields.length,
      branches: template.conditionalBranches.length
    });
    return versioned;
  }

  #applyConditions(template) {
    const identity = field => `${field.sourceName ?? ''}|${field.role ?? field.type}|${field.label.toLowerCase()}`;
    const fields = new Map(template.fields.map(field => [identity(field), structuredClone(field)]));
    for (const branch of template.conditionalBranches) {
      for (const revealed of branch.revealed) {
        if (!fields.has(identity(revealed))) fields.set(identity(revealed), structuredClone(revealed));
      }
    }
    const allFields = [...fields.values()];
    const byLabel = new Map(allFields.map(field => [field.label, field]));
    const depth = condition => condition?.all?.length ?? (condition ? 1 : 0);

    for (const branch of template.conditionalBranches) {
      const path = branch.path ?? [{ triggerLabel: branch.triggerLabel, triggerValue: branch.triggerValue }];
      const terms = path.map(step => {
        const parentField = byLabel.get(step.triggerLabel);
        const isMulti = parentField?.type === 'multi-checkbox';
        return isMulti || step.conditionType === 'includes'
          ? { field: parentField?.id, includes: step.triggerValue }
          : { field: parentField?.id, equals: step.triggerValue };
      }).filter(term => term.field);
      const visibleWhen = terms.length > 1 ? { all: terms } : terms[0];
      if (!visibleWhen) continue;
      for (const revealed of branch.revealed) {
        const field = fields.get(identity(revealed));
        if (depth(visibleWhen) >= depth(field.visibleWhen)) field.visibleWhen = visibleWhen;
      }
    }
    return { ...template, fields: [...fields.values()] };
  }
}
