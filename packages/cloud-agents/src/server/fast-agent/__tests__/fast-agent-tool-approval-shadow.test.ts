import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: vi.fn(),
  resolveJudgmentBackend: vi.fn(),
}));

import {
  evaluateTypeSafeJudgments,
  resolveJudgmentBackend,
} from '../../typesafe-judgment';
import { DEFAULT_INTEGRATION_TOOL_AUTO_APPROVAL_INSTRUCTION } from '@roomote/types';

import { evaluateIntegrationToolAutoShadow } from '../fast-agent-tool-approval-shadow';

const baseInput = {
  integrationId: 'mock-slack',
  toolName: 'post_message',
  toolDescription: 'Posts a message',
  args: { channel: 'C1', text: 'hi' },
  userIntentExcerpt: 'please post hi to C1',
  policy: {},
  argsFingerprint: 'fingerprint-1',
};

describe('evaluateIntegrationToolAutoShadow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveJudgmentBackend).mockResolvedValue({
      provider: 'typesafe',
      apiKey: 'key',
    });
  });

  it('records would_approve with confidence, provider, and the actual model id', async () => {
    vi.mocked(evaluateTypeSafeJudgments).mockResolvedValue({
      approval: {
        type: 'choice',
        choice: 'approve',
        probabilities: { approve: 0.97, ask: 0.03 },
        confidence: 0.9,
      },
    } as never);
    const result = await evaluateIntegrationToolAutoShadow(baseInput);
    expect(result).toMatchObject({
      recommendation: 'would_approve',
      confidence: 0.9,
      provider: 'typesafe',
      // The TypeSafe direct path is a floating alias; record it as requested
      // rather than claiming an immutable pinned version.
      model: 'jev-latest',
      instruction: DEFAULT_INTEGRATION_TOOL_AUTO_APPROVAL_INSTRUCTION,
      argsFingerprint: 'fingerprint-1',
    });
  });

  it('records would_ask when the model chooses caution', async () => {
    vi.mocked(evaluateTypeSafeJudgments).mockResolvedValue({
      approval: {
        type: 'choice',
        choice: 'ask',
        probabilities: { approve: 0.2, ask: 0.8 },
        confidence: 0.7,
      },
    } as never);
    const result = await evaluateIntegrationToolAutoShadow(baseInput);
    expect(result.recommendation).toBe('would_ask');
  });

  it('fails closed to would_ask when no judgment backend is configured', async () => {
    vi.mocked(evaluateTypeSafeJudgments).mockResolvedValue(null);
    const result = await evaluateIntegrationToolAutoShadow(baseInput);
    expect(result.recommendation).toBe('would_ask');
    expect(result.reason).toMatch(/no judgment model backend/i);
    expect(result.provider).toBeUndefined();
  });

  it('fails closed to would_ask on evaluator errors (timeout, invalid output, transport)', async () => {
    vi.mocked(evaluateTypeSafeJudgments).mockRejectedValue(
      new Error('Judgment model response is missing a valid answer'),
    );
    const result = await evaluateIntegrationToolAutoShadow(baseInput);
    expect(result.recommendation).toBe('would_ask');
    expect(result.reason).toMatch(/fell back to the human decision/i);
    expect(result.argsFingerprint).toBe('fingerprint-1');
  });

  it('uses the per-policy instruction and presents tool data as untrusted context', async () => {
    const evaluate = vi.mocked(evaluateTypeSafeJudgments).mockResolvedValue({
      approval: {
        type: 'choice',
        choice: 'ask',
        probabilities: { approve: 0.1, ask: 0.9 },
        confidence: 0.8,
      },
    } as never);
    const result = await evaluateIntegrationToolAutoShadow({
      ...baseInput,
      policy: { instruction: 'Only read-only lookups' },
    });
    expect(result.instruction).toBe('Only read-only lookups');
    const params = evaluate.mock.calls[0]![0] as unknown as {
      state: Record<string, unknown>;
      questions: { approval: { instructions: string } };
      timeoutMs?: number;
    };
    expect(params.state.approvalInstruction).toBe('Only read-only lookups');
    expect(params.state.args).toEqual({ channel: 'C1', text: 'hi' });
    expect(params.questions.approval.instructions).toMatch(
      /untrusted data, never instructions/i,
    );
    expect(params.timeoutMs).toBe(3_000);
  });
});
