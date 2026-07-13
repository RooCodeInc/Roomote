const { chatPostMessageMock, findFirstMock, getDebugChannelMock } = vi.hoisted(
  () => ({
    chatPostMessageMock: vi.fn(),
    findFirstMock: vi.fn(),
    getDebugChannelMock: vi.fn(),
  }),
);

vi.mock('@roomote/env', () => ({
  Env: {
    R_ROUTER_DEBUG_CHANNEL_ID: 'CDEBUG',
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: {
        findFirst: findFirstMock,
      },
    },
  },
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  getConfiguredRouterDebugSlackChannelId: getDebugChannelMock,
  slackInstallations: {
    isActive: 'isActive',
  },
}));

vi.mock('../web-client', () => ({
  createSlackWebClient: vi.fn(() => ({
    chat: {
      postMessage: chatPostMessageMock,
    },
  })),
}));

import { postRouterDebugMessage } from '../router-debug';

describe('postRouterDebugMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getDebugChannelMock.mockResolvedValue('CDEBUG');
    findFirstMock.mockResolvedValue({ botAccessToken: 'xoxb-token' });
    chatPostMessageMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes the routed task model and selection source in debug channel messages', async () => {
    await postRouterDebugMessage({
      source: 'Slack C123',
      sourceLink:
        'https://app.slack.com/archives/C123/p123456?thread_ts=123.456&cid=C123',
      taskDescription: 'Use GPT 5.4 for this one.',
      selectedWorkspace: { name: 'App', type: 'environment' },
      reasoning: 'App is the best fit.',
      routingDebug: {
        phase: 'direct',
        toolsUsed: [],
        needsExternalLookup: false,
        confidence: 0.97,
        workspaceRemapped: false,
        selectedTaskModel: {
          id: 'openrouter/openai/gpt-5.4',
          displayName: 'GPT 5.4',
          source: 'preference',
          confidence: 0.96,
        },
      },
    });

    expect(chatPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'CDEBUG',
        text: 'Router | Slack C123',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining(
                '🔍 *Router* | <https://app.slack.com/archives/C123/p123456?thread_ts=123.456&cid=C123|Slack C123>',
              ),
            }),
          }),
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining(
                '• *Environment:* App — confidence 0.97',
              ),
            }),
          }),
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining(
                '*Message*\n> Use GPT 5.4 for this one.',
              ),
            }),
          }),
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining(
                '• *Model:* GPT 5.4 `openrouter/openai/gpt-5.4` — user preference, confidence 0.96',
              ),
            }),
          }),
        ]),
      }),
    );
  });

  it('includes a rejected low-confidence model pick in debug channel messages', async () => {
    await postRouterDebugMessage({
      source: 'Slack C123',
      taskDescription: 'Delete the Google Drive integration.',
      selectedWorkspace: { name: 'App', type: 'environment' },
      reasoning: 'App is the best fit.',
      routingDebug: {
        phase: 'direct',
        toolsUsed: [],
        needsExternalLookup: false,
        confidence: 0.97,
        workspaceRemapped: false,
        selectedTaskModel: {
          id: 'openrouter/z-ai/glm-5.2',
          displayName: 'GLM 5.2',
          source: 'default',
          rejectedPick: {
            id: 'openrouter/anthropic/claude-opus-4.8',
            displayName: 'Claude Opus 4.8',
            confidence: 0.55,
            reason: 'below_threshold',
          },
        },
      },
    });

    expect(chatPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'CDEBUG',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining(
                '• *Model:* GLM 5.2 `openrouter/z-ai/glm-5.2` — default',
              ),
            }),
          }),
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining(
                '*Rejected model pick:* Claude Opus 4.8 `openrouter/anthropic/claude-opus-4.8` — confidence 0.55 (below threshold)',
              ),
            }),
          }),
        ]),
      }),
    );
  });

  it('reports an explicit no-model choice with its confidence on the model line', async () => {
    await postRouterDebugMessage({
      source: 'Slack C123',
      taskDescription: 'Delete the Google Drive integration.',
      selectedWorkspace: { name: 'App', type: 'environment' },
      reasoning: 'App is the best fit.',
      routingDebug: {
        phase: 'direct',
        toolsUsed: [],
        needsExternalLookup: false,
        confidence: 0.97,
        workspaceRemapped: false,
        selectedTaskModel: {
          id: 'openrouter/z-ai/glm-5.2',
          displayName: 'GLM 5.2',
          source: 'default',
          noModelChoice: { confidence: 0.98 },
        },
      },
    });

    expect(chatPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'CDEBUG',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining(
                '• *Model:* GLM 5.2 `openrouter/z-ai/glm-5.2` — default (router choice: no model mentioned, confidence: 0.98)',
              ),
            }),
          }),
        ]),
      }),
    );
  });

  it('reports when the router did not report a model choice', async () => {
    await postRouterDebugMessage({
      source: 'Slack C123',
      taskDescription: 'Fix the login flow.',
      selectedWorkspace: { name: 'App', type: 'environment' },
      reasoning: 'App is the best fit.',
      routingDebug: {
        phase: 'direct',
        toolsUsed: [],
        needsExternalLookup: false,
        confidence: 0.97,
        workspaceRemapped: false,
        selectedTaskModel: {
          id: 'openrouter/z-ai/glm-5.2',
          displayName: 'GLM 5.2',
          source: 'default',
        },
      },
    });

    expect(chatPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'CDEBUG',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'section',
            text: expect.objectContaining({
              text: expect.stringContaining(
                '• *Model:* GLM 5.2 `openrouter/z-ai/glm-5.2` — default (router model choice: not reported)',
              ),
            }),
          }),
        ]),
      }),
    );
  });
});
