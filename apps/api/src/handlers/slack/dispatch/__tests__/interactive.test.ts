import type { SlackInteractivePayload } from '@roomote/slack';

const {
  handleConnectAccountMock,
  handleFollowupAnswerMock,
  handleManagerMcpSetupConfigureMock,
  handleManagerMcpSetupNoThanksMock,
  handleThreadReplyDetailsToggleMock,
  handleSlackPrReviewActionAutoMock,
  handleSlackPrReviewActionDismissMock,
  handleSlackPrReviewActionYesMock,
  apiLoggerInfoMock,
  apiLoggerWarnMock,
} = vi.hoisted(() => ({
  handleConnectAccountMock: vi.fn(),
  handleFollowupAnswerMock: vi.fn(),
  handleManagerMcpSetupConfigureMock: vi.fn(),
  handleManagerMcpSetupNoThanksMock: vi.fn(),
  handleThreadReplyDetailsToggleMock: vi.fn(),
  handleSlackPrReviewActionAutoMock: vi.fn(),
  handleSlackPrReviewActionDismissMock: vi.fn(),
  handleSlackPrReviewActionYesMock: vi.fn(),
  apiLoggerInfoMock: vi.fn(),
  apiLoggerWarnMock: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  buildSuggestedTasksOnboardingFollowupIgnoreBlocks: vi.fn(() => []),
  buildSuggestedTasksOnboardingFollowupPromptTextBlocks: vi.fn(() => []),
  claimPendingSuggestedTasksOnboardingFollowupPromptWithNonce: vi.fn(),
  getPendingSuggestedTasksOnboardingFollowupPromptWithNonce: vi.fn(),
  handleConnectAccount: handleConnectAccountMock,
  handleFollowupAnswer: handleFollowupAnswerMock,
  handleManagerMcpSetupConfigure: handleManagerMcpSetupConfigureMock,
  handleManagerMcpSetupNoThanks: handleManagerMcpSetupNoThanksMock,
  MANAGER_MCP_SETUP_CONFIGURE_ACTION_ID: 'manager_mcp_setup_configure',
  MANAGER_MCP_SETUP_NO_THANKS_ACTION_ID: 'manager_mcp_setup_no_thanks',
  PR_REVIEW_ACTION_AUTO_ACTION_ID: 'pr_review_action_auto',
  PR_REVIEW_ACTION_DISMISS_ACTION_ID: 'pr_review_action_dismiss',
  PR_REVIEW_ACTION_YES_ACTION_ID: 'pr_review_action_yes',
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_CONFIGURE_ACTION_ID:
    'suggested_tasks_onboarding_followup_configure',
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_IGNORE_ACTION_ID:
    'suggested_tasks_onboarding_followup_ignore',
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TEXT: 'followup text',
  SlackNotifier: class {},
  ROOMOTE_SLACK_REPLY_TOGGLE_ACTION_ID: 'roomote_slack_reply_toggle',
  // Mirrors the real helper: forwards to global fetch with an abort timeout.
  slackFetch: (url: string, init: RequestInit = {}) =>
    fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(5_000),
    }),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  db: { query: { slackInstallations: { findFirst: vi.fn() } } },
  slackInstallations: { teamId: 'teamId', isActive: 'isActive' },
}));

vi.mock('../pr-review-action.js', () => ({
  handleSlackPrReviewActionAuto: handleSlackPrReviewActionAutoMock,
  handleSlackPrReviewActionDismiss: handleSlackPrReviewActionDismissMock,
  handleSlackPrReviewActionYes: handleSlackPrReviewActionYesMock,
}));

vi.mock('../thread-reply-details-toggle.js', () => ({
  handleThreadReplyDetailsToggle: handleThreadReplyDetailsToggleMock,
}));

vi.mock('../../../../logging.js', () => ({
  apiLogger: {
    debug: vi.fn(),
    info: apiLoggerInfoMock,
    warn: apiLoggerWarnMock,
    error: vi.fn(),
  },
}));

import {
  handleSlackInteractivePayload,
  RETIRED_SLACK_ACTION_IDS,
} from '../interactive.js';

const RESPONSE_URL = 'https://hooks.slack.test/response';

const RETIRED_ACTION_IDS = [
  'submit_task',
  'routing_confirm_ok',
  'routing_confirm_no',
  'retry_failed_task',
  'nevermind_task',
  'cancel_task',
  'follow_task',
];

function makePayload(actionId: string): SlackInteractivePayload {
  return {
    type: 'block_actions',
    team: { id: 'T1', domain: 'team' },
    user: { id: 'U1', name: 'dan' },
    channel: { id: 'C123', name: 'general' },
    message: { ts: '333.444', thread_ts: '111.222', blocks: [] },
    actions: [
      {
        type: 'button',
        action_id: actionId,
        text: { text: 'Click' },
        value: 'legacy-value',
      },
    ],
    state: { values: {} },
    response_url: RESPONSE_URL,
    trigger_id: 'trigger-1',
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('handleSlackInteractivePayload', () => {
  it('exports exactly the seven retired action ids', () => {
    expect([...RETIRED_SLACK_ACTION_IDS].sort()).toEqual(
      [...RETIRED_ACTION_IDS].sort(),
    );
  });

  describe.each(RETIRED_ACTION_IDS)('retired action %s', (actionId) => {
    it('posts an ephemeral notice to the response_url exactly once', async () => {
      await handleSlackInteractivePayload(makePayload(actionId));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(RESPONSE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'ephemeral',
          replace_original: false,
          text: 'That button came from an older Roomote message and no longer does anything. Mention Roomote in this thread to continue.',
        }),
        // The request is bounded by slackFetch's abort timeout.
        signal: expect.any(AbortSignal),
      });
      expect(apiLoggerInfoMock).toHaveBeenCalledTimes(1);
      expect(apiLoggerInfoMock).toHaveBeenCalledWith(
        expect.stringContaining(actionId),
      );
      expect(console.error).not.toHaveBeenCalled();
      expect(handleConnectAccountMock).not.toHaveBeenCalled();
      expect(handleFollowupAnswerMock).not.toHaveBeenCalled();
    });
  });

  it('logs a warning and does not throw when the response_url POST fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(
      handleSlackInteractivePayload(makePayload('cancel_task')),
    ).resolves.toBeUndefined();

    expect(apiLoggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('network down'),
    );
  });

  it('logs a warning when Slack rejects the response_url POST', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await handleSlackInteractivePayload(makePayload('follow_task'));

    expect(apiLoggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('404'),
    );
  });

  it('does not call fetch for an unknown action id', async () => {
    await handleSlackInteractivePayload(makePayload('totally_unknown_action'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiLoggerInfoMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('totally_unknown_action'),
    );
  });

  it('still dispatches connect_account to its handler', async () => {
    const payload = makePayload('connect_account');

    await handleSlackInteractivePayload(payload);

    expect(handleConnectAccountMock).toHaveBeenCalledTimes(1);
    expect(handleConnectAccountMock).toHaveBeenCalledWith(payload);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
