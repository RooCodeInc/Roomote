import { resolveEffectiveDeploymentEnvVars } from '@roomote/db/server';

/**
 * The operator's private chat with the bot is the destination for proactive
 * messages (onboarding kickoff, starter suggestions). The webhook handler in
 * apps/api captures the first private chat that reaches it under this env
 * var; the value can be corrected later from settings.
 */
export const TELEGRAM_PRIMARY_CHAT_ENV_VAR_NAME = 'TELEGRAM_PRIMARY_CHAT_ID';

export async function findTelegramPrimaryChatId(): Promise<string | null> {
  const deploymentEnvVars = await resolveEffectiveDeploymentEnvVars();
  const chatId =
    process.env[TELEGRAM_PRIMARY_CHAT_ENV_VAR_NAME]?.trim() ||
    deploymentEnvVars[TELEGRAM_PRIMARY_CHAT_ENV_VAR_NAME]?.trim() ||
    '';

  return chatId || null;
}
