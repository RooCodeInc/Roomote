export const MCP_OAUTH_ERROR_REASONS = [
  'access_denied',
  'provider_error',
  'missing_params',
  'invalid_state',
  'not_found',
  'not_registered',
  'provider_metadata_failed',
  'token_exchange_failed',
  'token_storage_failed',
  'linear_metadata_failed',
  'deployment_enablement_failed',
  'callback_failed',
] as const;

export type McpOAuthErrorReason = (typeof MCP_OAUTH_ERROR_REASONS)[number];

export type McpOAuthResult =
  | { status: 'connected' }
  | { status: 'error'; reason: McpOAuthErrorReason | null };

export function parseMcpOAuthResult(
  status: string | null,
  reason: string | null,
): McpOAuthResult | null {
  if (status === 'connected') {
    return { status };
  }

  if (status !== 'error') {
    return null;
  }

  return {
    status,
    reason: MCP_OAUTH_ERROR_REASONS.includes(reason as McpOAuthErrorReason)
      ? (reason as McpOAuthErrorReason)
      : null,
  };
}

export function getMcpOAuthResultMessage(
  result: McpOAuthResult,
  serviceName: string | null,
): string {
  const subject = serviceName ?? 'The integration';
  if (result.status === 'connected') {
    return `${subject} connected successfully.`;
  }

  const object = serviceName ?? 'the integration';
  const label = serviceName ?? 'integration';
  const authorization = serviceName
    ? `${serviceName} authorization`
    : 'the integration authorization';
  const provider = serviceName ? `${serviceName}'s` : "the integration's";

  switch (result.reason) {
    case 'access_denied':
      return `${subject} authorization was canceled. No changes were saved.`;
    case 'invalid_state':
      return `This ${label} authorization attempt expired or was already used. Start the connection again.`;
    case 'missing_params':
      return `${subject} did not return the information Roomote needed. Try connecting again.`;
    case 'not_found':
      return `Roomote could not find this ${label} connection. Start the connection again.`;
    case 'not_registered':
      return `Roomote could not resume ${authorization}. Try connecting again.`;
    case 'provider_metadata_failed':
      return `Roomote could not reach ${provider} authorization service. Try again.`;
    case 'token_exchange_failed':
    case 'token_storage_failed':
      return `${subject} approved access, but Roomote could not complete the connection. Try again.`;
    case 'linear_metadata_failed':
      return 'Roomote connected to Linear but could not verify the workspace. Try again.';
    case 'deployment_enablement_failed':
      return `${subject} connected, but Roomote could not enable it for this workspace. Try again.`;
    case 'provider_error':
      return `${subject} could not authorize Roomote. Try connecting again.`;
    default:
      return `Roomote could not complete the ${object} connection. Try again.`;
  }
}
