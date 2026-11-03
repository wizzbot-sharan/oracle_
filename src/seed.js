import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { stableId } from './shared/ids.js';
import { workflow } from './workflow.js';

export async function seedReconData() {
  const jobs = await workflow.phase1.ingestCsv(config.jobsCsvPath);
  const reconPath = path.join(config.rootDir, 'recon/job-20283127.form-template.json');
  const template = JSON.parse(await fs.readFile(reconPath, 'utf8'));
  template.templateId = template.templateId ?? stableId('tpl', `${template.source.canonicalUrl}|recon`);
  template.version = template.version ?? 1;
  const templates = await workflow.store.read('form-templates', {});
  if (!templates[template.source.jobId]) {
    templates[template.source.jobId] = template;
    await workflow.store.write('form-templates', templates);
  }
  const applications = await workflow.phase3.createOrResolveApplications();
  return { jobs: jobs.assignments.length, templates: Object.keys(templates).length, applications: applications.length };
}
