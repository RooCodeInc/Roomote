vi.mock('@roomote/sdk/client', () => ({
  __esModule: true,
  sdk: {
    mcpConnections: {
      getMcpServerConfigs: vi.fn().mockResolvedValue({ servers: {} }),
    },
  },
}));

const { BUILT_IN_MCPS, resolveBuiltInMcpServers } =
  await import('../setup-mcps');

describe('resolveBuiltInMcpServers', () => {
  const originalEnv = { ...process.env };
  const expectedBuiltInMcpNames = ['roomote'];

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = {
      ...originalEnv,
      HOME: '/home/testuser',
      MISE_DATA_DIR: '/opt/mise',
      MISE_CACHE_DIR: '/opt/mise/cache',
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('writes built-in MCPs without integrations', () => {
    const parsed = { mcpServers: resolveBuiltInMcpServers() };

    // Browser automation now ships as the agent-browser CLI in the worker image,
    // so there is no built-in browser MCP entry to assert here.
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(
      expectedBuiltInMcpNames,
    );
  });

  it('exports BUILT_IN_MCPS with the expected servers', () => {
    expect(Object.keys(BUILT_IN_MCPS).sort()).toEqual(expectedBuiltInMcpNames);
  });

  it('merges custom environment MCP servers', () => {
    const parsed = {
      mcpServers: resolveBuiltInMcpServers(undefined, undefined, {
        docs: {
          url: 'https://mcp.example.com/docs',
        },
        internal: {
          command: 'npx',
          args: ['-y', '@acme/internal-mcp'],
          env: { INTERNAL_TOKEN: 'abc123' },
        },
      }),
    };

    expect(parsed.mcpServers).toHaveProperty('docs');
    expect(parsed.mcpServers).toHaveProperty('internal');

    const internalConfig = parsed.mcpServers.internal as {
      type: string;
      env: Record<string, string>;
    };
    expect(internalConfig.type).toBe('stdio');
    expect(internalConfig.env.INTERNAL_TOKEN).toBe('abc123');
    expect(internalConfig.env.MISE_DATA_DIR).toBe('/opt/mise');
    expect(internalConfig.env.MISE_CACHE_DIR).toBe('/opt/mise/cache');
  });

  it('interpolates custom stdio MCP env values from task env', () => {
    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          MCP_API_KEY: 'secret123',
          MCP_REGION: 'us-east-1',
        },
        undefined,
        {
          internal: {
            command: 'npx',
            args: ['-y', '@acme/internal-mcp'],
            env: {
              API_KEY: '${MCP_API_KEY}',
              REGION: '$MCP_REGION',
            },
          },
        },
      ),
    };

    const internalConfig = parsed.mcpServers.internal as {
      type: string;
      env: Record<string, string>;
    };
    expect(internalConfig.type).toBe('stdio');
    expect(internalConfig.env.API_KEY).toBe('secret123');
    expect(internalConfig.env.REGION).toBe('us-east-1');
  });

  it('interpolates custom streamable HTTP MCP headers from task env', () => {
    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          MCP_API_KEY: 'secret123',
          MCP_REGION: 'us-east-1',
        },
        undefined,
        {
          docs: {
            url: 'https://mcp.example.com/docs',
            headers: {
              Authorization: 'Bearer ${MCP_API_KEY}',
              'X-MCP-Region': '$MCP_REGION',
            },
          },
        },
      ),
    };

    const docsConfig = parsed.mcpServers.docs as {
      type: string;
      headers: Record<string, string>;
    };
    expect(docsConfig.type).toBe('streamable-http');
    expect(docsConfig.headers.Authorization).toBe('Bearer secret123');
    expect(docsConfig.headers['X-MCP-Region']).toBe('us-east-1');
  });

  it('leaves unresolved custom streamable HTTP MCP headers intact', () => {
    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          MCP_REGION: 'us-east-1',
        },
        undefined,
        {
          docs: {
            url: 'https://mcp.example.com/docs',
            headers: {
              Authorization: 'Bearer ${MCP_API_KEY}',
              'X-MCP-Region': '$MCP_REGION',
            },
          },
        },
      ),
    };

    const docsConfig = parsed.mcpServers.docs as {
      headers: Record<string, string>;
    };
    expect(docsConfig.headers.Authorization).toBe('Bearer ${MCP_API_KEY}');
    expect(docsConfig.headers['X-MCP-Region']).toBe('us-east-1');
  });

  it('skips custom MCP servers when names conflict with built-ins', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(undefined, undefined, {
        roomote: {
          command: 'echo',
          args: ['custom'],
        },
      }),
    };

    const roomoteConfig = parsed.mcpServers.roomote as {
      type: string;
      command: string;
    };

    expect(roomoteConfig.type).toBe('stdio');
    expect(roomoteConfig.command).toBe('node');
    expect(warnSpy).toHaveBeenCalledWith(
      "[resolveBuiltInMcpServers] Skipping custom MCP 'roomote': name conflicts with an existing MCP server",
    );
  });

  it('adds proxied Linear MCP from shared user MCP servers and preserves the TRPC_URL path prefix', () => {
    process.env.TRPC_URL = 'https://app.test.com/_roomote-api';

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'test-cloud-token',
          ROOMOTE_APP_URL: 'https://api.test.com',
        },
        {
          userMcpServers: {
            linear: {
              url: '/api/mcp/linear',
              headers: {
                'X-MCP-Client': 'Roomote',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).toHaveProperty('roomote');
    expect(parsed.mcpServers).toHaveProperty('linear');

    const linearConfig = parsed.mcpServers.linear as {
      type: string;
      url: string;
      headers: { Authorization: string };
    };
    expect(linearConfig.type).toBe('streamable-http');
    expect(linearConfig.url).toBe(
      'https://app.test.com/_roomote-api/api/mcp/linear',
    );
    expect(linearConfig.headers.Authorization).toBe('Bearer test-cloud-token');
  });

  it('falls back to ROOMOTE_APP_URL for proxied Linear MCP when TRPC_URL is not set', () => {
    delete process.env.TRPC_URL;

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'test-cloud-token',
          ROOMOTE_APP_URL: 'https://api.test.com/',
        },
        {
          userMcpServers: {
            linear: {
              url: '/api/mcp/linear',
              headers: {
                'X-MCP-Client': 'Roomote',
              },
            },
          },
        },
      ),
    };

    const linearConfig = parsed.mcpServers.linear as { url: string };
    expect(linearConfig.url).toBe('https://api.test.com/api/mcp/linear');
  });

  it('does not add Linear MCP when shared MCP configs omit it', () => {
    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'test-cloud-token',
          ROOMOTE_APP_URL: 'https://api.test.com',
        },
        { userMcpServers: {} },
      ),
    };

    expect(parsed.mcpServers).not.toHaveProperty('linear');
  });

  it('does not add Linear MCP when integrations are undefined', () => {
    const parsed = {
      mcpServers: resolveBuiltInMcpServers(undefined, undefined),
    };

    expect(parsed.mcpServers).not.toHaveProperty('linear');
  });

  it('does not add Linear MCP when task env is missing auth inputs', () => {
    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_APP_URL: 'https://api.test.com',
        },
        {
          userMcpServers: {
            linear: {
              url: '/api/mcp/linear',
              headers: {
                'X-MCP-Client': 'Roomote',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).not.toHaveProperty('linear');
  });

  it('rewrites user Notion MCP to the Roomote proxy with job token auth', () => {
    delete process.env.TRPC_URL;

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com/',
        },
        {
          userMcpServers: {
            notion: {
              url: '/api/mcp/notion',
              headers: {
                'X-MCP-Client': 'Roomote',
                Authorization: 'Bearer raw-notion-token',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).toHaveProperty('notion');

    const notionConfig = parsed.mcpServers.notion as {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(notionConfig.type).toBe('streamable-http');
    expect(notionConfig.url).toBe('https://api.test.com/api/mcp/notion');
    expect(notionConfig.headers.Authorization).toBe('Bearer roomote-job-token');
    expect(notionConfig.headers['X-MCP-Client']).toBe('Roomote');
    expect(Object.values(notionConfig.headers)).not.toContain(
      'Bearer raw-notion-token',
    );
  });

  it('adds the preview proxy bypass header for proxied integration MCPs when present in task env', () => {
    delete process.env.TRPC_URL;

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com/',
          ROOMOTE_AUTH_BYPASS_HEADER_NAME: 'x-roomote-bypass',
          ROOMOTE_AUTH_BYPASS_VALUE: 'bypass-token',
        },
        {
          userMcpServers: {
            notion: {
              url: '/api/mcp/notion',
              headers: {
                'X-MCP-Client': 'Roomote',
              },
            },
          },
        },
      ),
    };

    const notionConfig = parsed.mcpServers.notion as {
      headers: Record<string, string>;
    };

    expect(notionConfig.headers.Authorization).toBe('Bearer roomote-job-token');
    expect(notionConfig.headers['x-roomote-bypass']).toBe('bypass-token');
  });

  it('rewrites user Sentry MCP to the Roomote proxy with job token auth', () => {
    delete process.env.TRPC_URL;

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com/',
        },
        {
          userMcpServers: {
            sentry: {
              url: 'https://api.preview.roomote.run/api/mcp/sentry',
              headers: {
                'X-MCP-Client': 'Roomote',
                Authorization: 'Bearer raw-sentry-token',
                authorization: 'Bearer raw-sentry-token-lowercase',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).toHaveProperty('sentry');

    const sentryConfig = parsed.mcpServers.sentry as {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(sentryConfig.type).toBe('streamable-http');
    expect(sentryConfig.url).toBe('https://api.test.com/api/mcp/sentry');
    expect(sentryConfig.headers.Authorization).toBe('Bearer roomote-job-token');
    expect(sentryConfig.headers.authorization).toBeUndefined();
    expect(sentryConfig.headers['X-MCP-Client']).toBe('Roomote');
    expect(Object.values(sentryConfig.headers)).not.toContain(
      'Bearer raw-sentry-token',
    );
    expect(Object.values(sentryConfig.headers)).not.toContain(
      'Bearer raw-sentry-token-lowercase',
    );
  });

  it('rewrites user Snowflake MCP to the Roomote proxy with job token auth', () => {
    delete process.env.TRPC_URL;

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com/',
        },
        {
          userMcpServers: {
            snowflake: {
              url: 'https://api.preview.roomote.run/api/mcp/snowflake',
              headers: {
                'X-MCP-Client': 'Roomote',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).toHaveProperty('snowflake');

    const snowflakeConfig = parsed.mcpServers.snowflake as {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(snowflakeConfig.type).toBe('streamable-http');
    expect(snowflakeConfig.url).toBe('https://api.test.com/api/mcp/snowflake');
    expect(snowflakeConfig.headers.Authorization).toBe(
      'Bearer roomote-job-token',
    );
    expect(snowflakeConfig.headers['X-MCP-Client']).toBe('Roomote');
  });

  it('adds the preview proxy bypass header for proxied Snowflake MCPs when present in task env', () => {
    delete process.env.TRPC_URL;

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com/',
          ROOMOTE_AUTH_BYPASS_HEADER_NAME: 'x-roomote-bypass',
          ROOMOTE_AUTH_BYPASS_VALUE: 'bypass-token',
        },
        {
          userMcpServers: {
            snowflake: {
              url: 'https://api.preview.roomote.run/api/mcp/snowflake',
              headers: {
                'X-MCP-Client': 'Roomote',
              },
            },
          },
        },
      ),
    };

    const snowflakeConfig = parsed.mcpServers.snowflake as {
      headers: Record<string, string>;
    };

    expect(snowflakeConfig.headers.Authorization).toBe(
      'Bearer roomote-job-token',
    );
    expect(snowflakeConfig.headers['x-roomote-bypass']).toBe('bypass-token');
  });

  it('rewrites user PostHog MCP to the Roomote proxy with job token auth', () => {
    delete process.env.TRPC_URL;

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com/',
        },
        {
          userMcpServers: {
            posthog: {
              url: 'https://api.preview.roomote.run/api/mcp/posthog',
              headers: {
                'X-MCP-Client': 'Roomote',
                Authorization: 'Bearer raw-posthog-token',
                authorization: 'Bearer raw-posthog-token-lowercase',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).toHaveProperty('posthog');

    const posthogConfig = parsed.mcpServers.posthog as {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(posthogConfig.type).toBe('streamable-http');
    expect(posthogConfig.url).toBe('https://api.test.com/api/mcp/posthog');
    expect(posthogConfig.headers.Authorization).toBe(
      'Bearer roomote-job-token',
    );
    expect(posthogConfig.headers.authorization).toBeUndefined();
    expect(posthogConfig.headers['X-MCP-Client']).toBe('Roomote');
    expect(Object.values(posthogConfig.headers)).not.toContain(
      'Bearer raw-posthog-token',
    );
    expect(Object.values(posthogConfig.headers)).not.toContain(
      'Bearer raw-posthog-token-lowercase',
    );
  });

  it('rewrites user Neon MCP to the Roomote proxy with job token auth', () => {
    delete process.env.TRPC_URL;

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com/',
        },
        {
          userMcpServers: {
            neon: {
              url: '/api/mcp/neon',
              headers: {
                'X-MCP-Client': 'Roomote',
                Authorization: 'Bearer raw-neon-token',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).toHaveProperty('neon');

    const neonConfig = parsed.mcpServers.neon as {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(neonConfig.type).toBe('streamable-http');
    expect(neonConfig.url).toBe('https://api.test.com/api/mcp/neon');
    expect(neonConfig.headers.Authorization).toBe('Bearer roomote-job-token');
    expect(neonConfig.headers['X-MCP-Client']).toBe('Roomote');
    expect(Object.values(neonConfig.headers)).not.toContain(
      'Bearer raw-neon-token',
    );
  });

  it('rewrites user Supabase MCP to the Roomote proxy with job token auth', () => {
    delete process.env.TRPC_URL;

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com/',
        },
        {
          userMcpServers: {
            supabase: {
              url: '/api/mcp/supabase',
              headers: {
                'X-MCP-Client': 'Roomote',
                Authorization: 'Bearer raw-supabase-token',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).toHaveProperty('supabase');

    const supabaseConfig = parsed.mcpServers.supabase as {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(supabaseConfig.type).toBe('streamable-http');
    expect(supabaseConfig.url).toBe('https://api.test.com/api/mcp/supabase');
    expect(supabaseConfig.headers.Authorization).toBe(
      'Bearer roomote-job-token',
    );
    expect(supabaseConfig.headers['X-MCP-Client']).toBe('Roomote');
    expect(Object.values(supabaseConfig.headers)).not.toContain(
      'Bearer raw-supabase-token',
    );
  });

  it('skips user Notion MCP when it points at the raw upstream URL', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com',
        },
        {
          userMcpServers: {
            notion: {
              url: 'https://mcp.notion.com/mcp',
              headers: {
                Authorization: 'Bearer raw-notion-token',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).not.toHaveProperty('notion');
    expect(warnSpy).toHaveBeenCalledWith(
      '[resolveBuiltInMcpServers] Skipping Notion MCP: raw upstream URL is not allowed (https://mcp.notion.com/mcp)',
    );
  });

  it('skips user Sentry MCP when it points at the raw upstream URL', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com',
        },
        {
          userMcpServers: {
            sentry: {
              url: 'https://mcp.sentry.dev/mcp',
              headers: {
                Authorization: 'Bearer raw-sentry-token',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).not.toHaveProperty('sentry');
    expect(warnSpy).toHaveBeenCalledWith(
      '[resolveBuiltInMcpServers] Skipping Sentry MCP: raw upstream URL is not allowed (https://mcp.sentry.dev/mcp)',
    );
  });

  it('skips user Sentry MCP when the proxy path does not match the integration id', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com',
        },
        {
          userMcpServers: {
            sentry: {
              url: '/api/mcp/notion',
              headers: {
                Authorization: 'Bearer raw-sentry-token',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).not.toHaveProperty('sentry');
    expect(warnSpy).toHaveBeenCalledWith(
      "[resolveBuiltInMcpServers] Skipping Sentry MCP: expected proxy path '/api/mcp/sentry' but received '/api/mcp/notion'",
    );
  });

  it('skips user PostHog MCP when it points at the raw upstream URL', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com',
        },
        {
          userMcpServers: {
            posthog: {
              url: 'https://mcp.posthog.com/mcp',
              headers: {
                Authorization: 'Bearer raw-posthog-token',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).not.toHaveProperty('posthog');
    expect(warnSpy).toHaveBeenCalledWith(
      '[resolveBuiltInMcpServers] Skipping PostHog MCP: raw upstream URL is not allowed (https://mcp.posthog.com/mcp)',
    );
  });

  it('skips user Supabase MCP when it points at the raw upstream URL with query params', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = {
      mcpServers: resolveBuiltInMcpServers(
        {
          ROOMOTE_CLOUD_TOKEN: 'roomote-job-token',
          ROOMOTE_APP_URL: 'https://api.test.com',
        },
        {
          userMcpServers: {
            supabase: {
              url: 'https://mcp.supabase.com/mcp?read_only=true&features=database',
              headers: {
                Authorization: 'Bearer raw-supabase-token',
              },
            },
          },
        },
      ),
    };

    expect(parsed.mcpServers).not.toHaveProperty('supabase');
    expect(warnSpy).toHaveBeenCalledWith(
      '[resolveBuiltInMcpServers] Skipping Supabase MCP: raw upstream URL is not allowed (https://mcp.supabase.com/mcp?read_only=true&features=database)',
    );
  });

  it('injects task env vars into the roomote MCP', () => {
    const taskEnv = {
      ROOMOTE_CLOUD_TOKEN: 'test-cloud-token',
      ROOMOTE_APP_URL: 'https://api.test.com',
      ROOMOTE_WORKSPACE_PATH: '/workspace',
      ROOMOTE_TASK_ID: 'task-123',
      ROOMOTE_AUTH_BYPASS_HEADER_NAME: 'x-bypass-roomote-auth',
      ROOMOTE_AUTH_BYPASS_VALUE: 'bypass-token',
      ROOMOTE_TASK_TYPE: 'standard',
      ROOMOTE_SLACK_CHANNEL: 'C123',
      ROOMOTE_SLACK_THREAD_TS: '111.222',
      ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE:
        '/tmp/roomote-slack-reply-satisfaction.json',
      ROOMOTE_COMMUNICATION_PROVIDER: 'teams',
      ROOMOTE_COMMUNICATION_CHANNEL_ID: '19:conversation@thread.v2',
      ROOMOTE_COMMUNICATION_THREAD_ID: 'activity-root',
    };

    const parsed = { mcpServers: resolveBuiltInMcpServers(taskEnv) };

    const roomoteEnv = (
      parsed.mcpServers.roomote as {
        env: Record<string, string>;
      }
    ).env;
    expect(roomoteEnv.ROOMOTE_CLOUD_TOKEN).toBe('test-cloud-token');
    expect(roomoteEnv.ROOMOTE_APP_URL).toBe('https://api.test.com');
    expect(roomoteEnv.ROOMOTE_WORKSPACE_PATH).toBe('/workspace');
    expect(roomoteEnv.ROOMOTE_TASK_ID).toBe('task-123');
    expect(roomoteEnv.ROOMOTE_AUTH_BYPASS_HEADER_NAME).toBe(
      'x-bypass-roomote-auth',
    );
    expect(roomoteEnv.ROOMOTE_AUTH_BYPASS_VALUE).toBe('bypass-token');
    expect(roomoteEnv.ROOMOTE_TASK_TYPE).toBe('standard');
    expect(roomoteEnv.ROOMOTE_SLACK_CHANNEL).toBe('C123');
    expect(roomoteEnv.ROOMOTE_SLACK_THREAD_TS).toBe('111.222');
    expect(roomoteEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE).toBe(
      '/tmp/roomote-slack-reply-satisfaction.json',
    );
    expect(roomoteEnv.ROOMOTE_COMMUNICATION_PROVIDER).toBe('teams');
    expect(roomoteEnv.ROOMOTE_COMMUNICATION_CHANNEL_ID).toBe(
      '19:conversation@thread.v2',
    );
    expect(roomoteEnv.ROOMOTE_COMMUNICATION_THREAD_ID).toBe('activity-root');
  });

  it('does not add extra integration MCPs when no credentials are provided', () => {
    const parsed = { mcpServers: resolveBuiltInMcpServers() };

    expect(Object.keys(parsed.mcpServers).sort()).toEqual(['roomote']);
  });
});
