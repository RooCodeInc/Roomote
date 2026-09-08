import { z } from 'zod';

import { MCP_INTEGRATIONS } from './mcp-oauth';

export const prepareIntegrationConnectionInputSchema = z
  .object({
    provider: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(
        /^[\p{L}\p{N}][\p{L}\p{N} .&'()+-]*$/u,
        'Enter only a provider name, not a URL or credentials.',
      )
      .describe(
        'Nonsecret provider name only. Never supply credentials, tokens, headers, or a remote URL.',
      ),
  })
  .strict();

export type PrepareIntegrationConnectionInput = z.infer<
  typeof prepareIntegrationConnectionInputSchema
>;

export const PREPARE_INTEGRATION_CONNECTION_TOOL = {
  name: 'prepare_integration_connection',
  title: 'Prepare Integration Connection',
  description:
    'Prepare a secure Settings setup link for a provider name. Read-only: does not connect, authorize, validate, or save anything. Credentials and remote MCP URLs must be entered only by an authorized human in the secure UI with their consent. After setup, use find_integration_tools discovery; never claim connected until tool discovery succeeds. API-only services without a compatible remote MCP server are unsupported by custom setup.',
  inputSchema: prepareIntegrationConnectionInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export function buildIntegrationConnectionPreparation(
  input: PrepareIntegrationConnectionInput,
  appUrl: string,
) {
  const { provider } = prepareIntegrationConnectionInputSchema.parse(input);
  const normalized = provider.toLowerCase();
  const integration =
    MCP_INTEGRATIONS.find(
      (entry) =>
        entry.id.toLowerCase() === normalized ||
        entry.name.toLowerCase() === normalized,
    ) ??
    (normalized === 'twitter'
      ? MCP_INTEGRATIONS.find((entry) => entry.id === 'x')
      : undefined);
  const url = new URL('/settings/integrations', appUrl);
  if (integration) {
    url.searchParams.set('highlight', integration.id);
  } else {
    url.searchParams.set('connect', 'custom');
    url.searchParams.set('name', provider);
  }
  return {
    status: 'setup_required' as const,
    validated: false as const,
    provider: integration?.name ?? provider,
    integrationId: integration?.id ?? null,
    setupKind: integration ? ('native' as const) : ('custom' as const),
    setupUrl: url.toString(),
    guidance: [
      'This only prepares a setup link; current connection status has not been checked. An authorized human must review and consent in Settings. Settings enforces authorization at submission. Enter credentials only in the secure UI, never in chat or tool arguments.',
      ...(integration
        ? []
        : [
            'In the secure UI, enter a compatible remote MCP server URL from the provider. Never invent an endpoint. An API-only service without a compatible remote MCP server is unsupported.',
          ]),
      'After setup, use existing find_integration_tools discovery to verify available tools. Never claim connected until discovery succeeds. If the current task catalog is stale, start a new task/session to refresh it and retry discovery.',
    ].join(' '),
  };
}
