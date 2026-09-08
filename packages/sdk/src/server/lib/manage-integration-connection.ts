import { lookup } from 'node:dns/promises';
import { and, customMcpServers, db, eq, sql } from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  MCP_INTEGRATIONS,
  customMcpConnectionId,
  customMcpRemoteServerInputSchema,
  sanitizeCustomMcpServerName,
  type ManageIntegrationConnectionInput,
} from '@roomote/types';
import { prepareIntegrationConnection } from './prepare-integration-connection';
import { assertEgressUrlAllowed } from './safe-fetch';
import {
  assertCustomMcpEnabled,
  connectCustomMcpServerCommand,
  createCustomMcpServerCommand,
  listCustomMcpServerToolsCommand,
  setCustomMcpServerPermissionsCommand,
  updateCustomMcpServerCommand,
} from './custom-mcp-servers';

type Auth = { userId: string; isAdmin: boolean };
type Server = typeof customMcpServers.$inferSelect;

function safeServer(server: Server) {
  return {
    integrationId: customMcpConnectionId(server.id),
    name: server.name,
    kind: 'custom' as const,
    authType: server.authType,
    enabled: server.enabled,
    disabledTools: server.disabledTools ?? [],
  };
}

async function validateTarget(value: string) {
  const url = assertEgressUrlAllowed(
    value,
    Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS,
  );
  if (url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw new Error('Invalid endpoint.');
  }
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), {
    all: true,
  });
  if (!addresses.length) throw new Error('Invalid endpoint.');
  for (const { address, family } of addresses) {
    assertEgressUrlAllowed(
      `https://${family === 6 ? `[${address}]` : address}`,
      Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS,
    );
  }
  return url.toString();
}

/** Credential-free management; authentication remains in the human Settings flow. */
export async function manageIntegrationConnection(
  auth: Auth,
  input: ManageIntegrationConnectionInput,
) {
  if (!auth.isAdmin) throw new Error('Unauthorized');
  try {
    if (input.action === 'list') {
      const servers = await db.query.customMcpServers.findMany();
      return {
        state: 'saved' as const,
        integrations: [
          ...MCP_INTEGRATIONS.map(({ id, name }) => ({
            integrationId: id,
            name,
            kind: 'native' as const,
          })),
          ...servers.map(safeServer),
        ],
      };
    }

    const identifier = input.integrationId ?? input.name;
    if (!identifier)
      return {
        state: 'failed' as const,
        message: 'An integration ID or name is required.',
      };
    // Resolve the native catalog before custom names, including aliases handled by preparation.
    const native =
      MCP_INTEGRATIONS.find(({ id, name }) =>
        [id.toLowerCase(), name.toLowerCase()].includes(
          identifier.toLowerCase(),
        ),
      ) ??
      (identifier.toLowerCase() === 'twitter'
        ? MCP_INTEGRATIONS.find(({ id }) => id === 'x')
        : undefined);
    const preparation = native
      ? prepareIntegrationConnection({ provider: native.id })
      : null;
    if (preparation?.setupKind === 'native') {
      if (
        input.action === 'inspect' ||
        input.action === 'request_auth' ||
        input.action === 'configure'
      ) {
        return {
          state: 'auth_pending' as const,
          integrationId: preparation.integrationId,
          setupUrl: preparation.setupUrl,
          message:
            'Review and configure this native integration in Settings. No connection changes were made.',
        };
      }
      return {
        state: 'failed' as const,
        integrationId: preparation.integrationId,
        setupUrl: preparation.setupUrl,
        message:
          'This operation is not supported for native integrations by this service. Use Settings and tool discovery.',
      };
    }

    assertCustomMcpEnabled();
    const name = input.name
      ? sanitizeCustomMcpServerName(input.name)
      : undefined;
    if (name === null) throw new Error('Invalid custom integration name.');
    const customIdentifier = input.integrationId ?? name ?? identifier;
    const server = await db.query.customMcpServers.findFirst({
      where: customIdentifier.startsWith('custom:')
        ? eq(customMcpServers.id, customIdentifier.slice(7))
        : eq(customMcpServers.name, customIdentifier),
      // PostgreSQL defaults carry microseconds; Date would truncate the CAS version.
      extras: {
        version: sql<string>`${customMcpServers.updatedAt}::text`.as('version'),
      },
    });

    if (input.action === 'configure') {
      if (input.enabled === true)
        return {
          state: 'failed' as const,
          message:
            'Use permissions with an explicit disabledTools list to activate.',
        };
      if (server?.stdio)
        return {
          state: 'failed' as const,
          message: 'Only remote MCP connections are supported.',
        };
      if (server && name && name !== server.name)
        return {
          state: 'failed' as const,
          message: 'Custom integration names cannot be changed.',
        };
      if (!server && identifier.startsWith('custom:'))
        return {
          state: 'failed' as const,
          message: 'Custom integration not found.',
        };
      const url = await validateTarget(input.url ?? server?.url ?? '');
      const configuration = customMcpRemoteServerInputSchema.parse({
        transport: 'remote',
        name: server?.name ?? name ?? identifier,
        url,
        authType: input.authType ?? server?.authType ?? 'none',
        ...(server?.authType === 'static_headers' &&
        (input.authType ?? server.authType) === 'static_headers'
          ? {
              headers: Object.fromEntries(
                Object.keys(server.headers ?? {}).map((name) => [name, '']),
              ),
            }
          : {}),
        ...(server?.authType === 'oauth' &&
        (input.authType ?? server.authType) === 'oauth'
          ? {
              manualClientId: server.manualClientId ?? undefined,
              oauthResourceIndicatorDisabled:
                server.oauthResourceIndicatorDisabled,
            }
          : {}),
      });
      const id = server
        ? server.id
        : (
            await createCustomMcpServerCommand(auth, configuration, {
              enabled: false,
            })
          ).id;
      if (server)
        await updateCustomMcpServerCommand(
          auth,
          { id, server: configuration },
          { prepareOnly: true, expectedUpdatedAt: server.version },
        );
      return {
        state: 'saved' as const,
        integrationId: customMcpConnectionId(id),
        enabled: false,
        setupUrl: `/settings/integrations?configure=${encodeURIComponent(customMcpConnectionId(id))}`,
        message:
          'Saved disabled. Complete authentication and explicitly review permissions before activation.',
      };
    }
    if (!server)
      return {
        state: 'failed' as const,
        message: 'Custom integration not found.',
      };
    const summary = safeServer(server);
    if (input.action === 'inspect')
      return { state: 'saved' as const, ...summary };
    if (server.stdio || !server.url)
      return {
        state: 'failed' as const,
        message: 'Only remote MCP connections are supported.',
      };

    if (input.action === 'request_auth') {
      if (server.authType === 'none')
        return {
          state: 'saved' as const,
          ...summary,
          message:
            'No authentication is required. Test and review permissions before activation.',
        };
      const [disabled] = await db
        .update(customMcpServers)
        .set({
          enabled: false,
          updatedAt: new Date(
            Math.max(Date.now(), server.updatedAt.getTime() + 1),
          ),
        })
        .where(
          and(
            eq(customMcpServers.id, server.id),
            sql`${customMcpServers.updatedAt} = ${server.version}::timestamp`,
          ),
        )
        .returning();
      if (!disabled)
        return {
          state: 'failed' as const,
          message: 'Configuration changed; inspect and retry.',
        };
      const initiateUrl =
        server.authType === 'oauth'
          ? await connectCustomMcpServerCommand(auth, { id: server.id })
          : `/settings/integrations?configure=${encodeURIComponent(summary.integrationId)}`;
      return {
        state: 'auth_pending' as const,
        ...safeServer(disabled),
        initiateUrl,
      };
    }

    if (input.action === 'permissions') {
      if (input.disabledTools === undefined)
        return {
          state: 'failed' as const,
          message:
            'permissions requires an explicit disabledTools list, including [] to allow all tools.',
        };
      const updated = await setCustomMcpServerPermissionsCommand(
        auth,
        {
          id: server.id,
          disabledTools: input.disabledTools,
          enabled: input.enabled === true,
        },
        server.version,
      );
      return {
        state:
          input.enabled === true ? ('verified' as const) : ('saved' as const),
        ...safeServer(updated),
      };
    }

    if (input.action === 'test') {
      await validateTarget(server.url);
      const { tools } = await listCustomMcpServerToolsCommand(
        auth,
        { id: server.id },
        server,
      );
      const current = await db.query.customMcpServers.findFirst({
        where: and(
          eq(customMcpServers.id, server.id),
          sql`${customMcpServers.updatedAt} = ${server.version}::timestamp`,
        ),
      });
      if (!current)
        return {
          state: 'failed' as const,
          message: 'Configuration changed; inspect and retry.',
        };
      return {
        state: 'verified' as const,
        ...summary,
        tools: tools
          .filter(
            (tool) =>
              tool.enabled && /^[a-zA-Z0-9_.:-]{1,128}$/.test(tool.name),
          )
          .map(({ name }) => name),
      };
    }
    return { state: 'failed' as const, message: 'Unsupported action.' };
  } catch {
    // Database, DNS, OAuth and upstream errors can contain endpoints or credentials.
    return {
      state: 'failed' as const,
      message:
        'Connection operation failed. Review configuration and authentication in Settings, then retry.',
    };
  }
}
