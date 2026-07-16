import {
  COMMUNICATION_LINK_CODE_TTL_SECONDS,
  consumeCommunicationLinkCode,
  createCommunicationLinkCode,
  isCommunicationLinkCode,
  restoreCommunicationLinkCode,
} from './communication-link-codes';

export const DISCORD_LINK_CODE_TTL_SECONDS =
  COMMUNICATION_LINK_CODE_TTL_SECONDS;

export function isDiscordLinkCode(value: string): boolean {
  return isCommunicationLinkCode(value);
}

export async function createDiscordLinkCode(userId: string): Promise<{
  code: string;
  expiresInSeconds: number;
}> {
  return createCommunicationLinkCode('discord', userId);
}

export async function restoreDiscordLinkCode(
  code: string,
  userId: string,
): Promise<void> {
  await restoreCommunicationLinkCode('discord', code, userId);
}

export async function consumeDiscordLinkCode(
  code: string,
): Promise<string | null> {
  return consumeCommunicationLinkCode('discord', code);
}
