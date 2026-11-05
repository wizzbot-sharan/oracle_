/**
 * Claude LLM service for Stage 4 qualitative/essay screening questions.
 * Grounded in candidate profile data, resume context, and past question bank records.
 */

export class ClaudeService {
  constructor({ apiKey, model, fetchFn } = {}) {
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
    this.model = model ?? process.env.ANTHROPIC_MODEL ?? null;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  isAvailable() {
    return Boolean(this.apiKey && this.model);
  }

  /**
   * Builds prompt context and asks Claude to resolve a screening question.
   * Returns { answer, confidence, rationale } or null if unavailable / failed.
   */
  async resolveQuestion({ client, questionHistory = [], resumeText = '', field }) {
    if (!this.isAvailable()) {
      if (this.apiKey && !this.model) {
        console.warn('[ClaudeService] ANTHROPIC_API_KEY is present but ANTHROPIC_MODEL is not configured in .env. Skipping Stage 4 LLM resolution.');
      }
      return null;
    }

    const clientInfo = client?.client ?? {};
    const addInfo = client?.additional_information ?? {};

    const profileSummary = [
      `Name: ${clientInfo.full_name || 'Candidate'}`,
      `Email: ${clientInfo.personal_email || ''}`,
      `Education: ${addInfo.highest_education || ''} from ${addInfo.university_name || ''} (GPA: ${addInfo.cumulative_gpa || 'N/A'}, Graduated: ${addInfo.graduation_year || ''})`,
      `Role: ${addInfo.role || clientInfo.job_role_preferences || ''}`,
      `Experience Summary: ${addInfo.experience || ''}`,
      `Work Auth: ${addInfo.eligible_to_work_in_us ? 'Eligible to work in US' : 'Requires sponsorship'}, Visa: ${clientInfo.visa_type || 'N/A'}`
    ].filter(Boolean).join('\n');

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
1. Provide a direct, professional, truthful answer grounded strictly in the candidate's data.
2. If allowed options are provided, select the single best matching option.
3. For short text or textarea questions, write a concise, compelling answer.
4. Provide a confidence score between 0.0 and 1.0 (where 0.80+ indicates high confidence).
5. Respond strictly with a JSON object:
{
  "answer": "your answer here",
  "confidence": 0.85,
  "rationale": "one sentence explaining why this matches the candidate background"
}`;

    try {
      const response = await this.fetchFn('https://api.anthropic.com/v1/messages', {
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

      // Extract JSON from response
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.answer || typeof parsed.confidence !== 'number') {
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
