import { matchBestOption } from '../domain/option-matcher.js';

/**
 * Claude LLM service for Stage 4 qualitative/essay screening questions.
 * Grounded in candidate profile data, resume context, and past question bank records.
 * Supports single-field resolution and unified candidate-level multi-question batching.
 */

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

  /**
   * Resolves an entire batch of unique questions for a candidate in a single LLM prompt.
   * Grounded in candidate facts and resume.
   *
   * @param {Object} params
   * @param {Object} params.client Candidate profile from clients.json
   * @param {Object} [params.canonical] CanonicalProfile instance
   * @param {string} [params.resumeText] Raw text of candidate resume
   * @param {Array<Object>} params.questions List of deduplicated questions:
   *   { questionId, label, type, options, company, jobTitle, sectionLabel }
   * @returns {Promise<Object>} Map of { [questionId]: { answer, confidence, rationale } }
   */
  async resolveCandidateBatch({ client, canonical, resumeText = '', questions = [] }) {
    if (!this.isAvailable() || questions.length === 0) {
      return {};
    }

    const profileSummary = this.#buildCandidateProfileSummary(client);
    const expContext = resumeText || client?.additional_information?.experience || 'See candidate profile above.';

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

    const prompt = `You are an AI assistant acting on behalf of a job candidate. Your task is to resolve job application screening questions accurately, truthfully, and professionally based on the candidate's real profile and resume.

Candidate Profile:
${profileSummary}

Resume / Experience Context:
${expContext}

Questions to Answer:
${formattedQuestions}

Instructions:
1. Provide a direct, professional, truthful answer grounded strictly in the candidate's data. Never guess, assume, or hallucinate qualifications not present in the candidate facts or resume.
2. If Allowed Options are provided, your answer MUST be one of the exact strings from "Allowed Options". Do NOT alter, summarize, or rephrase the option text.
3. If the candidate's profile and resume do NOT contain sufficient information to answer with confidence (e.g. unknown personal preference or missing qualification), respond with "answer": null and "confidence": 0.0.
4. For short text or textarea questions, write a concise, professional answer matching the candidate's voice.
5. Provide a confidence score between 0.0 and 1.0 (where 0.80+ indicates high confidence).
6. Return strictly a JSON object with this exact shape:
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
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.error(`[ClaudeService] Batch API error: ${response.status} ${response.statusText} - ${errBody}`);
        return {};
      }

      const data = await response.json();
      const rawText = data.content?.[0]?.text?.trim() || '';

      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[ClaudeService] Failed to locate JSON in LLM batch response');
        return {};
      }

      const parsed = JSON.parse(jsonMatch[0]);
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
      const rawText = data.content?.[0]?.text?.trim() || '';

      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
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
