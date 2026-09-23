import { and, db, eq, slackUserMappings } from '@roomote/db/server';
import { parseIntegrationToolApprovalCallback } from '@roomote/types';
import {
  postSlackInteractiveResponse,
  type SlackInteractivePayload,
} from '@roomote/slack';

import { decideCommunicationToolApproval } from '../../tool-approval-action.js';

export async function handleSlackToolApprovalAction(
  payload: SlackInteractivePayload,
) {
  const action = payload.actions[0];
  const decision = parseIntegrationToolApprovalCallback(
    action?.type === 'button' ? (action.value ?? undefined) : undefined,
  );
  const mapping = await db.query.slackUserMappings.findFirst({
    where: and(
      eq(slackUserMappings.slackUserId, payload.user.id),
      eq(slackUserMappings.slackTeamId, payload.team.id),
    ),
  });
  const accepted = decision
    ? await decideCommunicationToolApproval(mapping?.userId ?? null, decision)
    : false;
  if (!accepted) {
    await postSlackInteractiveResponse(payload.response_url, {
      response_type: 'ephemeral',
      replace_original: false,
      text: 'This approval is unavailable or has already been handled.',
    });
    return;
  }
  // A web or other provider may have answered first. The conditional DB
  // update above is the authority; this edit only retires this message's UI.
  const text = `Tool call ${decision!.decision === 'rejected' ? 'denied' : 'allowed'}.`;
  await postSlackInteractiveResponse(payload.response_url, {
    replace_original: true,
    text,
    blocks: [{ type: 'markdown', text }],
  });
}
