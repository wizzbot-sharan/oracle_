import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParserPrompt, parseClaudeJson } from '../scripts/parse-resumes.js';
import { SupabaseStore } from '../src/storage/supabase-store.js';
import { ClaudeService } from '../src/services/claude-service.js';
import { ResolutionEngine } from '../src/domain/resolution-engine.js';
import { CanonicalProfile } from '../src/domain/canonical-profile.js';

test('buildParserPrompt includes all 9 standard skill categories and structured ATS schema', () => {
  const sampleText = `
    BALA SURENDRA REDDY KARAKALA
    Jersey City, NJ | +1 (551) 260-7685 | balasurendrareddy.karakala@applywizard.ai
    PROFESSIONAL SUMMARY
    Java Full Stack Developer with 4+ years of experience building secure web applications.
    TECHNICAL SKILLS
    Programming Languages: Java 11, Java 17, TypeScript
    Backend Development: Spring Boot 3.x, Hibernate
    Frontend Development: React.js, Angular
    Databases: MySQL, PostgreSQL
    Cloud & Deployment: Microsoft Azure, Docker, Kubernetes
    Build & CI/CD Tools: Maven, Jenkins
    Testing & API Tools: JUnit, Postman
    AI Integration: Spring AI, Azure OpenAI Service
    Monitoring & Collaboration: Azure Monitor, Jira
  `;

  const prompt = buildParserPrompt(sampleText, { client: { full_name: 'Bala Karakala' } });
  assert.ok(prompt.includes('programming_languages'));
  assert.ok(prompt.includes('backend_development'));
  assert.ok(prompt.includes('frontend_development'));
  assert.ok(prompt.includes('databases'));
  assert.ok(prompt.includes('cloud_and_deployment'));
  assert.ok(prompt.includes('build_and_ci_cd_tools'));
  assert.ok(prompt.includes('testing_and_api_tools'));
  assert.ok(prompt.includes('ai_integration'));
  assert.ok(prompt.includes('monitoring_and_collaboration'));
  assert.ok(prompt.includes('work_experience'));
  assert.ok(prompt.includes('education'));
  assert.ok(prompt.includes('projects'));
  assert.ok(prompt.includes('certifications'));
});

test('parseClaudeJson cleanly extracts JSON with or without markdown fences', () => {
  const fenced = '```json\n{"full_name": "Test Candidate", "skills": ["Java", "Docker"]}\n```';
  const parsed = parseClaudeJson(fenced);
  assert.equal(parsed.full_name, 'Test Candidate');
  assert.deepEqual(parsed.skills, ['Java', 'Docker']);

  const withPreamble = 'Here is the extracted resume JSON:\n{"current_title": "Software Engineer"}\nHope this helps!';
  const parsed2 = parseClaudeJson(withPreamble);
  assert.equal(parsed2.current_title, 'Software Engineer');
});

test('SupabaseStore normalizes resume_parsed rows with proper JSONB deserialization', () => {
  const store = new SupabaseStore();
  const rawRow = {
    applywizz_id: 'AWL-101',
    full_name: 'Jane Doe',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
    years_of_experience: '6.5',
    current_title: 'Lead Architect',
    technical_skills: JSON.stringify({ programming_languages: ['Python', 'Go'] }),
    skills: JSON.stringify(['Python', 'Go', 'AWS']),
    work_experience: JSON.stringify([{ employer: 'Acme Corp', title: 'Architect' }]),
    education: JSON.stringify([{ institution: 'Stanford', degree: 'MS' }]),
    projects: JSON.stringify([{ name: 'Cloud Migration' }]),
    certifications: JSON.stringify([{ name: 'AWS SA Pro' }])
  };

  const normalized = store._normalizeResumeParsedRow(rawRow);
  assert.equal(normalized.applywizz_id, 'AWL-101');
  assert.equal(normalized.full_name, 'Jane Doe');
  assert.equal(normalized.years_of_experience, 6.5);
  assert.deepEqual(normalized.technical_skills.programming_languages, ['Python', 'Go']);
  assert.deepEqual(normalized.skills, ['Python', 'Go', 'AWS']);
  assert.equal(normalized.work_experience[0].employer, 'Acme Corp');
  assert.equal(normalized.education[0].institution, 'Stanford');
});

test('ClaudeService incorporates 3-Pillar Triad into batch prompt', async () => {
  let capturedPrompt = '';
  const mockFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    capturedPrompt = body.messages[0].content;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            answers: {
              q1: { answer: '5 years', confidence: 0.90, rationale: 'From resume timeline' }
            }
          })
        }]
      })
    };
  };

  const service = new ClaudeService({
    apiKey: 'test-key',
    model: 'claude-haiku-5-5',
    fetchFn: mockFetch
  });

  const client = {
    client: { full_name: 'Alex Smith', personal_email: 'alex@example.com', visa_type: 'H1B' },
    additional_information: { eligible_to_work_in_us: true, highest_education: "Master's Degree" }
  };

  const parsedResume = {
    current_title: 'Senior Java Developer',
    years_of_experience: 5.5,
    professional_summary: '5+ years building distributed Java applications',
    technical_skills: {
      programming_languages: ['Java', 'SQL'],
      backend_development: ['Spring Boot']
    },
    work_experience: [
      { employer: 'Capital One', title: 'Senior Developer', start_date: '2021', end_date: 'Present' }
    ],
    education: [
      { institution: 'NYU', degree: 'MS in CS', graduation_year: '2020' }
    ]
  };

  const clientHistory = [
    { question_label: 'Do you require sponsorship?', value: 'Yes' }
  ];

  const questions = [
    { questionId: 'q1', label: 'How many years of experience do you have with Java?', type: 'text' }
  ];

  const answers = await service.resolveCandidateBatch({
    client,
    parsedResume,
    clientHistory,
    questions
  });

  assert.equal(answers.q1?.answer, '5 years');
  assert.ok(capturedPrompt.includes('=== CANDIDATE PROFILE FACTS (Pillar 1) ==='));
  assert.ok(capturedPrompt.includes('=== STRUCTURED RESUME INTELLIGENCE (Pillar 2) ==='));
  assert.ok(capturedPrompt.includes('=== CANDIDATE PAST APPROVED ANSWERS MEMORY (Pillar 3) ==='));
  assert.ok(capturedPrompt.includes('Senior Java Developer'));
  assert.ok(capturedPrompt.includes('Capital One'));
  assert.ok(capturedPrompt.includes('Do you require sponsorship?'));
});

test('ResolutionEngine resolves phone country combobox to country name and phone digits cleanly', async () => {
  const engine = new ResolutionEngine();
  const canonical = CanonicalProfile.from({
    client: {
      client: {
        callable_phone: '+1 (551) 260-7685',
        address_country: 'United States'
      }
    }
  });

  // Country combobox field
  const countryField = {
    id: 'phone_country_code',
    label: 'Country/Region Code',
    type: 'combobox',
    isPhonePrefix: true
  };

  const resolvedCountry = await engine.resolveField({
    field: countryField,
    client: canonical
  });
  assert.equal(resolvedCountry.value, 'United States');
  assert.equal(resolvedCountry.confidence, 1.0);

  // Phone number input field
  const phoneField = {
    id: 'phone_number',
    label: 'Phone Number',
    type: 'tel',
    isPhoneNumber: true
  };

  const resolvedPhone = await engine.resolveField({
    field: phoneField,
    client: canonical
  });
  assert.equal(resolvedPhone.value, '5512607685');
  assert.equal(resolvedPhone.confidence, 1.0);
});
