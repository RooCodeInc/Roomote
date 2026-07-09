import { TaskPayloadKind, type CloudTaskPayload } from '@roomote/types';

import { getCloudJobVisiblePrompt, getCloudJobPromptText } from '@/lib';

function buildCloudJob(payload: CloudTaskPayload) {
  return { payload } as const;
}

describe('getCloudJobPromptText', () => {
  it('prefers description-based prompts when present', () => {
    expect(
      getCloudJobPromptText(
        buildCloudJob({
          repo: 'Roomote/example-app',
          description: 'Investigate the failing route',
        } satisfies CloudTaskPayload<typeof TaskPayloadKind.StandardTask>),
      ),
    ).toBe('Investigate the failing route');
  });

  it('uses Slack text payloads as the visible prompt', () => {
    expect(
      getCloudJobPromptText(
        buildCloudJob({
          text: '<slack_message>\nplease help\n</slack_message>',
          channel: 'C123',
          user: 'U123',
          ts: '123.000',
          thread_ts: '123.456',
          repo: 'Roomote/example-app',
        } satisfies CloudTaskPayload<typeof TaskPayloadKind.SlackAppMention>),
      ),
    ).toBe('<slack_message>\nplease help\n</slack_message>');
  });

  it('uses GitHub follow-up comment bodies so ACP request envelopes stay hidden', () => {
    expect(
      getCloudJobPromptText(
        buildCloudJob({
          repo: 'Roomote/example-app',
          prNumber: 1746,
          prTitle: 'Fix the task transcript UI',
          commentBody:
            'Fix this specific issue:\n\nThe task page shows raw XML.',
        } satisfies CloudTaskPayload<
          typeof TaskPayloadKind.GithubPrReviewFollowUp
        >),
      ),
    ).toBe('Fix this specific issue:\n\nThe task page shows raw XML.');
  });

  it('prefers explicit snapshot resume prompts over inherited source prompt fields', () => {
    expect(
      getCloudJobPromptText(
        buildCloudJob({
          repo: 'Roomote/example-app',
          sourceSnapshotId: 'snapshot-123',
          sourceCloudJobId: 42,
          text: 'Original launch prompt',
          resumePrompt: 'Wake up and continue',
        } satisfies CloudTaskPayload<typeof TaskPayloadKind.SnapshotResume>),
      ),
    ).toBe('Wake up and continue');
  });
});

describe('getCloudJobVisiblePrompt', () => {
  it('strips Slack thread context and reply targets from the visible prompt text', () => {
    expect(
      getCloudJobVisiblePrompt(
        buildCloudJob({
          text: '<thread_context>\nAlice Example: Earlier detail\n</thread_context>\n\n<replying_to>\nRoomote Bot: Previous reply\n</replying_to>\n\n<slack_message>\nlatest question\n</slack_message>',
          channel: 'C123',
          user: 'U123',
          ts: '123.000',
          thread_ts: '123.456',
          repo: 'Roomote/example-app',
        } satisfies CloudTaskPayload<typeof TaskPayloadKind.SlackAppMention>),
      ),
    ).toEqual({
      text: 'latest question',
      visibleInTranscript: true,
    });
  });

  it('strips Slack turn policy metadata from the visible prompt text', () => {
    expect(
      getCloudJobVisiblePrompt(
        buildCloudJob({
          text: '<thread_context>\n<slack_thread_message ts="109.000">Alice Example: Earlier detail</slack_thread_message>\n</thread_context>\n\n<replying_to ts="110.000">\nRoomote Bot: Previous reply\n</replying_to>\n\n<slack_turn_policy reactions_allowed="true" prefer_emoji_ack="true">\nEmoji reactions are allowed on the current Slack message.\n</slack_turn_policy>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
          channel: 'C123',
          user: 'U123',
          ts: '123.000',
          thread_ts: '123.456',
          repo: 'Roomote/example-app',
        } satisfies CloudTaskPayload<typeof TaskPayloadKind.SlackAppMention>),
      ),
    ).toEqual({
      text: 'latest question',
      visibleInTranscript: true,
    });
  });

  it('strips HTML-escaped Slack thread wrappers from the visible prompt text', () => {
    expect(
      getCloudJobVisiblePrompt(
        buildCloudJob({
          text: '&lt;thread_context&gt;\n&lt;slack_thread_message ts="109.000"&gt;Alice Example: Earlier detail&lt;/slack_thread_message&gt;\n&lt;/thread_context&gt;\n\n&lt;replying_to ts="110.000"&gt;\nRoomote Bot: Previous reply\n&lt;/replying_to&gt;\n\n&lt;slack_message ts="111.000"&gt;\nlatest question\n&lt;/slack_message&gt;',
          channel: 'C123',
          user: 'U123',
          ts: '123.000',
          thread_ts: '123.456',
          repo: 'Roomote/example-app',
        } satisfies CloudTaskPayload<typeof TaskPayloadKind.SlackAppMention>),
      ),
    ).toEqual({
      text: 'latest question',
      visibleInTranscript: true,
    });
  });

  it('returns an image-only prompt when the launch payload has images but no text', () => {
    expect(
      getCloudJobVisiblePrompt(
        buildCloudJob({
          repo: 'Roomote/example-app',
          images: ['data:image/png;base64,abc123'],
        } satisfies CloudTaskPayload<typeof TaskPayloadKind.StandardTask>),
      ),
    ).toEqual({
      images: ['data:image/png;base64,abc123'],
      visibleInTranscript: true,
    });
  });

  it('shows the explicit wake-up prompt for snapshot resumes before the worker echoes it', () => {
    expect(
      getCloudJobVisiblePrompt(
        buildCloudJob({
          repo: 'Roomote/example-app',
          sourceSnapshotId: 'snapshot-123',
          sourceCloudJobId: 42,
          text: 'Original launch prompt',
          images: ['data:image/png;base64,old'],
          visibleInTranscript: false,
          resumePrompt: 'Wake up and continue',
          resumePromptImages: ['data:image/png;base64,new'],
        } satisfies CloudTaskPayload<typeof TaskPayloadKind.SnapshotResume>),
      ),
    ).toEqual({
      text: 'Wake up and continue',
      images: ['data:image/png;base64,new'],
      visibleInTranscript: true,
    });
  });

  it('does not keep inherited source images for text-only snapshot wake-ups', () => {
    expect(
      getCloudJobVisiblePrompt(
        buildCloudJob({
          repo: 'Roomote/example-app',
          sourceSnapshotId: 'snapshot-123',
          sourceCloudJobId: 42,
          text: 'Original launch prompt',
          images: ['data:image/png;base64,old'],
          visibleInTranscript: false,
          resumePrompt: 'Wake up and continue',
        } satisfies CloudTaskPayload<typeof TaskPayloadKind.SnapshotResume>),
      ),
    ).toEqual({
      text: 'Wake up and continue',
      visibleInTranscript: true,
    });
  });

  it('returns null when the launch payload has neither text nor images', () => {
    expect(
      getCloudJobVisiblePrompt(
        buildCloudJob({
          repo: 'Roomote/example-app',
        } satisfies CloudTaskPayload<typeof TaskPayloadKind.StandardTask>),
      ),
    ).toBeNull();
  });
});
