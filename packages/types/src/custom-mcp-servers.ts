import { z } from 'zod';

import { MCP_INTEGRATIONS } from './mcp-oauth';
import { PRODUCT_NAME } from './constants';
import { collectReservedEnvReferences } from './reserved-mcp-env-vars';

/**
 * Deployment-scoped custom MCP servers.
 *
 * Unlike environment-scoped `mcpServers` (see environment-config.ts), these
 * are managed by deployment admins in Settings and apply to every task. Remote
 * servers are never handed to sandboxes directly: they are delivered as
 * authenticated proxy URLs (`/api/mcp/custom/<serverId>`) and the API proxy
 * injects the real credentials per request, so header values and OAuth tokens
 * never enter sandbox-readable config.
 */

/**
 * Lowercase slug, starts alphanumeric, up to 64 chars. The name becomes the
 * MCP server key in the harness config, so keep it shell- and config-safe.
 */
export const CUSTOM_MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Names that collide with servers Roomote itself wires into tasks. A custom
 * server with one of these names would either be silently skipped by the
 * worker's collision guard or, worse, be rewritten by the integration proxy
 * path (setup-mcps.ts treats known integration ids specially), so reject them
 * at save time. `github` and `slack` are not MCP_INTEGRATIONS ids but are
 * reserved by the self-setup catalog and service detection.
 */
export const RESERVED_CUSTOM_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([
  'roomote',
  'github',
  'slack',
  ...MCP_INTEGRATIONS.map((integration) => integration.id.toLowerCase()),
]);

/** The mcpConnections.mcpId namespace for custom-server OAuth connections. */
export const CUSTOM_MCP_CONNECTION_PREFIX = 'custom:';

export function customMcpConnectionId(serverId: string): string {
  return `${CUSTOM_MCP_CONNECTION_PREFIX}${serverId}`;
}

export function isCustomMcpConnectionId(mcpId: string): boolean {
  return mcpId.startsWith(CUSTOM_MCP_CONNECTION_PREFIX);
}

export const MAX_CUSTOM_MCP_SERVERS = 25;
export const MAX_CUSTOM_MCP_HEADERS = 16;
export const MAX_CUSTOM_MCP_HEADER_VALUE_LENGTH = 4096;
export const MAX_CUSTOM_MCP_URL_LENGTH = 2048;

/**
 * Header names the proxy owns. Operator headers are applied after the proxy's
 * allowlist rebuild, so without this check a custom header could silently
 * override the injected auth or session headers, and a `Host` override could
 * reach internal vhosts behind shared ingress even when IP-level egress
 * checks pass.
 */
const DENIED_CUSTOM_MCP_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'host',
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'connection',
  'cookie',
  'transfer-encoding',
  'mcp-session-id',
  'mcp-protocol-version',
  'x-mcp-client',
]);

/** RFC 7230 token chars; also excludes anything undici would reject. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** No CR/LF or other control chars: undici throws at request time otherwise. */
// eslint-disable-next-line no-control-regex
const HEADER_VALUE_ILLEGAL_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export function validateCustomMcpHeaderName(name: string): string | null {
  if (!HEADER_NAME_PATTERN.test(name)) {
    return `Header name '${name}' contains invalid characters.`;
  }

  if (DENIED_CUSTOM_MCP_HEADER_NAMES.has(name.toLowerCase())) {
    return (
      `Header '${name}' is managed by ${PRODUCT_NAME} and cannot be ` +
      `overridden on a custom MCP server.`
    );
  }

  return null;
}

export function validateCustomMcpServerUrl(value: string): string | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return 'Server URL must be an absolute HTTP(S) URL.';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Server URL must use http:// or https://.';
  }

  if (url.username || url.password) {
    return 'Server URL must not contain credentials.';
  }

  return null;
}

/**
 * Local (stdio) custom server config. Mirrors the environment-scoped stdio
 * shape: the command runs inside the task sandbox with the same privileges as
 * the agent, so its env values are sandbox-visible by construction (there is
 * no proxy in a stdio pipe).
 */
export const customMcpServerStdioConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type CustomMcpServerStdioConfig = z.infer<
  typeof customMcpServerStdioConfigSchema
>;

export const customMcpServerAuthTypeSchema = z.enum([
  'none',
  'static_headers',
  'oauth',
]);

export type CustomMcpServerAuthType = z.infer<
  typeof customMcpServerAuthTypeSchema
>;

export const customMcpServerNameSchema = z
  .string()
  .regex(
    CUSTOM_MCP_SERVER_NAME_PATTERN,
    'Server name must be a lowercase slug (letters, digits, "-", "_"), at most 64 characters.',
  )
  .refine(
    (name) => !RESERVED_CUSTOM_MCP_SERVER_NAMES.has(name),
    (name) => ({
      message: `'${name}' is reserved by a built-in ${PRODUCT_NAME} integration.`,
    }),
  );

export const customMcpServerHeadersSchema = z
  .record(z.string(), z.string().max(MAX_CUSTOM_MCP_HEADER_VALUE_LENGTH))
  .superRefine((headers, ctx) => {
    const entries = Object.entries(headers);

    if (entries.length > MAX_CUSTOM_MCP_HEADERS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${MAX_CUSTOM_MCP_HEADERS} headers are allowed.`,
      });
      return;
    }

    for (const [name, value] of entries) {
      const nameError = validateCustomMcpHeaderName(name);

      if (nameError) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: nameError,
        });
      }

      if (HEADER_VALUE_ILLEGAL_PATTERN.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `Header '${name}' contains control characters.`,
        });
      }
    }
  });

/**
 * Rejects reserved runtime env references across every operator-supplied
 * string, mirroring environmentMcpServersSchema. Even though remote custom
 * servers are proxy-routed (credentials resolve control-plane-side), the
 * server name flows into sandbox config text, and stdio configs (phase 3)
 * flow entirely into it — keep one uniform rule for all fields.
 */
export function collectCustomMcpReservedReferences(
  strings: string[],
): string[] {
  return Array.from(new Set(strings.flatMap(collectReservedEnvReferences)));
}

export const customMcpServerInputSchema = z
  .object({
    name: customMcpServerNameSchema,
    url: z.string().min(1).max(MAX_CUSTOM_MCP_URL_LENGTH),
    authType: customMcpServerAuthTypeSchema,
    headers: customMcpServerHeadersSchema.optional(),
  })
  .superRefine((server, ctx) => {
    const urlError = validateCustomMcpServerUrl(server.url);

    if (urlError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: urlError,
      });
    }

    if (server.authType !== 'static_headers' && server.headers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headers'],
        message: 'Headers are only allowed with header authentication.',
      });
    }

    const reserved = collectCustomMcpReservedReferences([
      server.name,
      server.url,
      ...Object.entries(server.headers ?? {}).flat(),
    ]);

    if (reserved.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Custom MCP server '${server.name}' references reserved ` +
          `${PRODUCT_NAME} runtime environment variables ` +
          `(${reserved.join(', ')}). Define your own deployment environment ` +
          `variable under a different name and reference that instead.`,
      });
    }
  });

export type CustomMcpServerInput = z.infer<typeof customMcpServerInputSchema>;
