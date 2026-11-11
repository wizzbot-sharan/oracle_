import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeService, parseBatchJson } from '../src/services/claude-service.js';

test('parseBatchJson handles clean JSON', () => {
  const input = JSON.stringify({
    answers: {
      q_1: { answer: 'Yes', confidence: 0.95, rationale: 'Clear match' }
    }
  });

  const parsed = parseBatchJson(input);
  assert.ok(parsed);
  assert.equal(parsed.answers?.q_1?.answer, 'Yes');
  assert.equal(parsed.answers?.q_1?.confidence, 0.95);
});

test('parseBatchJson strips markdown code fences', () => {
  const input = '```json\n{\n  "answers": {\n    "q_1": { "answer": "Option A", "confidence": 0.90, "rationale": "Direct" }\n  }\n}\n```';

  const parsed = parseBatchJson(input);
  assert.ok(parsed);
  assert.equal(parsed.answers?.q_1?.answer, 'Option A');
});

test('parseBatchJson extracts JSON surrounded by conversational preamble and postscript', () => {
  const input = 'Here are the candidate answers:\n\n```json\n{\n  "answers": {\n    "q_1": { "answer": "Bachelor of Science", "confidence": 0.95 }\n  }\n}\n```\nHope this helps!';

  const parsed = parseBatchJson(input);
  assert.ok(parsed);
  assert.equal(parsed.answers?.q_1?.answer, 'Bachelor of Science');
});

test('parseBatchJson salvages completed questions from truncated responses', () => {
  const truncated = `{\n  "answers": {\n    "q_1": {\n      "answer": "Yes",\n      "confidence": 0.95,\n      "rationale": "Experience matches"\n    },\n    "q_2": {\n      "answer": "Python",\n      "confidence": 0.88,\n      "rationale": "Mentioned in resume"\n    },\n    "q_3": {\n      "answer": "Incomplete text that got cut off mid-stre`;

  const parsed = parseBatchJson(truncated);
  assert.ok(parsed);
  assert.equal(parsed.answers?.q_1?.answer, 'Yes');
  assert.equal(parsed.answers?.q_2?.answer, 'Python');
  assert.equal(parsed.answers?.q_3, undefined, 'Truncated question 3 must be excluded safely');
});

test('ClaudeService.resolveCandidateBatch handles multi-block Anthropic response (thinking + text)', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'Analyzing candidate profile and education...' },
        {
          type: 'text',
          text: JSON.stringify({
            answers: {
              q_1: { answer: 'Yes', confidence: 0.90, rationale: 'Valid' }
            }
          })
        }
      ]
    })
  });

  const service = new ClaudeService({
    apiKey: 'test-api-key',
    model: 'claude-3-5-sonnet-20241022',
    fetchFn: mockFetch
  });

  const res = await service.resolveCandidateBatch({
    client: { client: { full_name: 'Test Candidate' } },
    questions: [{ questionId: 'q_1', label: 'Are you authorized?', type: 'text' }]
  });

  assert.equal(res.q_1?.answer, 'Yes');
  assert.equal(res.q_1?.confidence, 0.90);
});

test('ClaudeService.resolveCandidateBatch salvages partial answers on token limit truncation', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      stop_reason: 'max_tokens',
      content: [
        {
          type: 'text',
          text: `{\n  "answers": {\n    "q_1": { "answer": "US Citizen", "confidence": 0.95, "rationale": "Resume states US Citizen" },\n    "q_2": { "answer": "Cut off mid`
        }
      ]
    })
  });

  const service = new ClaudeService({
    apiKey: 'test-api-key',
    model: 'claude-3-5-sonnet-20241022',
    fetchFn: mockFetch
  });

  const res = await service.resolveCandidateBatch({
    client: { client: { full_name: 'Test Candidate' } },
    questions: [
      { questionId: 'q_1', label: 'Citizenship', type: 'text' },
      { questionId: 'q_2', label: 'Long Essay Question', type: 'textarea' }
    ]
  });

  assert.equal(res.q_1?.answer, 'US Citizen');
  assert.equal(res.q_1?.confidence, 0.90); // Capped at 0.90
  assert.equal(res.q_2, undefined); // Unfinished question stays undefined so caller leaves it null/needs_input
});
