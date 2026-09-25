import type { UserAuthSuccess } from '@/types';

const mocks = vi.hoisted(() => ({
  resolveBackend: vi.fn(),
  testBackend: vi.fn(),
  upstreamConfigured: vi.fn(() => false),
}));

vi.mock('@roomote/cloud-agents/server/typesafe-judgment', () => ({
  resolveJudgmentBackend: mocks.resolveBackend,
  testJudgmentBackend: mocks.testBackend,
}));
vi.mock('@roomote/cloud-agents/server/judgment-decision-catalog', () => ({
  JUDGMENT_DECISION_CATALOG: [
    { id: 'd', label: 'D', description: '', questions: {}, sampleState: {} },
  ],
}));
vi.mock('./judgment-model', () => ({
  assertAdmin: (auth: UserAuthSuccess) => {
    if (!auth.isAdmin) throw new Error('Unauthorized');
  },
  isRoomoteUpstreamConfigured: mocks.upstreamConfigured,
}));

import {
  getJudgmentDecisionCatalogCommand,
  judgmentDecisionTestSchema,
  testJudgmentDecisionCommand,
} from './judgment-decision-tester';

const admin = (userId = 'admin-1') =>
  ({ userId, isAdmin: true }) as unknown as UserAuthSuccess;
const member = {
  userId: 'member-1',
  isAdmin: false,
} as unknown as UserAuthSuccess;
const input = {
  state: { message: 'hi' },
  questions: {
    urgent: { type: 'noul' as const, instructions: 'Is it urgent?' },
  },
  targets: ['configured' as const],
};

describe('judgment decision tester', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upstreamConfigured.mockReturnValue(false);
    mocks.testBackend.mockResolvedValue({
      ok: true,
      provider: 'typesafe',
      model: 'jev',
      answers: {},
      invalid: [],
      latencyMs: 5,
    });
  });

  it('is admin only', async () => {
    await expect(getJudgmentDecisionCatalogCommand(member)).rejects.toThrow(
      'Unauthorized',
    );
    await expect(testJudgmentDecisionCommand(member, input)).rejects.toThrow(
      'Unauthorized',
    );
    expect(mocks.testBackend).not.toHaveBeenCalled();
  });

  it('offers the Roomote model as its own target only beside another backend', async () => {
    mocks.upstreamConfigured.mockReturnValue(true);
    mocks.resolveBackend.mockResolvedValue({ provider: 'typesafe' });
    await expect(
      getJudgmentDecisionCatalogCommand(admin()),
    ).resolves.toMatchObject({
      targets: {
        configured: { available: true, label: 'Jev via TypeSafe' },
        roomote: { available: true },
      },
    });

    mocks.resolveBackend.mockResolvedValue({ provider: 'roomote' });
    await expect(
      getJudgmentDecisionCatalogCommand(admin()),
    ).resolves.toMatchObject({
      targets: {
        configured: { available: true },
        roomote: { available: false },
      },
    });

    mocks.resolveBackend.mockResolvedValue(undefined);
    await expect(
      getJudgmentDecisionCatalogCommand(admin()),
    ).resolves.toMatchObject({
      targets: { configured: { available: false } },
    });
  });

  it('asks each chosen target once and returns results by target', async () => {
    await expect(
      testJudgmentDecisionCommand(admin('a2'), {
        ...input,
        targets: ['configured', 'roomote', 'configured'],
      }),
    ).resolves.toEqual({
      configured: expect.objectContaining({ ok: true }),
      roomote: expect.objectContaining({ ok: true }),
    });
    expect(mocks.testBackend).toHaveBeenCalledTimes(2);
  });

  it('limits each admin to 20 tests a minute', async () => {
    const auth = admin('a3');
    for (let i = 0; i < 20; i += 1)
      await testJudgmentDecisionCommand(auth, input);
    await expect(testJudgmentDecisionCommand(auth, input)).rejects.toThrow(
      'At most 20 tests a minute.',
    );
    await expect(
      testJudgmentDecisionCommand(admin('a4'), input),
    ).resolves.toBeDefined();
  });

  it('rejects malformed questions and oversized requests', () => {
    expect(judgmentDecisionTestSchema.safeParse(input).success).toBe(true);
    expect(
      judgmentDecisionTestSchema.safeParse({ ...input, questions: {} }).success,
    ).toBe(false);
    expect(
      judgmentDecisionTestSchema.safeParse({
        ...input,
        questions: {
          pick: {
            type: 'choice',
            instructions: 'x',
            criteria: { only: 'one' },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      judgmentDecisionTestSchema.safeParse({ ...input, targets: [] }).success,
    ).toBe(false);
    expect(
      judgmentDecisionTestSchema.safeParse({
        ...input,
        state: { text: 'x'.repeat(70_000) },
      }).success,
    ).toBe(false);
  });
});
