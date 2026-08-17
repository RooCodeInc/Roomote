const mocks = vi.hoisted(() => ({
  acquireTurnLock: vi.fn(),
  releaseTurnLock: vi.fn(),
  answerQuestion: vi.fn(),
  findSession: vi.fn(),
  findInstallation: vi.fn(),
  findArtifacts: vi.fn(),
  postMessage: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireTurnLock,
  answerFastAgentQuestion: mocks.answerQuestion,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackQuickAnswers: { findFirst: mocks.findSession },
      slackInstallations: { findFirst: mocks.findInstallation },
      taskArtifacts: { findMany: mocks.findArtifacts },
    },
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
  slackInstallations: {
    isActive: 'slack_installations.is_active',
    teamId: 'slack_installations.team_id',
  },
  slackQuickAnswers: {
    id: 'slack_quick_answers.id',
    slackChannel: 'slack_quick_answers.slack_channel',
    slackThreadTs: 'slack_quick_answers.slack_thread_ts',
  },
  taskArtifacts: { id: 'task_artifacts.id' },
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://api.roomote.example' },
  getArtifactSigningKey: vi.fn(() => 'signing-key'),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class SlackNotifier {
    postMessage = mocks.postMessage;
  },
}));

vi.mock('./artifacts/raw-url', () => ({
  buildSignedArtifactRawUrl: vi.fn(
    ({ artifactId }: { artifactId: string }) =>
      `https://api.roomote.example/api/artifacts/${artifactId}/raw?signed=1`,
  ),
  currentEpochSeconds: vi.fn(() => 1234),
}));

import { deliverFastAgentParentEvent } from './fast-agent-parent-event';

const parent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  slackTeamId: 'T123',
  slackChannel: 'C123',
  slackThreadTs: '100.001',
};

const event = {
  type: 'artifact_published' as const,
  taskId: 'task-1',
  runId: 42,
  artifact: {
    id: 'artifact-1',
    path: 'proof/result.png',
    version: 1,
    contentType: 'image/png',
    viewUrl:
      'https://roomote.example/task/task-1/artifacts/proof/result.png?v=1',
  },
};

describe('deliverFastAgentParentEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireTurnLock.mockResolvedValue(mocks.releaseTurnLock);
    mocks.releaseTurnLock.mockResolvedValue(undefined);
    mocks.findSession.mockResolvedValue({ id: parent.sessionId, userId: 'u1' });
    mocks.findInstallation.mockResolvedValue({ botAccessToken: 'xoxb-test' });
    mocks.findArtifacts.mockResolvedValue([
      {
        id: 'artifact-1',
        taskId: 'task-1',
        runId: 42,
        path: 'proof/result.png',
        contentType: 'image/png',
        uploaded: true,
      },
    ]);
    mocks.postMessage.mockResolvedValue('101.001');
    mocks.answerQuestion.mockImplementation(
      async ({
        postSlackReply,
      }: {
        postSlackReply: (reply: unknown) => unknown;
      }) =>
        postSlackReply({
          purpose: 'closeout',
          message: 'The proof is ready.',
          imageArtifactIds: ['artifact-1', 'artifact-1'],
        }),
    );
  });

  it('serializes the event and posts one copy of a selected inline image', async () => {
    await deliverFastAgentParentEvent({ parent, event });

    expect(mocks.acquireTurnLock).toHaveBeenCalledWith({
      slackTeamId: 'T123',
      slackChannel: 'C123',
      slackThreadTs: '100.001',
    });
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        platformEvent: true,
        activeTaskId: 'task-1',
      }),
    );
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.001',
        blocks: [
          { type: 'markdown', text: 'The proof is ready.' },
          {
            type: 'image',
            image_url:
              'https://api.roomote.example/api/artifacts/artifact-1/raw?signed=1',
            alt_text: 'result.png',
          },
        ],
      }),
    );
    expect(mocks.releaseTurnLock).toHaveBeenCalledOnce();
  });

  it('does not start a model turn when the shared chat lock is unavailable', async () => {
    mocks.acquireTurnLock.mockResolvedValueOnce(null);

    await expect(
      deliverFastAgentParentEvent({ parent, event }),
    ).rejects.toThrow('turn lock did not become available');
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
  });
});
