import { getDeploymentAccountLinkHelpText } from '@roomote/db/server';

import { apiLogger } from '../logging.js';

export async function appendAccountLinkHelpText(
  baseMessage: string,
): Promise<string> {
  try {
    const helpText = await getDeploymentAccountLinkHelpText();
    return helpText ? `${baseMessage} ${helpText}` : baseMessage;
  } catch (error) {
    apiLogger.warn(
      `[account-link] Failed to load deployment help text: ${error instanceof Error ? error.message : String(error)}`,
    );
    return baseMessage;
  }
}
