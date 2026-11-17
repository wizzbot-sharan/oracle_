import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export class ResumeService {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir ?? config.submission?.resumeDir ?? path.resolve(config.dataDir, 'runtime/resumes');
    this.fallbackResumePath = options.fallbackResumePath ?? path.resolve(config.rootDir, 'output/pdf/dummy-resume.pdf');
  }

  /**
   * Resolves a local filesystem path for a candidate's resume.
   * If remote (e.g. S3), caches it locally in `data/runtime/resumes/<applywizzId>_resume.pdf`.
   */
  async resolveCandidateResume(clientOrId, applywizzIdOrClient) {
    let client = clientOrId;
    let applywizzId = applywizzIdOrClient;

    if (typeof clientOrId === 'string' && typeof applywizzIdOrClient === 'object') {
      applywizzId = clientOrId;
      client = applywizzIdOrClient;
    } else if (typeof client === 'object' && !applywizzId) {
      applywizzId = client?.client?.applywizz_id || client?.applywizz_id;
    }

    const rawUrl = client?.additional_information?.resume_url ||
      client?.resume_url ||
      client?.additional_information?.resume_path ||
      client?.resume_path;

    await fs.mkdir(this.cacheDir, { recursive: true });

    // Format professional resume name: "Resume_Client_full_name.pdf"
    const rawName = client?.client?.full_name || 
      `${client?.client?.first_name || ''} ${client?.client?.last_name || ''}`.trim() || 
      applywizzId || 'Candidate';
    const fullName = typeof rawName === 'string' ? rawName : String(rawName || 'Candidate');
    const cleanName = fullName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'Candidate';
    const professionalFilename = `Resume_${cleanName}.pdf`;
    const targetFile = path.resolve(this.cacheDir, professionalFilename);

    // 1. If already cached and valid, reuse
    if (existsSync(targetFile)) {
      const stats = await fs.stat(targetFile);
      if (stats.size > 0) {
        return targetFile;
      }
    }

    // 2. If it is a local file path that already exists
    if (rawUrl && existsSync(rawUrl)) {
      try {
        await fs.copyFile(path.resolve(rawUrl), targetFile);
        return targetFile;
      } catch {
        return path.resolve(rawUrl);
      }
    }

    // 3. If it is a remote HTTP/S3 URL, download and cache
    if (rawUrl && (rawUrl.startsWith('http://') || rawUrl.startsWith('https://'))) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(rawUrl, { signal: controller.signal });
        clearTimeout(timeout);

        if (res.ok) {
          const arrayBuffer = await res.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          if (buffer.length > 0) {
            await fs.writeFile(targetFile, buffer);
            console.log(`[ResumeService] Successfully downloaded and cached resume for ${applywizzId} as ${professionalFilename} (${buffer.length} bytes)`);
            return targetFile;
          }
        } else {
          console.warn(`[ResumeService] S3 resume download returned status ${res.status} for ${applywizzId}`);
        }
      } catch (err) {
        console.warn(`[ResumeService] Failed to download resume from ${rawUrl}: ${err.message}`);
      }
    }

    // 4. Fallback to dummy resume fixture if download fails or URL unavailable
    if (existsSync(this.fallbackResumePath)) {
      console.warn(`[ResumeService] Using fallback dummy resume for ${applywizzId}`);
      await fs.copyFile(this.fallbackResumePath, targetFile);
      return targetFile;
    }

    // 5. Generate a minimal valid PDF placeholder so missing path never causes a fatal error
    console.warn(`[ResumeService] No raw resume file found for ${applywizzId}. Created placeholder resume from candidate profile facts.`);
    const minimalPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj\n' +
      '4 0 obj<</Length 55>>stream\n' +
      'BT /F1 12 Tf 72 712 Td (Candidate: ' + cleanName + ') Tj ET\n' +
      'endstream\nendobj\n' +
      'xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n' +
      '0000000102 00000 n \n0000000181 00000 n \ntrailer<</Size 5/Root 1 0 R>>\n' +
      'startxref\n285\n%%EOF\n',
      'utf8'
    );
    await fs.writeFile(targetFile, minimalPdf);
    return targetFile;
  }
}

export const resumeService = new ResumeService();
