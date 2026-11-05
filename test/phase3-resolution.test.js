import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ResolutionEngine, tokenSortSimilarity, isPiiOrPersonalQuestion } from '../src/domain/resolution-engine.js';
import { ClaudeService } from '../src/services/claude-service.js';
import { Phase3AnswerResolution } from '../src/phases/phase3-answer-resolution.js';

test('tokenSortSimilarity computes accurate similarity regardless of word order', () => {
  const score1 = tokenSortSimilarity('How did you hear about us?', 'About us, how did you hear?');
  assert.equal(score1, 1.0, 'Identical tokens in different order should score 1.0');

  const score2 = tokenSortSimilarity('Are you over the age of 18?', 'Are you at least 18 years of age?');
  assert.ok(score2 >= 0.60, `Expected score >= 0.60, got ${score2}`);

  const score3 = tokenSortSimilarity('First Name', 'Upload Resume');
  assert.ok(score3 < 0.3, `Expected low score, got ${score3}`);
});

test('isPiiOrPersonalQuestion identifies personal/location fields to prevent cross-client leakage', () => {
  assert.equal(isPiiOrPersonalQuestion('What city do you live in?'), true);
  assert.equal(isPiiOrPersonalQuestion('Phone Number'), true);
  assert.equal(isPiiOrPersonalQuestion('What is your permanent address?'), true);
  assert.equal(isPiiOrPersonalQuestion('Do you require visa sponsorship?'), true);
  assert.equal(isPiiOrPersonalQuestion('How did you hear about this opportunity?'), false);
  assert.equal(isPiiOrPersonalQuestion('Earliest start date month'), false);
});

test('Stage 1 Taxonomy resolves personal, contact, work auth and legal fields from Tier 1 profile', async () => {
  const engine = new ResolutionEngine();

  const client = {
    client: {
      full_name: 'Jane Doe',
      personal_email: 'jane.doe@example.com',
      callable_phone: '+1 555-0199',
      sponsorship: 'No',
      visa_type: 'US Citizen'
    },
    additional_information: {
      is_over_18: true,
      eligible_to_work_in_us: true,
      require_future_sponsorship: false,
      gender: 'Female',
      race_ethnicity: 'Asian',
      veteran_status: 'I am not a protected veteran',
      disability_status: 'No, I do not have a disability',
      full_address: '456 Elm St, Austin, TX 78701',
      state_of_residence: 'Texas',
      zip_or_country: '78701',
      worked_for_company_before: false,
      willing_background_check: true
    }
  };

  // Test First Name
  const resFirstName = await engine.resolveField({
    field: { id: 'first_name', label: 'First Name', type: 'text', required: true },
    client
  });
  assert.equal(resFirstName.value, 'Jane');
  assert.equal(resFirstName.confidence, 1.0);
  assert.equal(resFirstName.stage, 'stage1_taxonomy');
  assert.equal(resFirstName.tier, 1);

  // Test Age Over 18 (coerced to radio option)
  const resAge = await engine.resolveField({
    field: { id: 'age_18', label: 'Are you over the age of 18?', type: 'radio', options: ['Yes', 'No'], required: true },
    client
  });
  assert.equal(resAge.value, 'Yes');
  assert.equal(resAge.confidence, 1.0);

  // Test Visa Sponsorship (coerced to radio option)
  const resSponsor = await engine.resolveField({
    field: { id: 'sponsor', label: 'Will you now or in the future require Vertiv to help you obtain an employment visa?', type: 'radio', options: ['Yes', 'No'], required: true },
    client
  });
  assert.equal(resSponsor.value, 'No');
  assert.equal(resSponsor.confidence, 1.0);

  // Test Gender (coerced to combobox option)
  const resGender = await engine.resolveField({
    field: { id: 'gender', label: 'Gender', type: 'combobox', options: ['Male', 'Female', 'Decline to self-identify'], required: true },
    client
  });
  assert.equal(resGender.value, 'Female');
  assert.equal(resGender.confidence, 1.0);
});

test('Stage 2 Token-Sort resolves from Tier 2 Question Bank and respects Tier Caps and Isolation', async () => {
  const engine = new ResolutionEngine();

  const client = { client: { full_name: 'John Smith' }, additional_information: {} };

  const clientHistory = [
    {
      question_label: 'Have you worked with Playwright test automation?',
      value: 'Yes, 3+ years',
      source: 'manual',
      confidence: 1.0
    },
    {
      question_label: 'What is your preferred development language?',
      value: 'TypeScript and Node.js',
      source: 'ai',
      confidence: 0.90
    }
  ];

  // Client-specific match: manual entry capped at 0.98
  const resPlaywright = await engine.resolveField({
    field: { id: 'playwright_exp', label: 'Have you worked with Playwright test automation?', type: 'text', required: true },
    client,
    clientHistory
  });
  assert.equal(resPlaywright.value, 'Yes, 3+ years');
  assert.equal(resPlaywright.tier, 2);
  assert.equal(resPlaywright.confidence, 0.98, 'Manual Tier 2 record should cap at 0.98');
  assert.equal(resPlaywright.stage, 'stage2_fuzzy');

  // Client-specific match: AI entry capped at 0.90
  const resLang = await engine.resolveField({
    field: { id: 'pref_lang', label: 'What is your preferred development language?', type: 'text', required: true },
    client,
    clientHistory
  });
  assert.equal(resLang.value, 'TypeScript and Node.js');
  assert.equal(resLang.confidence, 0.90, 'AI Tier 2 record should cap at 0.90');

  // Cross-client matching for generic non-PII questions
  const globalHistory = [
    {
      question_label: 'How did you hear about this position?',
      value: 'LinkedIn',
      source: 'manual',
      confidence: 1.0
    },
    {
      question_label: 'What city do you live in?',
      value: 'Chicago',
      source: 'manual',
      confidence: 1.0
    }
  ];

  const resReferral = await engine.resolveField({
    field: { id: 'hear_about', label: 'How did you hear about this position?', type: 'text', required: false },
    client,
    clientHistory: [],
    globalHistory
  });
  assert.equal(resReferral.value, 'LinkedIn');
  assert.ok(resReferral.confidence <= 0.85, 'Cross-client match should cap at <= 0.85');

  // PII question should NEVER be answered from cross-client globalHistory
  const resPii = await engine.resolveField({
    field: { id: 'city_loc', label: 'What city do you live in?', type: 'text', required: true },
    client,
    clientHistory: [],
    globalHistory
  });
  assert.notEqual(resPii.value, 'Chicago', 'PII question must not use another client city');
});

test('Stage 4 ClaudeService fallback resolves qualitative screening questions', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{
        text: JSON.stringify({
          answer: 'I led the migration of distributed services using LangChain and Python, reducing latency by 30%.',
          confidence: 0.88,
          rationale: 'Matches candidate AI/ML background.'
        })
      }]
    })
  });

  const claudeService = new ClaudeService({
    apiKey: 'mock-key',
    model: 'mock-model',
    fetchFn: mockFetch
  });

  const engine = new ResolutionEngine({ claudeService });

  const client = {
    client: { full_name: 'Alex Rivera' },
    additional_information: { experience: '5 years ML engineer with Python and LangChain' }
  };

  const res = await engine.resolveField({
    field: {
      id: 'gen_ai_process',
      label: 'Provide an example of a generative AI-enhanced process you built and what the results were?',
      type: 'textarea',
      required: true
    },
    client
  });

  assert.ok(res.value.includes('LangChain'), 'Expected answer to contain LangChain');
  assert.equal(res.stage, 'stage4_llm');
  assert.equal(res.confidence, 0.88);
});

test('Phase3AnswerResolution enforces required-field >= 0.80 status rule and syncs back to CSV', async () => {
  const tmpDir = path.join(os.tmpdir(), `phase3-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const qbCsvPath = path.join(tmpDir, 'question_bank.csv');
  fs.writeFileSync(qbCsvPath, 'id,applywizz_id,question_label,field_type,value,source,confidence,created_at,updated_at\n', 'utf8');

  const clientsJsonPath = path.join(tmpDir, 'clients.json');
  fs.writeFileSync(clientsJsonPath, JSON.stringify({
    'AWL-TEST-1': {
      client: {
        full_name: 'Alice Cooper',
        personal_email: 'alice@example.com',
        callable_phone: '+1 555-1234'
      },
      additional_information: {
        is_over_18: true,
        eligible_to_work_in_us: true,
        require_future_sponsorship: false,
        state_of_residence: 'California'
      }
    }
  }), 'utf8');

  const inMemoryStore = {
    data: {
      jobs: {
        assignments: [
          {
            assignmentId: 'asg-test-1',
            userId: 'AWL-TEST-1',
            applywizzId: 'AWL-TEST-1',
            jobKey: 'job_test_1',
            jobId: '1001',
            canonicalUrl: 'https://test.oraclecloud.com/job/1001'
          }
        ]
      },
      'form-templates': {
        job_test_1: {
          templateId: 'tpl_test_1',
          fields: [
            { id: 'first_name', label: 'First Name', type: 'text', required: true },
            { id: 'last_name', label: 'Last Name', type: 'text', required: true },
            { id: 'phone', label: 'Phone Number', type: 'tel', required: true },
            { id: 'optional_cover_letter', label: 'Upload Cover Letter', type: 'file', required: false }
          ]
        }
      },
      applications: []
    },
    async read(key) {
      return this.data[key] ?? [];
    },
    readSync(key) {
      return this.data[key] ?? [];
    },
    async write(key, val) {
      this.data[key] = val;
    },
    async update(key, fallback, fn) {
      this.data[key] = fn(this.data[key] ?? fallback);
    }
  };

  const phase3 = new Phase3AnswerResolution({
    store: inMemoryStore,
    config: {
      clientsPath: clientsJsonPath,
      questionBankCsvPath: qbCsvPath
    }
  });

  const applications = await phase3.createOrResolveApplications();
  assert.equal(applications.length, 1);
  const app = applications[0];

  // All required fields resolved with confidence >= 0.80, optional cover letter is empty -> answers_resolved!
  assert.equal(app.status, 'answers_resolved', 'Should be answers_resolved because all required fields are resolved');
  assert.equal(app.values.first_name.value, 'Alice');
  assert.equal(app.values.last_name.value, 'Cooper');

  // Test dashboard saveAnswers: operator update directly appends to question_bank.csv
  await phase3.saveAnswers(app.applicationId, {
    optional_cover_letter: 'data/custom_cover_letter.pdf'
  });

  const updatedApps = await inMemoryStore.read('applications');
  assert.equal(updatedApps[0].values.optional_cover_letter.value, 'data/custom_cover_letter.pdf');
  assert.equal(updatedApps[0].values.optional_cover_letter.confidence, 1.0);

  const csvContent = fs.readFileSync(qbCsvPath, 'utf8');
  assert.ok(csvContent.includes('AWL-TEST-1'), 'CSV should contain client ID');
  assert.ok(csvContent.includes('custom_cover_letter.pdf'), 'CSV should contain new answer');
  assert.ok(csvContent.includes('manual'), 'CSV row should have source manual');

  // Test multi-job resolution with comma-separated jobKeys
  inMemoryStore.data.applications = [];
  inMemoryStore.data.jobs = {
    assignments: [
      { applywizzId: 'AWL-TEST-1', jobKey: 'job_A', canonicalUrl: 'https://test/job/A' },
      { applywizzId: 'AWL-TEST-1', jobKey: 'job_B', canonicalUrl: 'https://test/job/B' },
      { applywizzId: 'AWL-TEST-1', jobKey: 'job_C', canonicalUrl: 'https://test/job/C' }
    ]
  };
  const tpl = inMemoryStore.data['form-templates'].job_test_1;
  inMemoryStore.data['form-templates'] = {
    job_A: tpl,
    job_B: tpl,
    job_C: tpl
  };

  const multiResolved = await phase3.createOrResolveApplications({ jobKey: 'job_A, job_B' });
  assert.equal(multiResolved.length, 2, 'Should resolve exactly the 2 specified jobs');
  const resolvedKeys = multiResolved.map(a => a.jobKey);
  assert.ok(resolvedKeys.includes('job_A') && resolvedKeys.includes('job_B'));
  assert.ok(!resolvedKeys.includes('job_C'), 'Unselected job_C should not be resolved');
});
