import {
  COMMUNICATION_LINK_CODE_TTL_SECONDS,
  consumeCommunicationLinkCode,
  createCommunicationLinkCode,
  isCommunicationLinkCode,
  restoreCommunicationLinkCode,
} from './communication-link-codes';

export const TELEGRAM_LINK_CODE_TTL_SECONDS =
  COMMUNICATION_LINK_CODE_TTL_SECONDS;

export function isTelegramLinkCode(value: string): boolean {
  return isCommunicationLinkCode(value);
}

export async function createTelegramLinkCode(userId: string): Promise<{
  code: string;
  expiresInSeconds: number;
}> {
  return createCommunicationLinkCode('telegram', userId);
}

/**
 * Puts a consumed code back (with a fresh TTL) when linking fails after the
 * one-shot GETDEL, so a transient error does not burn the code.
 */
export async function restoreTelegramLinkCode(
  code: string,
  userId: string,
): Promise<void> {
  await restoreCommunicationLinkCode('telegram', code, userId);
}

/** One-shot: a code is deleted the moment it resolves. */
export async function consumeTelegramLinkCode(
  code: string,
): Promise<string | null> {
  return consumeCommunicationLinkCode('telegram', code);
}
