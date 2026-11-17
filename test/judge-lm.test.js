import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeService, JUDGE_RESOLUTION_SYSTEM_PROMPT } from '../src/services/claude-service.js';
import { ResolutionEngine } from '../src/domain/resolution-engine.js';
import { Phase3AnswerResolution } from '../src/phases/phase3-answer-resolution.js';

test('ClaudeService - Dynamic Model Sourcing (Zero Hardcoded Strings)', (t) => {
  // Test 1: No environment variables or models provided -> null
  const emptyService = new ClaudeService({ apiKey: null, draftModel: null, judgeModel: null });
  assert.equal(emptyService.draftModel, null);
  assert.equal(emptyService.judgeModel, null);
  assert.equal(emptyService.isAvailable(), false);
  assert.equal(emptyService.isJudgeAvailable(), false);

  // Test 2: Custom draft and judge models passed dynamically
  const configuredService = new ClaudeService({
    apiKey: 'test-api-key',
    draftModel: 'custom-haiku-v1',
    judgeModel: 'custom-sonnet-v2'
  });
  assert.equal(configuredService.draftModel, 'custom-haiku-v1');
  assert.equal(configuredService.model, 'custom-haiku-v1');
  assert.equal(configuredService.judgeModel, 'custom-sonnet-v2');
  assert.equal(configuredService.isAvailable(), true);
  assert.equal(configuredService.isJudgeAvailable(), true);

  // Test 3: Backward compatibility with legacy 'model' constructor param
  const legacyService = new ClaudeService({
    apiKey: 'test-api-key',
    model: 'legacy-model-v1'
  });
  assert.equal(legacyService.draftModel, 'legacy-model-v1');
  assert.equal(legacyService.model, 'legacy-model-v1');
  assert.equal(legacyService.judgeModel, null);
  assert.equal(legacyService.isAvailable(), true);
  assert.equal(legacyService.isJudgeAvailable(), false);
});

test('ClaudeService.judgeCandidateBatch - Full Two-Pass Audit & Arbiter Evaluation', async (t) => {
  const candidate = {
    client: {
      full_name: 'Harish Tanniru',
      applywizz_id: 'AWL-584',
      personal_email: 'harish.tanniru@example.com'
    },
    additional_information: {
      experience: '7 years total backend engineering experience in Java and Cloud.'
    }
  };

  const parsedResume = {
    skills: {
      languages: ['Java', 'Python'],
      frameworks: ['Spring Boot', 'Kafka'],
      cloud: ['AWS', 'Docker', 'Kubernetes']
    },
    work_experience: [
      {
        job_title: 'Senior Distributed Systems Engineer',
        company: 'Cloud Corp',
        highlights: [
          'Engineered event streaming platform using Apache Kafka handling 50k events/sec.',
          'Reduced microservices latency by 40% using asynchronous patterns.'
        ]
      }
    ]
  };

  const questions = [
    {
      questionId: 'q_years_exp',
      label: 'How many years of backend experience do you have?',
      type: 'combobox',
      options: ['1-2 years', '3-5 years', '5+ years']
    },
    {
      questionId: 'q_degree_level',
      label: 'Highest level of education completed',
      type: 'combobox',
      options: ["Bachelor's Degree", "Master's Degree", 'Doctorate']
    },
    {
      questionId: 'q_event_driven',
      label: 'Do you have hands-on experience with Kafka and event-driven architecture?',
      type: 'radio',
      options: ['Yes', 'No']
    },
    {
      questionId: 'q_internal_ref',
      label: 'Internal employee referral ID:',
      type: 'text'
    }
  ];

  const draftAnswers = {
    q_years_exp: {
      answer: '5+ years',
      confidence: 0.90,
      rationale: 'Candidate has 7 total years of backend experience.'
    },
    q_degree_level: {
      answer: "Master's Degree", // Hallucinated draft
      confidence: 0.85,
      rationale: 'Guessed master degree.'
    },
    q_event_driven: {
      answer: null, // Low confidence / null draft
      confidence: 0.50,
      rationale: 'Haiku was uncertain about Kafka depth.'
    },
    q_internal_ref: {
      answer: null,
      confidence: 0.0,
      rationale: 'Missing in CRM'
    }
  };

  // Mock Anthropic Messages endpoint
  const mockJudgeResponse = {
    id: 'msg_judge_123',
    type: 'message',
    role: 'assistant',
    model: 'dynamic-judge-model',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          evaluations: {
            q_years_exp: {
              verdict: 'APPROVED',
              final_answer: '5+ years',
              confidence: 0.95,
              rationale: 'Verified: 7 years total backend experience matches 5+ years option.'
            },
            q_degree_level: {
              verdict: 'CORRECTED',
              final_answer: "Bachelor's Degree",
              confidence: 0.90,
              rationale: 'Corrected hallucination: Candidate holds a Bachelor degree, not Masters.'
            },
            q_event_driven: {
              verdict: 'RESOLVED',
              final_answer: 'Yes',
              confidence: 0.90,
              rationale: 'Resolved: Resume explicitly highlights Kafka event streaming platform at Cloud Corp.'
            },
            q_internal_ref: {
              verdict: 'UNRESOLVABLE',
              final_answer: null,
              confidence: 0.0,
              rationale: 'No employee referral ID exists in candidate records.'
            }
          }
        })
      }
    ],
    usage: { input_tokens: 350, output_tokens: 150 }
  };

  let capturedRequestBody = null;
  const mockFetch = async (url, options) => {
    capturedRequestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => mockJudgeResponse
    };
  };

  const service = new ClaudeService({
    apiKey: 'test-key',
    draftModel: 'test-haiku',
    judgeModel: 'test-sonnet-judge',
    fetchFn: mockFetch
  });

  const evaluations = await service.judgeCandidateBatch({
    client: candidate,
    parsedResume,
    questions,
    draftAnswers
  });

  // Verify dynamic model was passed to Anthropic
  assert.equal(capturedRequestBody.model, 'test-sonnet-judge');

  // 1. APPROVED evaluation
  assert.equal(evaluations.q_years_exp.verdict, 'APPROVED');
  assert.equal(evaluations.q_years_exp.answer, '5+ years');
  assert.equal(evaluations.q_years_exp.confidence, 0.95);

  // 2. CORRECTED evaluation (overriding hallucination)
  assert.equal(evaluations.q_degree_level.verdict, 'CORRECTED');
  assert.equal(evaluations.q_degree_level.answer, "Bachelor's Degree");
  assert.equal(evaluations.q_degree_level.confidence, 0.90);

  // 3. RESOLVED evaluation (solving null/low confidence question)
  assert.equal(evaluations.q_event_driven.verdict, 'RESOLVED');
  assert.equal(evaluations.q_event_driven.answer, 'Yes');
  assert.equal(evaluations.q_event_driven.confidence, 0.90);

  // 4. UNRESOLVABLE evaluation (genuinely missing fact)
  assert.equal(evaluations.q_internal_ref.verdict, 'UNRESOLVABLE');
  assert.equal(evaluations.q_internal_ref.answer, null);
  assert.equal(evaluations.q_internal_ref.confidence, 0.0);
});

test('ClaudeService.judgeCandidateBatch - Option Alignment & Verbatim Enforcement', async (t) => {
  const candidate = { client: { full_name: 'Test Candidate' } };
  const questions = [
    {
      questionId: 'q_relocation',
      label: 'Are you willing to relocate?',
      type: 'combobox',
      options: ['Yes, willingly', 'No, remote only']
    }
  ];

  const draftAnswers = {
    q_relocation: { answer: 'Yes', confidence: 0.80, rationale: 'Candidate said yes' }
  };

  // Judge returns slightly rephrased string "Yes"
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            evaluations: {
              q_relocation: {
                verdict: 'APPROVED',
                final_answer: 'Yes',
                confidence: 0.95,
                rationale: 'Confirmed'
              }
            }
          })
        }
      ]
    })
  });

  const service = new ClaudeService({
    apiKey: 'test-key',
    draftModel: 'test-haiku',
    judgeModel: 'test-sonnet',
    fetchFn: mockFetch
  });

  const evals = await service.judgeCandidateBatch({
    client: candidate,
    questions,
    draftAnswers
  });

  // Post-judge option enforcement must force alignment to exact verbatim option string
  assert.equal(evals.q_relocation.answer, 'Yes, willingly');
  assert.equal(evals.q_relocation.confidence, 0.95);
});

test('ClaudeService.judgeCandidateBatch - Graceful Degradation on Judge API Failure', async (t) => {
  const candidate = { client: { full_name: 'Test Candidate' } };
  const questions = [
    {
      questionId: 'q_valid',
      label: 'Do you have Java experience?',
      type: 'radio',
      options: ['Yes', 'No']
    },
    {
      questionId: 'q_weak',
      label: 'Complex question',
      type: 'text'
    }
  ];

  const draftAnswers = {
    q_valid: { answer: 'Yes', confidence: 0.90, rationale: 'From resume' },
    q_weak: { answer: null, confidence: 0.40, rationale: 'Uncertain' }
  };

  // Mock HTTP 500 error from Judge API
  const mockFetch = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    text: async () => 'Anthropic overload'
  });

  const service = new ClaudeService({
    apiKey: 'test-key',
    draftModel: 'test-haiku',
    judgeModel: 'test-sonnet',
    fetchFn: mockFetch
  });

  // Must not throw or crash! Gracefully degrades to draft answers.
  const evals = await service.judgeCandidateBatch({
    client: candidate,
    questions,
    draftAnswers
  });

  assert.equal(evals.q_valid.answer, 'Yes');
  assert.equal(evals.q_valid.verdict, 'APPROVED');
  assert.equal(evals.q_weak.answer, null);
  assert.equal(evals.q_weak.verdict, 'UNRESOLVABLE');
});

test('ClaudeService.judgeCandidateBatch - Single-Model Mode when judgeModel is null', async (t) => {
  const candidate = { client: { full_name: 'Test Candidate' } };
  const questions = [
    { questionId: 'q1', label: 'Q1', type: 'text' }
  ];
  const draftAnswers = {
    q1: { answer: 'Answer 1', confidence: 0.88, rationale: 'Valid' }
  };

  // Service with judgeModel omitted / null
  const singleModelService = new ClaudeService({
    apiKey: 'test-key',
    draftModel: 'test-haiku',
    judgeModel: null
  });

  assert.equal(singleModelService.isJudgeAvailable(), false);

  // Directly returns draft answers without attempting any Judge API call
  const evals = await singleModelService.judgeCandidateBatch({
    client: candidate,
    questions,
    draftAnswers
  });

  assert.equal(evals.q1.answer, 'Answer 1');
  assert.equal(evals.q1.verdict, 'APPROVED');
});

test('Phase3AnswerResolution integrates Two-Tier Cascade JudgeLM (Haiku Drafter + Sonnet Arbiter)', async () => {
  let draftCalled = false;
  let judgeCalled = false;

  const mockFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.model === 'test-haiku-drafter') {
      draftCalled = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{
            text: JSON.stringify({
              answers: {
                q_1: { answer: 'AWS and Docker', confidence: 0.85, rationale: 'From resume' }
              }
            })
          }]
        })
      };
    }
    if (body.model === 'test-sonnet-judge') {
      judgeCalled = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{
            text: JSON.stringify({
              evaluations: {
                q_1: {
                  verdict: 'APPROVED',
                  final_answer: 'AWS and Docker',
                  confidence: 0.95,
                  rationale: 'Audited and verified against candidate AWS experience'
                }
              }
            })
          }]
        })
      };
    }
    return { ok: false, status: 400 };
  };

  const claudeService = new ClaudeService({
    apiKey: 'mock-key',
    draftModel: 'test-haiku-drafter',
    judgeModel: 'test-sonnet-judge',
    fetchFn: mockFetch
  });

  const engine = new ResolutionEngine({ claudeService });

  const mockStore = {
    async read(name, fallback) {
      if (name === 'jobs') {
        return {
          uniqueJobs: [{ jobKey: 'job-judge-1' }],
          assignments: [{ applywizzId: 'cand-judge', jobKey: 'job-judge-1', companyName: 'Cloud Systems' }]
        };
      }
      if (name === 'form-templates') {
        return {
          'job-judge-1': {
            fields: [
              { id: 'cloud_tools', label: 'What cloud tools do you use?', type: 'text', required: true }
            ]
          }
        };
      }
      if (name === 'applications') return [];
      return fallback;
    },
    async write() {},
    async loadQuestionBank() {
      return { clientHistoryMap: new Map(), globalHistory: [] };
    },
    async upsertQuestionBank() {}
  };

  const phase3 = new Phase3AnswerResolution({
    store: mockStore,
    engine,
    config: { llmDelayMs: 0, llmBatchMaxQuestions: 20 }
  });

  phase3.loadClients = async () => ({
    'cand-judge': {
      client: { full_name: 'Jordan Lee', first_name: 'Jordan', last_name: 'Lee' },
      additional_information: { experience: 'AWS Cloud architect with 6 years experience' }
    }
  });

  const apps = await phase3.createOrResolveApplications();
  assert.equal(draftCalled, true, 'Draft model must be called');
  assert.equal(judgeCalled, true, 'Judge model must be called');
  assert.equal(apps.length, 1);
  const app = apps[0];
  assert.equal(app.values.cloud_tools.value, 'AWS and Docker');
  assert.equal(app.values.cloud_tools.stage, 'stage4_llm_judge');
  assert.equal(app.values.cloud_tools.source, 'tier2_claude_judge');
  assert.equal(app.values.cloud_tools.confidence, 0.95);
  assert.equal(app.values.cloud_tools.verdict, 'APPROVED');
});
