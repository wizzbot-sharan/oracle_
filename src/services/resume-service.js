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
  async resolveCandidateResume(client, applywizzId) {
    const rawUrl = client?.additional_information?.resume_url ||
      client?.resume_url ||
      client?.additional_information?.resume_path ||
      client?.resume_path;

    await fs.mkdir(this.cacheDir, { recursive: true });
    const targetFile = path.resolve(this.cacheDir, `${applywizzId || 'candidate'}_resume.pdf`);

    // 1. If already cached and valid, reuse
    if (existsSync(targetFile)) {
      const stats = await fs.stat(targetFile);
      if (stats.size > 0) {
        return targetFile;
      }
    }

    // 2. If it is a local file path that already exists
    if (rawUrl && existsSync(rawUrl)) {
      return path.resolve(rawUrl);
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
            console.error(`[ResumeService] Successfully downloaded and cached resume for ${applywizzId} (${buffer.length} bytes)`);
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

    throw new Error(`Unable to resolve resume for candidate ${applywizzId}`);
  }
}

export const resumeService = new ResumeService();
