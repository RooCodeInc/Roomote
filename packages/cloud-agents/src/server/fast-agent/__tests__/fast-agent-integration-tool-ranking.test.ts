const { mockEvaluateTypeSafeJudgments } = vi.hoisted(() => ({
  mockEvaluateTypeSafeJudgments: vi.fn(),
}));

vi.mock('../../typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: mockEvaluateTypeSafeJudgments,
}));

import type { IntegrationToolCandidate } from '@roomote/types';

import { matchIntegrationToolsWithRanking } from '../fast-agent-integration-tool-ranking';

const catalog: IntegrationToolCandidate[] = [
  {
    integrationId: 'tracker',
    name: 'create_issue',
    description: 'Create a new issue in a project',
  },
  {
    integrationId: 'tracker',
    name: 'list_issues',
    description: 'List issues in a project',
  },
  {
    integrationId: 'pager',
    name: 'get_schedule',
    description: 'Show the current on-call rotation',
  },
];

type JudgmentParams = {
  state: { query: string; tools: Record<string, string> };
  questions: Record<string, { instructions: string }>;
};

/** Answer each tool question by the tool's `integrationId/name`. */
function answerByToolName(scores: Record<string, number>) {
  return async ({ state, questions }: JudgmentParams) =>
    Object.fromEntries(
      Object.keys(questions).map((key) => [
        key,
        {
          type: 'noul',
          noul: scores[state.tools[key]!.split(':')[0]!] ?? 0,
        },
      ]),
    );
}

function judgedParams(call = 0): JudgmentParams {
  return mockEvaluateTypeSafeJudgments.mock.calls[call]![0] as JudgmentParams;
}

describe('matchIntegrationToolsWithRanking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateTypeSafeJudgments.mockResolvedValue(null);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a small complete keyword match without judging', async () => {
    const result = await matchIntegrationToolsWithRanking(catalog, {
      query: 'issue',
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      'create_issue',
      'list_issues',
    ]);
    expect(mockEvaluateTypeSafeJudgments).not.toHaveBeenCalled();
  });

  it('does not judge exact tool-name or query-less lookups', async () => {
    await matchIntegrationToolsWithRanking(catalog, {
      toolName: 'nothing',
      query: 'file a bug',
    });
    await matchIntegrationToolsWithRanking(catalog, {
      integrationId: 'tracker',
    });

    expect(mockEvaluateTypeSafeJudgments).not.toHaveBeenCalled();
  });

  it('keeps the keyword result when the judgment model is unconfigured', async () => {
    const result = await matchIntegrationToolsWithRanking(catalog, {
      query: 'file a bug ticket',
    });

    expect(result).toEqual({
      tools: [],
      truncated: false,
      availableToolCount: 3,
    });
    expect(mockEvaluateTypeSafeJudgments).toHaveBeenCalledOnce();
  });

  it('returns relevant tools by probability when keywords match nothing', async () => {
    mockEvaluateTypeSafeJudgments.mockImplementation(
      answerByToolName({
        'tracker/create_issue': 0.94,
        'tracker/list_issues': 0.55,
        'pager/get_schedule': 0.03,
      }),
    );

    const result = await matchIntegrationToolsWithRanking(catalog, {
      query: 'file a bug ticket',
      limit: 1,
    });

    expect(result).toEqual({
      tools: [catalog[0]],
      truncated: true,
      availableToolCount: 3,
    });
    const { state, questions } = judgedParams();
    expect(state).toEqual({
      query: 'file a bug ticket',
      tools: {
        t0: 'tracker/create_issue: Create a new issue in a project',
        t1: 'tracker/list_issues: List issues in a project',
        t2: 'pager/get_schedule: Show the current on-call rotation',
      },
    });
    expect(questions.t1!.instructions).toContain('`tools.t1`');
  });

  it('judges only the requested integration', async () => {
    mockEvaluateTypeSafeJudgments.mockImplementation(
      answerByToolName({ 'pager/get_schedule': 0.9 }),
    );

    const result = await matchIntegrationToolsWithRanking(catalog, {
      integrationId: 'pager',
      query: 'who is on call',
    });

    expect(result).toEqual({
      tools: [catalog[2]],
      truncated: false,
      availableToolCount: 1,
    });
    expect(Object.keys(judgedParams().state.tools)).toEqual(['t0']);
  });

  it('re-ranks a truncated keyword match', async () => {
    const many: IntegrationToolCandidate[] = Array.from(
      { length: 12 },
      (_, index) => ({
        integrationId: 'deploys',
        name: `tool_${index}`,
        description: 'deploy helper',
      }),
    );
    mockEvaluateTypeSafeJudgments.mockImplementation(
      answerByToolName({ 'deploys/tool_7': 0.8, 'deploys/tool_3': 0.9 }),
    );

    const result = await matchIntegrationToolsWithRanking(many, {
      query: 'deploy',
    });

    expect(result).toEqual({
      tools: [many[3], many[7]],
      truncated: false,
      availableToolCount: 12,
    });
  });

  it('keeps the keyword result when no tool is relevant enough', async () => {
    mockEvaluateTypeSafeJudgments.mockImplementation(
      answerByToolName({ 'tracker/create_issue': 0.45 }),
    );

    const result = await matchIntegrationToolsWithRanking(catalog, {
      query: 'file a bug ticket',
    });

    expect(result.tools).toEqual([]);
  });

  it('keeps the keyword result when the judgment model fails', async () => {
    mockEvaluateTypeSafeJudgments.mockRejectedValue(new Error('timeout'));

    const result = await matchIntegrationToolsWithRanking(catalog, {
      query: 'file a bug ticket',
    });

    expect(result.tools).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[FastAgentIntegrationTools]'),
    );
  });

  it('caps judged tools, splits requests, and truncates long tool text', async () => {
    const large: IntegrationToolCandidate[] = Array.from(
      { length: 300 },
      (_, index) => ({
        integrationId: 'big',
        name: `tool_${index}`,
        description:
          index === 299
            ? `recent deploys ${'x'.repeat(800)}`
            : 'unrelated helper',
      }),
    );
    mockEvaluateTypeSafeJudgments.mockImplementation(
      answerByToolName({ 'big/tool_299': 0.9 }),
    );

    const result = await matchIntegrationToolsWithRanking(large, {
      query: 'list recent deploys',
    });

    expect(result.tools).toEqual([large[299]]);
    expect(mockEvaluateTypeSafeJudgments).toHaveBeenCalledTimes(4);
    const judgedKeys = mockEvaluateTypeSafeJudgments.mock.calls.flatMap(
      ([params]) => Object.keys((params as JudgmentParams).state.tools),
    );
    expect(judgedKeys).toHaveLength(256);
    expect(new Set(judgedKeys).size).toBe(256);
    const firstTool = judgedParams().state.tools.t0!;
    expect(firstTool.startsWith('big/tool_299: recent deploys')).toBe(true);
    expect(firstTool).toHaveLength(400);
  });
});
