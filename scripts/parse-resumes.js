#!/usr/bin/env node
/**
 * Standalone Resume Parser CLI
 *
 * Extracts structured ATS intelligence from candidate resumes (S3 PDF, Supabase bucket, or local file)
 * using Claude LLM with exponential backoff, rate limiting, and dual Supabase/local persistence.
 *
 * Usage:
 *   node scripts/parse-resumes.js --client AWL-4593
 *   node scripts/parse-resumes.js --file ./resumes/sample.pdf --client AWL-TEST
 *   node scripts/parse-resumes.js --unparsed
 *   node scripts/parse-resumes.js --all
 *   node scripts/parse-resumes.js --client AWL-4593 --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { SupabaseStore } from '../src/storage/supabase-store.js';
import { ResumeService } from '../src/services/resume-service.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CLIENTS_JSON_PATH = path.join(ROOT_DIR, 'data', 'clients.json');
const RESUME_PARSED_JSON_PATH = path.join(ROOT_DIR, 'data', 'resume_parsed.json');

const PARSE_DELAY_MS = 1500;
const DEFAULT_MODEL = process.env.ANTHROPIC_RESUME_MODEL || process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';

/**
 * Extracts raw text from a PDF Buffer or Uint8Array using pdf-parse
 */
export async function extractTextFromPdf(buffer) {
  if (!buffer || buffer.length === 0) return '';
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse(new Uint8Array(buffer));
    const res = await parser.getText();
    return (res.text || '').trim();
  } catch (err) {
    console.warn(`[ResumeParser] pdf-parse error: ${err.message}`);
    return '';
  }
}

/**
 * Robustly parses Claude JSON response (handles fences, preambles, and salvages)
 */
export function parseClaudeJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  // 2. Search for outermost JSON object { ... }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  // 3. Salvage truncated JSON (e.g. cut off near end of token limit)
  if (firstBrace !== -1) {
    let candidate = cleaned.slice(firstBrace);
    // Remove trailing partial string or dangling property
    candidate = candidate.replace(/,\s*"[^"]*"?\s*:?\s*[^,}\]]*$/, '');
    // Count open/close braces and brackets to balance
    let openBraces = 0;
    let openBrackets = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < candidate.length; i++) {
      const ch = candidate[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === '{') openBraces++;
        else if (ch === '}') openBraces--;
        else if (ch === '[') openBrackets++;
        else if (ch === ']') openBrackets--;
      }
    }

    // Close any unclosed string
    if (inString) candidate += '"';
    // Close unclosed arrays and objects
    while (openBrackets > 0) {
      candidate += ']';
      openBrackets--;
    }
    while (openBraces > 0) {
      candidate += '}';
      openBraces--;
    }

    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

/**
 * Calls Anthropic Messages API with retry and backoff
 */
async function callAnthropicWithRetry({ apiKey, model, messages, maxTokens = 8192, maxRetries = 3 }) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
        messages
      })
    });

    if (response.ok) return response;

    if ((response.status === 429 || response.status === 529 || response.status >= 500) && attempt < maxRetries) {
      let retryAfterSec = 0;
      try {
        const rawHeader = response.headers?.get?.('retry-after');
        if (rawHeader) retryAfterSec = Number(rawHeader) || 0;
      } catch {}
      const backoffMs = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.pow(2, attempt) * 2000;
      console.warn(`[ResumeParser] Received HTTP ${response.status}. Retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, backoffMs));
      continue;
    }

    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status} ${response.statusText}: ${errText}`);
  }
}

/**
 * Builds the structured parsing prompt for Claude
 */
export function buildParserPrompt(rawResumeText, clientHint = {}) {
  const hintStr = clientHint?.client?.full_name ? `Known candidate name: "${clientHint.client.full_name}"` : '';

  return `You are an expert ATS (Applicant Tracking System) resume extraction engine.
Analyze the following resume text and convert it into a complete, pristine, structured JSON record matching the exact standardized schema below.

Candidate Context Hint: ${hintStr}

Resume Text:
"""
${rawResumeText}
"""

Instructions:
1. Extract candidate personal information accurately:
   - full_name, first_name, last_name
   - email, phone
   - city, state, country
   - current_title (e.g. "Java Full Stack Developer", "Financial Analyst", "Data Engineer")
   - years_of_experience (numeric float representing total years of professional experience, e.g. 4.0, 5.5)
   - highest_education_level (e.g. "Master's Degree", "Bachelor's Degree", "Doctorate")
   - linkedin_url, portfolio_url
   - professional_summary (the introductory summary paragraph)
2. Extract Technical Skills into 9 standard categories:
   - programming_languages: string[]
   - backend_development: string[]
   - frontend_development: string[]
   - databases: string[]
   - cloud_and_deployment: string[]
   - build_and_ci_cd_tools: string[]
   - testing_and_api_tools: string[]
   - ai_integration: string[]
   - monitoring_and_collaboration: string[]
   If the resume lists other technical skill categories, place them in additional keys under technical_skills.
   Also provide a deduplicated, flattened array of all individual skills in "skills": string[].
3. Extract domain_expertise: string[] (e.g. ["Healthcare", "Retail", "Banking", "FinTech", "E-Commerce"]).
4. Extract work_experience: Array of objects ordered from most recent to oldest:
   - employer: company / organization name
   - title: job title
   - start_date: month/year (e.g. "Jul 2025" or "07/2025")
   - end_date: month/year or "Present"
   - current: boolean (true if currently working there)
   - location: city, state or country
   - description: brief summary or first bullet
   - highlights: string[] (the top 4-6 most impactful bullet points from this experience)
5. Extract education: Array of objects:
   - institution: university or college name
   - degree: full degree title (e.g. "Master of Science in Computer Science")
   - major: field of study (e.g. "Computer Science")
   - start_date: month/year or year
   - end_date: month/year or year
   - graduation_year: 4-digit string
   - location: city, state, country
   - gpa: string or null
6. Extract projects: Array of objects:
   - name: project title
   - technologies: string[]
   - description: summary string
   - highlights: string[]
7. Extract certifications: Array of objects:
   - name: certification title
   - issuer: organization/platform (e.g. "Coursera", "LinkedIn Learning", "AWS", "Oracle")
   - year: 4-digit string or null

Return STRICTLY a JSON object matching this schema with no markdown explanations:
{
  "full_name": "string",
  "first_name": "string",
  "last_name": "string",
  "email": "string",
  "phone": "string",
  "city": "string",
  "state": "string",
  "country": "string",
  "current_title": "string",
  "years_of_experience": 4.0,
  "highest_education_level": "Master's Degree",
  "linkedin_url": "string",
  "portfolio_url": "string",
  "professional_summary": "string",
  "domain_expertise": ["string"],
  "technical_skills": {
    "programming_languages": ["string"],
    "backend_development": ["string"],
    "frontend_development": ["string"],
    "databases": ["string"],
    "cloud_and_deployment": ["string"],
    "build_and_ci_cd_tools": ["string"],
    "testing_and_api_tools": ["string"],
    "ai_integration": ["string"],
    "monitoring_and_collaboration": ["string"]
  },
  "skills": ["string"],
  "work_experience": [
    {
      "employer": "string",
      "title": "string",
      "start_date": "string",
      "end_date": "string",
      "current": true,
      "location": "string",
      "description": "string",
      "highlights": ["string"]
    }
  ],
  "education": [
    {
      "institution": "string",
      "degree": "string",
      "major": "string",
      "start_date": "string",
      "end_date": "string",
      "graduation_year": "string",
      "location": "string",
      "gpa": "string"
    }
  ],
  "projects": [
    {
      "name": "string",
      "technologies": ["string"],
      "description": "string",
      "highlights": ["string"]
    }
  ],
  "certifications": [
    {
      "name": "string",
      "issuer": "string",
      "year": "string"
    }
  ]
}`;
}

/**
 * Parses a single candidate's resume through Claude
 */
export async function parseResumeWithClaude({
  apiKey,
  model = DEFAULT_MODEL,
  rawResumeText,
  clientHint = {}
}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required to parse resumes');
  if (!rawResumeText || rawResumeText.trim().length < 50) {
    throw new Error('Resume text is empty or too short to parse');
  }

  const prompt = buildParserPrompt(rawResumeText, clientHint);

  const response = await callAnthropicWithRetry({
    apiKey,
    model,
    messages: [{ role: 'user', content: prompt }]
  });

  const data = await response.json();
  const rawContent = Array.isArray(data.content)
    ? data.content.filter(b => (b.type === 'text' || !b.type) && typeof b.text === 'string').map(b => b.text).join('\n')
    : (typeof data.content === 'string' ? data.content : '');

  const parsed = parseClaudeJson(rawContent);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Failed to parse valid JSON from Claude response. Raw preview: ${rawContent.slice(0, 200)}`);
  }

  return parsed;
}

// ----------------------------------------------------------------------------
// CLI Runner
// ----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const clientArg = getArg('--client');
  const fileArg = getArg('--file');
  const modelArg = getArg('--model') || DEFAULT_MODEL;
  const isAll = args.includes('--all');
  const isDryRun = args.includes('--dry-run');
  const isUnparsed = args.includes('--unparsed') || (!clientArg && !fileArg && !isAll);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[ResumeParser] Error: ANTHROPIC_API_KEY environment variable is missing.');
    process.exit(1);
  }

  const store = new SupabaseStore();
  const resumeService = new ResumeService({ store });

  // Load clients.json
  let clientsData = {};
  if (fs.existsSync(CLIENTS_JSON_PATH)) {
    try {
      clientsData = JSON.parse(fs.readFileSync(CLIENTS_JSON_PATH, 'utf8'));
    } catch {}
  }

  // Load existing resume_parsed table from Supabase to skip already parsed
  let existingParsedMap = new Map();
  if (store.isAvailable()) {
    existingParsedMap = await store.loadAllResumeParsed();
  }

  console.log(`[ResumeParser] Configuration:`);
  console.log(`  Model: ${modelArg}`);
  console.log(`  Target: ${clientArg ? `Client ${clientArg}` : (isAll ? 'All candidates' : 'Unparsed candidates')}`);
  console.log(`  Existing parsed in Supabase: ${existingParsedMap.size}`);
  console.log(`  Dry run: ${isDryRun}`);

  // Determine list of candidates to process
  let targets = [];
  if (fileArg) {
    const applywizzId = clientArg || 'LOCAL_FILE';
    targets.push({
      applywizzId,
      filePath: path.resolve(fileArg),
      client: clientsData[applywizzId] || {}
    });
  } else if (clientArg) {
    targets.push({
      applywizzId: clientArg,
      client: clientsData[clientArg] || {}
    });
  } else {
    for (const [id, client] of Object.entries(clientsData)) {
      if (isUnparsed && existingParsedMap.has(id)) {
        continue;
      }
      targets.push({
        applywizzId: id,
        client
      });
    }
  }

  console.log(`[ResumeParser] Identified ${targets.length} candidates to parse.\n`);

  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const { applywizzId, client } = target;
    console.log(`[${i + 1}/${targets.length}] Processing candidate ${applywizzId} (${client?.client?.full_name || 'Name unknown'})...`);

    try {
      let rawResumeText = '';

      // 1. If explicit local file given
      if (target.filePath && fs.existsSync(target.filePath)) {
        const buf = fs.readFileSync(target.filePath);
        rawResumeText = await extractTextFromPdf(buf);
      } else {
        // 2. Download or locate resume via ResumeService
        const resolvedPath = await resumeService.resolveCandidateResume(applywizzId, client);
        if (resolvedPath && fs.existsSync(resolvedPath)) {
          const buf = fs.readFileSync(resolvedPath);
          rawResumeText = await extractTextFromPdf(buf);
        }
      }

      // 3. Fallback to client.additional_information.resume_text if pdf-parse failed
      if (!rawResumeText || rawResumeText.length < 50) {
        rawResumeText = client?.additional_information?.resume_text || '';
      }

      if (!rawResumeText || rawResumeText.length < 50) {
        console.warn(`  ⚠ No resume text found or extractable for ${applywizzId}. Skipping.`);
        skippedCount++;
        continue;
      }

      console.log(`  ✓ Extracted ${rawResumeText.length} characters of resume text. Prompting ${modelArg}...`);
      const parsedJson = await parseResumeWithClaude({
        apiKey,
        model: modelArg,
        rawResumeText,
        clientHint: client
      });

      // Construct DB record
      const record = {
        applywizz_id: applywizzId,
        full_name: parsedJson.full_name || client?.client?.full_name || '',
        first_name: parsedJson.first_name || client?.client?.first_name || '',
        last_name: parsedJson.last_name || client?.client?.last_name || '',
        email: parsedJson.email || client?.client?.personal_email || '',
        phone: parsedJson.phone || client?.client?.callable_phone || '',
        city: parsedJson.city || client?.client?.address_city || '',
        state: parsedJson.state || client?.client?.address_state || '',
        country: parsedJson.country || client?.client?.address_country || 'United States',
        current_title: parsedJson.current_title || client?.additional_information?.role || '',
        years_of_experience: typeof parsedJson.years_of_experience === 'number' ? parsedJson.years_of_experience : (parseFloat(client?.additional_information?.experience) || null),
        highest_education_level: parsedJson.highest_education_level || client?.additional_information?.highest_education || '',
        linkedin_url: parsedJson.linkedin_url || client?.client?.linkedin_url || '',
        portfolio_url: parsedJson.portfolio_url || client?.client?.portfolio_url || '',
        professional_summary: parsedJson.professional_summary || '',
        domain_expertise: parsedJson.domain_expertise || [],
        technical_skills: parsedJson.technical_skills || {},
        skills: parsedJson.skills || [],
        work_experience: parsedJson.work_experience || [],
        education: parsedJson.education || [],
        projects: parsedJson.projects || [],
        certifications: parsedJson.certifications || [],
        raw_resume_text: rawResumeText
      };

      if (isDryRun) {
        console.log(`  [DRY RUN] Parsed structure for ${applywizzId}:`);
        console.log(JSON.stringify(record, null, 2).slice(0, 1000) + '...\n');
        successCount++;
        continue;
      }

      // Persist to Supabase resume_parsed table
      if (store.isAvailable()) {
        await store.upsertResumeParsed(record);
        console.log(`  ✓ Saved to Supabase resume_parsed table`);
      }

      // Also persist to local resume_parsed.json
      try {
        let localData = {};
        if (fs.existsSync(RESUME_PARSED_JSON_PATH)) {
          try { localData = JSON.parse(fs.readFileSync(RESUME_PARSED_JSON_PATH, 'utf8')); } catch {}
        }
        localData[applywizzId] = record;
        fs.writeFileSync(RESUME_PARSED_JSON_PATH, JSON.stringify(localData, null, 2), 'utf8');
      } catch (localErr) {
        console.warn(`  ⚠ Failed to update local fallback json: ${localErr.message}`);
      }

      console.log(`  ✓ Successfully parsed & stored ${applywizzId} (${record.work_experience.length} experiences, ${record.education.length} educations, ${record.skills.length} skills)\n`);
      successCount++;

      // Pacing delay between calls
      if (i < targets.length - 1 && PARSE_DELAY_MS > 0) {
        await new Promise(r => setTimeout(r, PARSE_DELAY_MS));
      }
    } catch (err) {
      console.error(`  ✗ Error parsing candidate ${applywizzId}:`, err.message, '\n');
      failCount++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Resume Parsing Run Complete:`);
  console.log(`  Total Targets: ${targets.length}`);
  console.log(`  Successful:    ${successCount}`);
  console.log(`  Failed:        ${failCount}`);
  console.log(`  Skipped:       ${skippedCount}`);
  console.log(`========================================\n`);

  await store.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal CLI error:', err);
    process.exit(1);
  });
}
