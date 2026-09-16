import {
  and,
  db,
  desc,
  fastAgentMessages,
  inArray,
  sql,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  parseAcpRequestUserInputPayload,
  parseFastAgentCapabilityOfferPayload,
} from '@roomote/types';

import { jsonOk, withApiV1Auth } from '@/lib/server/api-v1';
import { getSessions } from '@/lib/server/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SESSION_SCAN_LIMIT = 200;

type InboxItem = {
  id: string;
  kind: 'user_input' | 'capability_offer';
  sessionId: string | null;
  fastConversationId: string;
  sessionTitle: string;
  createdAt: string;
  request: { requestId: string; questions: unknown[] } | null;
  offer: { offerId: string; capability: string; message: string } | null;
};

/**
 * Everything waiting on the caller: pending questions and capability offers
 * across the Sessions they can read. A request is pending when no response
 * envelope shares its `requestId` / `offerId`.
 */
export const GET = withApiV1Auth(async ({ auth }) => {
  const { sessions } = await getSessions(auth, {
    status: 'needs_input',
    limit: SESSION_SCAN_LIMIT,
  });
  const byConversation = new Map(
    sessions
      .filter((session) => session.fastConversationId)
      .map((session) => [session.fastConversationId as string, session]),
  );
  const conversationIds = [...byConversation.keys()];
  if (conversationIds.length === 0) {
    return jsonOk({ items: [] satisfies InboxItem[] });
  }

  const requestKey = sql`${fastAgentMessages.payload} ->> 'requestId'`;
  const offerKey = sql`${fastAgentMessages.payload} ->> 'offerId'`;
  const rows = await db
    .select({
      id: fastAgentMessages.id,
      conversationId: fastAgentMessages.conversationId,
      eventType: fastAgentMessages.eventType,
      payload: fastAgentMessages.payload,
      createdAt: fastAgentMessages.createdAt,
    })
    .from(fastAgentMessages)
    .where(
      and(
        inArray(fastAgentMessages.conversationId, conversationIds),
        inArray(fastAgentMessages.eventType, [
          ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
          ACP_ENVELOPE_EVENT_TYPES.CapabilityOffer,
        ]),
        sql`not exists (
          select 1 from ${fastAgentMessages} as responses
          where responses.conversation_id = ${fastAgentMessages.conversationId}
            and (
              (
                ${fastAgentMessages.eventType} = ${ACP_ENVELOPE_EVENT_TYPES.RequestUserInput}
                and responses.event_type = ${ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse}
                and responses.payload ->> 'requestId' = ${requestKey}
              ) or (
                ${fastAgentMessages.eventType} = ${ACP_ENVELOPE_EVENT_TYPES.CapabilityOffer}
                and responses.event_type = ${ACP_ENVELOPE_EVENT_TYPES.CapabilityOfferResponse}
                and responses.payload ->> 'offerId' = ${offerKey}
              )
            )
        )`,
      ),
    )
    .orderBy(desc(fastAgentMessages.createdAt))
    .limit(200);

  const items: InboxItem[] = [];
  for (const row of rows) {
    const session = byConversation.get(row.conversationId);
    if (!session) continue;
    const base = {
      sessionId: session.id,
      fastConversationId: row.conversationId,
      sessionTitle: session.title ?? 'Untitled Session',
      createdAt: row.createdAt.toISOString(),
    };
    if (row.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput) {
      const request = parseAcpRequestUserInputPayload(row.payload);
      if (!request) continue;
      items.push({
        ...base,
        id: `user_input:${request.requestId}`,
        kind: 'user_input',
        request: { requestId: request.requestId, questions: request.questions },
        offer: null,
      });
    } else {
      const offer = parseFastAgentCapabilityOfferPayload(row.payload);
      if (!offer) continue;
      items.push({
        ...base,
        id: `capability_offer:${offer.offerId}`,
        kind: 'capability_offer',
        request: null,
        offer: {
          offerId: offer.offerId,
          capability: offer.capability,
          message: offer.message,
        },
      });
    }
  }

  return jsonOk({ items });
});
