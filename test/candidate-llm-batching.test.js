import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeService } from '../src/services/claude-service.js';
import { Phase3AnswerResolution } from '../src/phases/phase3-answer-resolution.js';
import { ResolutionEngine } from '../src/domain/resolution-engine.js';

test('ClaudeService.resolveCandidateBatch batches questions and returns structured answers', async () => {
  let capturedBody = null;
  const mockFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        content: [{
          text: JSON.stringify({
            answers: {
              q1: { answer: '5+ years', confidence: 0.95, rationale: 'Matches candidate profile' },
              q2: { answer: 'I built an enterprise event-driven architecture using Kafka.', confidence: 0.88, rationale: 'Extracted from resume experience' }
            }
          })
        }]
      })
    };
  };

  const claude = new ClaudeService({
    apiKey: 'mock-key',
    model: 'claude-3-5-sonnet-20241022',
    fetchFn: mockFetch
  });

  const client = {
    client: { full_name: 'Jane Doe', personal_email: 'jane@example.com' },
    additional_information: { experience: 'Senior backend engineer with Kafka, Go, and AWS' }
  };

  const questions = [
    {
      questionId: 'q1',
      label: 'Years of Experience with Distributed Systems',
      type: 'radio',
      options: ['1-2 years', '3-4 years', '5+ years'],
      company: 'Oracle'
    },
    {
      questionId: 'q2',
      label: 'Describe a complex architecture you designed',
      type: 'textarea',
      company: 'Oracle'
    }
  ];

  const results = await claude.resolveCandidateBatch({ client, questions });

  assert.equal(results.q1.answer, '5+ years');
  assert.equal(results.q1.confidence, 0.90); // Capped at 0.90
  assert.equal(results.q2.answer, 'I built an enterprise event-driven architecture using Kafka.');
  assert.ok(capturedBody.messages[0].content.includes('Jane Doe'));
  assert.ok(capturedBody.messages[0].content.includes('Years of Experience with Distributed Systems'));
});

test('ClaudeService.resolveCandidateBatch enforces strict option matching and rejects invalid options', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{
        text: JSON.stringify({
          answers: {
            q_valid: { answer: 'Authorized', confidence: 0.90 },
            q_invalid: { answer: 'Maybe later', confidence: 0.90 } // Not in allowed options!
          }
        })
      }]
    })
  });

  const claude = new ClaudeService({
    apiKey: 'mock-key',
    fetchFn: mockFetch
  });

  const client = { client: { full_name: 'John Smith' } };
  const questions = [
    {
      questionId: 'q_valid',
      label: 'Work Auth',
      options: ['Authorized', 'Sponsorship Required']
    },
    {
      questionId: 'q_invalid',
      label: 'Are you open to relocation?',
      options: ['Yes', 'No']
    }
  ];

  const results = await claude.resolveCandidateBatch({ client, questions });

  assert.equal(results.q_valid.answer, 'Authorized');
  assert.equal(results.q_invalid.answer, null, 'Invalid option should be coerced to null');
  assert.equal(results.q_invalid.confidence, 0.0);
});

test('ClaudeService retries with exponential backoff on HTTP 429', async () => {
  let attempts = 0;
  const mockFetch = async () => {
    attempts++;
    if (attempts === 1) {
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: { get: (name) => name === 'retry-after' ? '0' : null },
        text: async () => 'Rate limit exceeded'
      };
    }
    return {
      ok: true,
      json: async () => ({
        content: [{
          text: JSON.stringify({
            answers: {
              q1: { answer: 'Yes', confidence: 0.90 }
            }
          })
        }]
      })
    };
  };

  const claude = new ClaudeService({
    apiKey: 'mock-key',
    fetchFn: mockFetch
  });

  const questions = [{ questionId: 'q1', label: 'Eligible?', options: ['Yes', 'No'] }];
  const results = await claude.resolveCandidateBatch({ client: {}, questions });

  assert.equal(attempts, 2, 'Expected 1 retry attempt after 429');
  assert.equal(results.q1.answer, 'Yes');
});

test('Phase3AnswerResolution groups questions across multiple jobs for the same candidate and allocates answers', async () => {
  let batchCalls = 0;
  const mockFetch = async () => {
    batchCalls++;
    return {
      ok: true,
      json: async () => ({
        content: [{
          text: JSON.stringify({
            answers: {
              q_1: { answer: 'Yes, 5 years', confidence: 0.90 }
            }
          })
        }]
      })
    };
  };

  const claudeService = new ClaudeService({
    apiKey: 'mock-key',
    fetchFn: mockFetch
  });

  const engine = new ResolutionEngine({ claudeService });

  const mockStore = {
    async read(name, fallback) {
      if (name === 'jobs') {
        return {
          uniqueJobs: [{ jobKey: 'job-1' }, { jobKey: 'job-2' }],
          assignments: [
            { applywizzId: 'cand-1', jobKey: 'job-1', companyName: 'Company A' },
            { applywizzId: 'cand-1', jobKey: 'job-2', companyName: 'Company B' }
          ]
        };
      }
      if (name === 'form-templates') {
        return {
          'job-1': {
            templateId: 't-1',
            fields: [
              { id: 'first_name', label: 'First Name', required: true },
              { id: 'custom_screening', label: 'Do you have experience with Kubernetes?', type: 'text', required: true },
              { id: 'optional_note', label: 'Optional notes for recruiter', type: 'text', required: false }
            ]
          },
          'job-2': {
            templateId: 't-2',
            fields: [
              { id: 'first_name', label: 'First Name', required: true },
              // Identical question on Job 2
              { id: 'k8s_experience', label: 'Do you have experience with Kubernetes?', type: 'text', required: true }
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

  // Mock loadClients
  phase3.loadClients = async () => ({
    'cand-1': {
      client: { full_name: 'Alex Rivera', first_name: 'Alex', last_name: 'Rivera' },
      additional_information: { experience: '5 years Kubernetes and Docker engineer' }
    }
  });

  const applications = await phase3.createOrResolveApplications();

  assert.equal(batchCalls, 1, 'Claude should only be called ONCE for the candidate despite multiple jobs');
  assert.equal(applications.length, 2);

  const app1 = applications.find(a => a.jobKey === 'job-1');
  const app2 = applications.find(a => a.jobKey === 'job-2');

  assert.equal(app1.values.custom_screening.value, 'Yes, 5 years');
  assert.equal(app1.values.custom_screening.stage, 'stage4_llm');
  assert.equal(app2.values.k8s_experience.value, 'Yes, 5 years');
  assert.equal(app2.values.k8s_experience.stage, 'stage4_llm');

  // Verify optional field was not sent to LLM and remains unresolved (null)
  assert.equal(app1.values.optional_note.value, null, 'Optional field should be skipped from LLM');
});
