import type { SlackInteractivePayload } from '@roomote/slack';
import { buildIntegrationToolApprovalCallback } from '@roomote/types';

const mocks = vi.hoisted(() => ({
  findMapping: vi.fn(),
  decide: vi.fn(),
  respond: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { slackUserMappings: { findFirst: mocks.findMapping } } },
  and: vi.fn(),
  eq: vi.fn(),
  slackUserMappings: { slackUserId: 'user', slackTeamId: 'team' },
}));
vi.mock('@roomote/slack', () => ({
  postSlackInteractiveResponse: mocks.respond,
}));
vi.mock('../../../tool-approval-action.js', () => ({
  decideCommunicationToolApproval: mocks.decide,
}));

import { handleSlackToolApprovalAction } from '../tool-approval-action.js';

const payload = {
  user: { id: 'U1' },
  team: { id: 'T1' },
  response_url: 'https://response.test',
  actions: [
    {
      type: 'button',
      value: buildIntegrationToolApprovalCallback(
        '3f0c8f0e-1111-4222-8333-444455556666',
        'approved',
      ),
    },
  ],
} as SlackInteractivePayload;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMapping.mockResolvedValue({ userId: 'owner-1' });
});

it('resolves the linked requester and retires the original approval buttons', async () => {
  mocks.decide.mockResolvedValue(true);
  await handleSlackToolApprovalAction(payload);
  expect(mocks.decide).toHaveBeenCalledWith('owner-1', {
    approvalId: '3f0c8f0e-1111-4222-8333-444455556666',
    decision: 'approved',
  });
  expect(mocks.respond).toHaveBeenCalledWith(
    payload.response_url,
    expect.objectContaining({
      replace_original: true,
      blocks: [{ type: 'markdown', text: 'Tool call allowed.' }],
    }),
  );
});

it('does not retire another person’s or already handled approval', async () => {
  mocks.findMapping.mockResolvedValue(null);
  mocks.decide.mockResolvedValue(false);
  await handleSlackToolApprovalAction(payload);
  expect(mocks.decide).toHaveBeenCalledWith(null, expect.any(Object));
  expect(mocks.respond).toHaveBeenCalledWith(
    payload.response_url,
    expect.objectContaining({
      response_type: 'ephemeral',
      replace_original: false,
    }),
  );
});
