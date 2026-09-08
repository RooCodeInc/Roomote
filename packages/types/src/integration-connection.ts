import { z } from 'zod';

import { MCP_INTEGRATIONS } from './mcp-oauth';

export const manageIntegrationConnectionInputSchema = z
  .object({
    action: z.enum([
      'list',
      'inspect',
      'configure',
      'test',
      'permissions',
      'request_auth',
    ]),
    integrationId: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .optional()
      .describe(
        'Native integration ID or custom:<id> returned by list/configure.',
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Nonsecret native provider or custom server name; configure resolves existing names before creating.',
      ),
    url: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ['https:', 'http:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !/^https?:[\\/]*[^\\/]*@/i.test(value.trim()) &&
            !value.includes('?') &&
            !value.includes('#')
          );
        } catch {
          return false;
        }
      }, 'Invalid endpoint. Use an HTTP(S) URL without credentials, query, or fragment.')
      .optional(),
    authType: z.enum(['none', 'oauth', 'static_headers']).optional(),
    enabled: z
      .boolean()
      .optional()
      .describe(
        'Only permissions can activate with true, after a successful authenticated probe. Configuration stays disabled.',
      ),
    disabledTools: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-zA-Z0-9_.:-]+$/),
      )
      .max(1000)
      .optional()
      .describe(
        'Required for permissions: explicit tool deny list reviewed with the user. [] explicitly allows all tools. Permissions without enabled:true saves disabled.',
      ),
  })
  .strict();

export type ManageIntegrationConnectionInput = z.infer<
  typeof manageIntegrationConnectionInputSchema
>;

export const MANAGE_INTEGRATION_CONNECTION_TOOL = {
  name: 'manage_integration_connection',
  title: 'Manage Integration Connection',
  description:
    'Admin-only credential-free integration management. List, inspect, configure, test, review permissions, or request human authentication. Only remote MCP endpoints are supported. Never supply credentials, secret header values, or stdio configuration. Configuration is saved disabled; request_auth returns the targeted secure credential entry or OAuth initiation link. Activation requires explicit permissions review and a successful probe. Native integrations reuse read-only setup preparation; native test/permissions are unsupported. Results use saved/auth_pending/verified/failed; verified test does not activate. Access tools through existing discovery and proxies. Fast reloads new connections on the next turn (tool lists may be cached); Standard requires a new task for new connections.',
  inputSchema: manageIntegrationConnectionInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
} as const;

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
    'Resolve a provider native-first and prepare its secure setup path. Read-only: does not connect, authorize, validate, or save anything. For custom remote integrations, use manage_integration_connection to configure and test a documented nonsecret endpoint. Credentials and OAuth consent belong only in the secure human UI. Never claim connected before successful testing. Services without compatible remote servers may need separately scoped coding and hosting work.',
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
            'Use manage_integration_connection to configure the compatible remote server with its documented nonsecret URL. Ask for genuinely missing endpoint details; never invent an endpoint or request secrets in chat. Use the secure UI only for human-required authentication. A service without a compatible server may need a separately scoped coding investigation covering hosting, credential isolation, and validation.',
          ]),
      'After setup, use existing find_integration_tools discovery to verify available tools. Never claim connected until discovery succeeds. If the current task catalog is stale, start a new task/session to refresh it and retry discovery.',
    ].join(' '),
  };
}
