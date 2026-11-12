import { matchBestOption } from '../domain/option-matcher.js';

/**
 * Claude LLM service for Stage 4 qualitative/essay screening questions.
 * Grounded in candidate profile data, resume context, and past question bank records.
 * Supports single-field resolution and unified candidate-level multi-question batching.
 */

/**
 * Robustly parses batch answer JSON from LLM text responses.
 * Handles markdown fences, preambles, and salvages completed questions from truncated responses.
 *
 * @param {string} rawText
 * @returns {Object|null}
 */
export function parseBatchJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  let cleaned = rawText.trim();
  // Strip markdown code fences if present (```json ... ``` or ``` ...)
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // 1. Direct JSON parse
  try {
    return JSON.parse(cleaned);
  } catch {}

  // 2. Extract outermost { ... }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  // 3. Fallback salvage for truncated responses (e.g. cut off mid-stream by token limit)
  if (firstBrace !== -1) {
    const qMatches = [...cleaned.matchAll(/"([^"]+)":\s*(\{[^{}]*"answer"[^{}]*\})/gs)];
    if (qMatches.length > 0) {
      const answers = {};
      for (const [, qId, jsonStr] of qMatches) {
        if (qId === 'answers') continue;
        try {
          const parsedObj = JSON.parse(jsonStr);
          if (parsedObj && typeof parsedObj === 'object') {
            answers[qId] = parsedObj;
          }
        } catch {}
      }
      if (Object.keys(answers).length > 0) {
        return { answers };
      }
    }
  }

  return null;
}

export class ClaudeService {
  constructor({ apiKey, model, fetchFn } = {}) {
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
    this.model = model ?? process.env.ANTHROPIC_MODEL ?? 'claude-3-5-sonnet-20241022';
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  isAvailable() {
    return Boolean(this.apiKey && this.model);
  }

  /**
   * Helper to execute API calls with exponential backoff on HTTP 429/500/529.
   */
  async #fetchWithRetry(url, options, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await this.fetchFn(url, options);
      if (response.ok) return response;

      if ((response.status === 429 || response.status === 529 || response.status >= 500) && attempt < maxRetries) {
        let retryAfterSec = 0;
        try {
          const rawHeader = response.headers?.get?.('retry-after');
          if (rawHeader) retryAfterSec = Number(rawHeader) || 0;
        } catch {}
        const backoffMs = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.pow(2, attempt) * 1500;
        console.warn(`[ClaudeService] Received HTTP ${response.status}. Retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      return response;
    }
  }

  #buildCandidateProfileSummary(client) {
    const clientInfo = client?.client ?? {};
    const addInfo = client?.additional_information ?? {};

    return [
      `Name: ${clientInfo.full_name || 'Candidate'}`,
      `Email: ${clientInfo.personal_email || ''}`,
      `Education: ${addInfo.highest_education || ''} from ${addInfo.university_name || ''} (GPA: ${addInfo.cumulative_gpa || 'N/A'}, Graduated: ${addInfo.graduation_year || ''})`,
      `Role: ${addInfo.role || clientInfo.job_role_preferences || ''}`,
      `Experience Summary: ${addInfo.experience || ''}`,
      `Work Auth: ${addInfo.eligible_to_work_in_us ? 'Eligible to work in US' : 'Requires sponsorship'}, Visa: ${clientInfo.visa_type || 'N/A'}`
    ].filter(Boolean).join('\n');
  }

  #buildStructuredResumeSummary(parsedResume) {
    if (!parsedResume || typeof parsedResume !== 'object') return '';

    const lines = [];
    if (parsedResume.current_title) lines.push(`Current Title: ${parsedResume.current_title}`);
    if (parsedResume.years_of_experience) lines.push(`Total Years of Experience: ${parsedResume.years_of_experience}`);
    if (parsedResume.highest_education_level) lines.push(`Highest Education Level: ${parsedResume.highest_education_level}`);
    if (parsedResume.professional_summary) lines.push(`Professional Summary: ${parsedResume.professional_summary}`);

    // Technical skills categories
    if (parsedResume.technical_skills && typeof parsedResume.technical_skills === 'object') {
      const catEntries = Object.entries(parsedResume.technical_skills)
        .filter(([, skills]) => Array.isArray(skills) && skills.length > 0)
        .map(([cat, skills]) => `  - ${cat.replace(/_/g, ' ')}: ${skills.join(', ')}`);
      if (catEntries.length > 0) {
        lines.push('Technical Skills:');
        lines.push(...catEntries);
      }
    } else if (Array.isArray(parsedResume.skills) && parsedResume.skills.length > 0) {
      lines.push(`Skills: ${parsedResume.skills.join(', ')}`);
    }

    // Domain expertise
    if (Array.isArray(parsedResume.domain_expertise) && parsedResume.domain_expertise.length > 0) {
      lines.push(`Domain Expertise: ${parsedResume.domain_expertise.join(', ')}`);
    }

    // Work experience timeline
    if (Array.isArray(parsedResume.work_experience) && parsedResume.work_experience.length > 0) {
      lines.push('Work Experience Timeline:');
      for (const exp of parsedResume.work_experience) {
        const emp = exp.employer || exp.company || 'Unknown Employer';
        const title = exp.title || exp.job_title || 'Role';
        const dates = [exp.start_date, exp.end_date || (exp.current ? 'Present' : '')].filter(Boolean).join(' - ');
        const loc = exp.location ? ` (${exp.location})` : '';
        lines.push(`  * ${title} at ${emp}${loc} [${dates}]`);
        if (Array.isArray(exp.highlights) && exp.highlights.length > 0) {
          for (const h of exp.highlights.slice(0, 3)) {
            lines.push(`    - ${h}`);
          }
        } else if (exp.description) {
          lines.push(`    - ${exp.description.slice(0, 200)}`);
        }
      }
    }

    // Education
    if (Array.isArray(parsedResume.education) && parsedResume.education.length > 0) {
      lines.push('Education:');
      for (const edu of parsedResume.education) {
        const inst = edu.institution || edu.school || 'University';
        const deg = edu.degree || 'Degree';
        const yr = edu.graduation_year || edu.end_date || '';
        const gpa = edu.gpa ? ` (GPA: ${edu.gpa})` : '';
        lines.push(`  * ${deg} from ${inst} ${yr ? `[${yr}]` : ''}${gpa}`);
      }
    }

    // Projects
    if (Array.isArray(parsedResume.projects) && parsedResume.projects.length > 0) {
      lines.push('Key Projects:');
      for (const proj of parsedResume.projects.slice(0, 3)) {
        const techs = Array.isArray(proj.technologies) && proj.technologies.length > 0 ? ` [Tech: ${proj.technologies.join(', ')}]` : '';
        lines.push(`  * ${proj.name}${techs}`);
        if (proj.description) lines.push(`    - ${proj.description.slice(0, 150)}`);
      }
    }

    // Certifications
    if (Array.isArray(parsedResume.certifications) && parsedResume.certifications.length > 0) {
      const certList = parsedResume.certifications
        .map(c => typeof c === 'string' ? c : `${c.name || 'Cert'}${c.issuer ? ` (${c.issuer})` : ''}`)
        .join('; ');
      lines.push(`Certifications: ${certList}`);
    }

    return lines.join('\n');
  }

  #buildQuestionBankHistorySummary(clientHistory) {
    if (!Array.isArray(clientHistory) || clientHistory.length === 0) return '';
    const seen = new Set();
    const rows = [];
    for (const h of clientHistory) {
      const key = (h.question_label || '').trim().toLowerCase();
      if (!key || seen.has(key) || h.value === null || h.value === undefined || h.value === '') continue;
      seen.add(key);
      rows.push(`  * "${h.question_label}": "${h.value}"`);
      if (rows.length >= 25) break;
    }
    return rows.length > 0 ? rows.join('\n') : '';
  }

  /**
   * Resolves an entire batch of unique questions for a candidate in a single LLM prompt.
   * Grounded in candidate facts, structured resume, and historical question bank answers.
   *
   * @param {Object} params
   * @param {Object} params.client Candidate profile from clients.json
   * @param {Object} [params.canonical] CanonicalProfile instance
   * @param {string} [params.resumeText] Raw text of candidate resume
   * @param {Object} [params.parsedResume] Structured resume record from resume_parsed table
   * @param {Array<Object>} [params.clientHistory] Past approved Q&A from question_bank for this applywizz_id
   * @param {Array<Object>} params.questions List of deduplicated questions:
   *   { questionId, label, type, options, company, jobTitle, sectionLabel }
   * @returns {Promise<Object>} Map of { [questionId]: { answer, confidence, rationale } }
   */
  async resolveCandidateBatch({ client, canonical, resumeText = '', parsedResume = null, clientHistory = [], questions = [] }) {
    if (!this.isAvailable() || questions.length === 0) {
      return {};
    }

    const pillar1 = this.#buildCandidateProfileSummary(client);
    const pillar2 = this.#buildStructuredResumeSummary(parsedResume) || (resumeText ? `Raw Resume Context:\n${resumeText.slice(0, 3000)}` : '');
    const pillar3 = this.#buildQuestionBankHistorySummary(clientHistory);

    const formattedQuestions = questions.map((q, idx) => {
      const optionsStr = Array.isArray(q.options) && q.options.length > 0
        ? `\n  Allowed Options (MUST be one of these exact strings):\n${q.options.map(o => `    * "${o}"`).join('\n')}`
        : '';
      const contextStr = [
        q.company ? `Company: "${q.company}"` : null,
        q.jobTitle ? `Target Role: "${q.jobTitle}"` : null,
        q.sectionLabel ? `Section: "${q.sectionLabel}"` : null
      ].filter(Boolean).join(' | ');

      return `[Question ${idx + 1}] ID: "${q.questionId}"\n  Context: ${contextStr || 'General'}\n  Label: "${q.label}"\n  Type: "${q.type || 'text'}"${optionsStr}`;
    }).join('\n\n');

    const prompt = `You are an AI assistant acting on behalf of a job candidate. Your task is to resolve job application screening questions accurately, truthfully, and professionally based on the candidate's real profile, structured resume, and past approved answers.

=== CANDIDATE PROFILE FACTS (Pillar 1) ===
${pillar1}

${pillar2 ? `=== STRUCTURED RESUME INTELLIGENCE (Pillar 2) ===\n${pillar2}\n` : ''}
${pillar3 ? `=== CANDIDATE PAST APPROVED ANSWERS MEMORY (Pillar 3) ===\n${pillar3}\n` : ''}

=== QUESTIONS TO ANSWER ===
${formattedQuestions}

Instructions:
1. Provide a direct, professional, truthful answer grounded strictly in the candidate's data and past approved answers. Never guess, assume, or hallucinate qualifications not present in the candidate facts or resume.
2. If Allowed Options are provided, your answer MUST be one of the exact strings from "Allowed Options". Do NOT alter, summarize, or rephrase the option text.
3. If Past Approved Answers Memory contains a past answer to a similar question for this candidate, maintain consistency unless explicitly contradicted by the target company/job context.
4. If the candidate's profile, resume, and history do NOT contain sufficient information to answer with confidence (e.g. unknown personal preference or missing qualification), respond with "answer": null and "confidence": 0.0.
5. For short text or textarea questions, write a concise, professional answer matching the candidate's voice.
6. Provide a confidence score between 0.0 and 1.0 (where 0.80+ indicates high confidence).
7. Return strictly a JSON object with this exact shape:
{
  "answers": {
    "question_id_here": {
      "answer": "exact option or text answer (or null if uncertain)",
      "confidence": 0.85,
      "rationale": "one sentence explaining why this matches the candidate background"
    }
  }
}`;

    try {
      const response = await this.#fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.error(`[ClaudeService] Batch API error: ${response.status} ${response.statusText} - ${errBody}`);
        return {};
      }

      const data = await response.json();
      const rawText = Array.isArray(data.content)
        ? data.content
            .filter(b => (b.type === 'text' || !b.type) && typeof b.text === 'string')
            .map(b => b.text)
            .join('\n')
            .trim()
        : (typeof data.content === 'string' ? data.content.trim() : '');

      const parsed = parseBatchJson(rawText);
      if (!parsed) {
        console.warn(`[ClaudeService] Failed to parse JSON from batch response (stop_reason: ${data.stop_reason || 'unknown'}). Raw preview:`, rawText.slice(0, 200));
        return {};
      }

      const rawAnswers = parsed.answers || parsed;
      const validatedAnswers = {};

      const questionMap = new Map(questions.map(q => [q.questionId, q]));

      for (const [qId, ansObj] of Object.entries(rawAnswers)) {
        if (!ansObj || typeof ansObj !== 'object') continue;
        const qDef = questionMap.get(qId);
        if (!qDef) continue;

        let val = ansObj.answer;
        const confidence = typeof ansObj.confidence === 'number' ? ansObj.confidence : 0.0;
        const rationale = ansObj.rationale || 'Resolved by Claude Batch LLM';

        if (val === null || val === undefined || confidence < 0.80) {
          validatedAnswers[qId] = { answer: null, confidence: 0.0, rationale };
          continue;
        }

        // If the question has dropdown/radio options, strictly enforce option match
        if (Array.isArray(qDef.options) && qDef.options.length > 0) {
          const matched = matchBestOption([String(val)], qDef.options, 70);
          if (!matched) {
            console.warn(`[ClaudeService] LLM answer "${val}" did not match any allowed options for "${qDef.label}". Nullifying.`);
            val = null;
          } else {
            val = matched;
          }
        }

        validatedAnswers[qId] = {
          answer: val,
          confidence: val !== null ? Math.min(confidence, 0.90) : 0.0,
          rationale
        };
      }

      return validatedAnswers;
    } catch (err) {
      console.error('[ClaudeService] Failed to execute batch resolution:', err.message);
      return {};
    }
  }

  /**
   * Builds prompt context and asks Claude to resolve a single screening question (legacy fallback).
   * Returns { answer, confidence, rationale } or null if unavailable / failed.
   */
  async resolveQuestion({ client, questionHistory = [], resumeText = '', field }) {
    if (!this.isAvailable()) {
      return null;
    }

    const profileSummary = this.#buildCandidateProfileSummary(client);
    const addInfo = client?.additional_information ?? {};

    const historySummary = questionHistory.slice(0, 10).map(q =>
      `- Q: "${q.question_label}" -> A: "${q.value}"`
    ).join('\n');

    const optionsPrompt = field.options?.length
      ? `\nAllowed Options (you MUST select or match the best option from this list if applicable):\n${field.options.map(o => `* "${o}"`).join('\n')}`
      : '';

    const prompt = `You are an AI assistant acting on behalf of a job candidate. Your task is to answer a job application question accurately, truthfully, and professionally based on the candidate's real profile, past question-bank answers, and resume.

Candidate Profile:
${profileSummary}

Past Approved Question Bank Answers:
${historySummary || 'None available.'}

Resume / Experience Context:
${resumeText || addInfo.experience || 'See candidate profile above.'}

Question to Answer:
Label: "${field.label}"
Field Type: "${field.type || field.role || 'text'}"
Section: "${field.sectionLabel || 'General'}"${optionsPrompt}

Instructions:
1. Provide a direct, professional, truthful answer grounded strictly in the candidate's data. Never guess, assume, or hallucinate qualifications not present in the candidate facts or resume.
2. If allowed options are provided, your answer MUST be one of the exact strings from "Allowed Options". Do NOT alter or rephrase the option text.
3. If the candidate's profile and resume do NOT contain sufficient information to answer with confidence, respond with "answer": null and "confidence": 0.0 so an operator can review.
4. For short text or textarea questions, write a concise, professional answer.
5. Provide a confidence score between 0.0 and 1.0 (where 0.85+ indicates high confidence).
6. Respond strictly with a JSON object:
{
  "answer": "exact option or text answer (or null if uncertain)",
  "confidence": 0.85,
  "rationale": "one sentence explaining why this matches the candidate background"
}`;

    try {
      const response = await this.#fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.error(`[ClaudeService] API error: ${response.status} ${response.statusText} - ${errBody}`);
        return null;
      }

      const data = await response.json();
      const rawText = Array.isArray(data.content)
        ? data.content
            .filter(b => (b.type === 'text' || !b.type) && typeof b.text === 'string')
            .map(b => b.text)
            .join('\n')
            .trim()
        : (typeof data.content === 'string' ? data.content.trim() : '');

      let cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.answer === undefined || typeof parsed.confidence !== 'number') {
        return null;
      }

      return {
        answer: parsed.answer,
        confidence: Math.min(Math.max(parsed.confidence, 0), 0.90),
        rationale: parsed.rationale || 'Resolved by Claude LLM'
      };
    } catch (err) {
      console.error(`[ClaudeService] Failed to resolve question "${field.label}":`, err.message);
      return null;
    }
  }
}
