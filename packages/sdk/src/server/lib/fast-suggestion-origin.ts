import { db, getSessionForFastConversation } from '@roomote/db/server';

export async function requireFastSuggestionOriginSessionId(
  fastConversationId: string,
): Promise<string> {
  const session = await getSessionForFastConversation(db, fastConversationId);
  if (!session) {
    throw new Error('Fast suggestion origin session was not found.');
  }
  return session.id;
}
