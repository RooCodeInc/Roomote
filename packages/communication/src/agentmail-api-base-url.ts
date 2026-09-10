const DEFAULT_AGENTMAIL_API_BASE_URL = 'https://api.agentmail.to';

/**
 * Resolves the AgentMail API host, mirroring `getTelegramApiBaseUrl`:
 * `AGENTMAIL_API_BASE_URL` lets tests and a mock AgentMail harness reroute
 * every outbound API call without touching call sites.
 */
export function getAgentMailApiBaseUrl(): string {
  const configuredUrl = (
    process.env.AGENTMAIL_API_BASE_URL ?? DEFAULT_AGENTMAIL_API_BASE_URL
  ).trim();

  return configuredUrl.replace(/\/+$/, '');
}
