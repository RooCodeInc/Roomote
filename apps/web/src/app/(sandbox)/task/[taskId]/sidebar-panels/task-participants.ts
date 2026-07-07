import type { AcpUiMessage } from '../messages/acp/types';

type TaskCreator = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
} | null;

interface TaskParticipant {
  key: string;
  userId: string | null;
  name: string | null;
  email: string | null;
  imageUrl: string | null;
}

function getIdentityKey(
  msg: Pick<AcpUiMessage, 'userId' | 'userEmail' | 'userName'>,
): string | null {
  return msg.userId ?? msg.userEmail ?? msg.userName ?? null;
}

function isCreatorParticipant(
  msg: Pick<AcpUiMessage, 'userId' | 'userEmail' | 'userName'>,
  creator: TaskCreator,
): boolean {
  if (!creator) {
    return false;
  }

  return (
    (Boolean(creator.id) && msg.userId === creator.id) ||
    (Boolean(creator.email) && msg.userEmail === creator.email) ||
    (Boolean(creator.name) &&
      !msg.userId &&
      !msg.userEmail &&
      msg.userName === creator.name)
  );
}

export function getTaskParticipants(
  messages: readonly AcpUiMessage[],
  creator: TaskCreator,
): TaskParticipant[] {
  const participants: TaskParticipant[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }

    if (isCreatorParticipant(message, creator)) {
      continue;
    }

    const key = getIdentityKey(message);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    participants.push({
      key,
      userId: message.userId ?? null,
      name: message.userName ?? null,
      email: message.userEmail ?? null,
      imageUrl: message.userImageUrl ?? null,
    });
  }

  return participants;
}
