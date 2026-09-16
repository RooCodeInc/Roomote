import { and, db, desc, eq, fastAgentMessages, sql } from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  parseAcpRequestUserInputPayload,
  parseFastAgentCapabilityOfferPayload,
} from '@roomote/types';

export type PendingSessionAttention = {
  /** Newest question with no `request_user_input_response` sharing its id. */
  request: { requestId: string } | null;
  /** Newest offer with no `capability_offer_response` sharing its id. */
  offer: { offerId: string; capability: string } | null;
};

type Executor = Pick<typeof db, 'select'>;

/**
 * What is still waiting on the person in a Fast conversation. Lets a push
 * carry the ids the app needs to answer straight from the notification.
 */
export async function findPendingSessionAttention(
  fastConversationId: string,
  executor: Executor = db,
): Promise<PendingSessionAttention> {
  const requestKey = sql`${fastAgentMessages.payload} ->> 'requestId'`;
  const offerKey = sql`${fastAgentMessages.payload} ->> 'offerId'`;
  const rows = await executor
    .select({
      eventType: fastAgentMessages.eventType,
      payload: fastAgentMessages.payload,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, fastConversationId),
        sql`${fastAgentMessages.eventType} in (${ACP_ENVELOPE_EVENT_TYPES.RequestUserInput}, ${ACP_ENVELOPE_EVENT_TYPES.CapabilityOffer})`,
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
    .orderBy(desc(fastAgentMessages.ts), desc(fastAgentMessages.turnSeq))
    .limit(20);

  const pending: PendingSessionAttention = { request: null, offer: null };
  for (const row of rows) {
    if (
      !pending.request &&
      row.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput
    ) {
      const request = parseAcpRequestUserInputPayload(row.payload);
      if (request) pending.request = { requestId: request.requestId };
    } else if (
      !pending.offer &&
      row.eventType === ACP_ENVELOPE_EVENT_TYPES.CapabilityOffer
    ) {
      const offer = parseFastAgentCapabilityOfferPayload(row.payload);
      if (offer) {
        pending.offer = {
          offerId: offer.offerId,
          capability: offer.capability,
        };
      }
    }
    if (pending.request && pending.offer) break;
  }
  return pending;
}
