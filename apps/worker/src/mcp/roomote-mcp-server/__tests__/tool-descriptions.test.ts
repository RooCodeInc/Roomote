import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);
const originalEnv = { ...process.env };

type RegisteredTool = {
  name: string;
  config: {
    description: string;
    inputSchema: Record<string, { description?: string; options?: string[] }>;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  };
  handler?: (params: Record<string, unknown>) => Promise<unknown>;
};

const mockState = vi.hoisted(() => ({
  registeredTools: [] as RegisteredTool[],
  connect: vi.fn(async () => undefined),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(
      name: string,
      config: RegisteredTool['config'],
      handler?: RegisteredTool['handler'],
    ) {
      mockState.registeredTools.push({ name, config, handler });
    }

    connect = mockState.connect;
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

vi.mock('../../monitoring/sentry.js', () => ({
  captureWorkerException: vi.fn(),
  flushWorkerSentry: vi.fn(async () => undefined),
  initWorkerSentry: vi.fn(async () => undefined),
  installWorkerFatalProcessHandlers: vi.fn(),
}));

async function importRoomoteMcpServer(
  envOverrides: Record<string, string> = {},
) {
  vi.resetModules();
  mockState.registeredTools.length = 0;
  mockState.connect.mockClear();
  process.env = { ...originalEnv };
  delete process.env.ROOMOTE_SLACK_CHANNEL;
  delete process.env.ROOMOTE_SLACK_THREAD_TS;
  delete process.env.ROOMOTE_COMMUNICATION_PROVIDER;
  delete process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID;
  delete process.env.ROOMOTE_COMMUNICATION_THREAD_ID;
  // Registration gates read ROOMOTE_TASK_ID; drop any value inherited from
  // the runner (e.g. when this suite itself runs inside a Roomote task) so
  // tests only see what they opt into.
  delete process.env.ROOMOTE_TASK_ID;

  Object.assign(process.env, envOverrides);

  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  let module: typeof import('../index') | undefined;
  try {
    module = await import('../index');
  } finally {
    consoleError.mockRestore();
  }

  if (!module) {
    throw new Error('Failed to import Roomote MCP server module');
  }

  return {
    connect: mockState.connect,
    module,
    registeredTools: [...mockState.registeredTools],
  };
}

function getRegisteredTool(
  registeredTools: RegisteredTool[],
  toolName: string,
): RegisteredTool {
  const tool = registeredTools.find(({ name }) => name === toolName);

  expect(tool).toBeDefined();

  return tool!;
}

function getInputSchemaField(
  tool: RegisteredTool,
  fieldName: string,
): NonNullable<RegisteredTool['config']['inputSchema'][string]> {
  const field = tool.config.inputSchema[fieldName];

  expect(field).toBeDefined();

  return field!;
}

describe('roomote MCP tool descriptions', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('guides existing product task URLs toward task inspection actions', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const manageTasksTool = getRegisteredTool(registeredTools, 'manage_tasks');

    expect(manageTasksTool.config.description).toContain(
      'Manage Roomote tasks.',
    );
    expect(manageTasksTool.config.description).not.toContain(
      'Not Slack-visible by itself',
    );
    expect(manageTasksTool.config.description).toContain(
      'When the user provides an existing Roomote task URL or asks about an existing task, extract the task ID and use action "get_summary" for current status or action "get_messages" for transcript details before resorting to browser or task-UI navigation.',
    );
  });

  it('documents the task run log debugging action on manage_tasks', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const manageTasksTool = getRegisteredTool(registeredTools, 'manage_tasks');

    expect(manageTasksTool.config.description).toContain(
      'Use action "get_compute_logs" to fetch all compute logs for a task, including per-job command output for compute providers that support output lookup when the job has both a machine id and sandbox command id (requires taskId).',
    );
  });

  it('keeps debug actions out of manage_tasks', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const manageTasksTool = getRegisteredTool(registeredTools, 'manage_tasks');
    const actionField = getInputSchemaField(manageTasksTool, 'action');
    const taskIdField = getInputSchemaField(manageTasksTool, 'taskId');
    const limitField = getInputSchemaField(manageTasksTool, 'limit');

    expect(manageTasksTool.config.description).not.toContain('get_diagnostics');
    expect(manageTasksTool.config.description).not.toContain('get_events');
    expect(manageTasksTool.config.description).not.toContain(
      'get_runtime_state',
    );
    expect(manageTasksTool.config.description).not.toContain('get_harness_log');
    expect(actionField.options).toEqual([
      'search',
      'get_summary',
      'get_compute_logs',
      'get_messages',
      'launch',
      'cancel',
      'send_message',
      'list_environments',
    ]);
    expect(taskIdField.description).toBe(
      'The task ID (required for get_summary, get_compute_logs, get_messages, cancel, and send_message)',
    );
    expect(limitField.description).toBe(
      'Max results for search (default 20, max 100) or max latest messages for get_messages (max 1000)',
    );
  });

  it('documents automatic Slack visual-proof posting for Slack-started tasks', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_SLACK_CHANNEL: 'C123',
      ROOMOTE_SLACK_THREAD_TS: '123.456',
      ROOMOTE_SLACK_PROOF_AUTO_POST: 'true',
    });
    const artifactsTool = getRegisteredTool(
      registeredTools,
      'manage_artifacts',
    );

    expect(artifactsTool.config.description).toContain(
      'Create, upload, download, and list artifacts in Roomote.',
    );
    expect(artifactsTool.config.description).not.toContain(
      'Not Slack-visible by itself: creates, uploads, or downloads Roomote artifacts.',
    );
    expect(artifactsTool.config.description).toContain(
      'Use action "upload" to upload a workspace-relative file or an absolute file under /tmp (requires path and type).',
    );
    expect(artifactsTool.config.description).toContain(
      'Use type "visual-proof" for uploaded screenshots or proof artifacts that should be treated as visual proof; for Slack-started tasks when visual-proof auto-post is enabled, visual-proof uploads are posted back to the originating Slack thread automatically.',
    );
    expect(artifactsTool.config.description).not.toContain(
      'After uploading image files, if `send_chat_reply` or `post_to_slack_channel` is available, pass the returned artifact IDs to those tools via `imageArtifactIds` so the user sees them directly in Slack.',
    );
  });

  it('registers show_widget for presentational HTML in the task transcript', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const tool = getRegisteredTool(registeredTools, 'show_widget');

    expect(tool.config.description).toContain(
      'Render a presentational HTML widget in the current task transcript.',
    );
    expect(tool.config.description).not.toContain('Roomote');
    expect(tool.config.description).toContain(
      'to demonstrate how something would look',
    );
    expect(tool.config.description).toContain(
      'Do not use it for ordinary prose',
    );
    expect(tool.config.description).toContain('rw-card');
    expect(tool.config.description).toContain('`--rw-*` theme variables');
    expect(tool.config.description).toContain(
      'Keep widgets compact enough to fit without scrolling',
    );
    expect(tool.config.description).toContain('request_user_input');
    expect(getInputSchemaField(tool, 'html').description).toContain('HTML');
    expect(getInputSchemaField(tool, 'html').description).toContain(
      'Avoid long prose',
    );
    expect(getInputSchemaField(tool, 'css').description).toContain(
      '--rw-surface',
    );
    expect(getInputSchemaField(tool, 'height').description).toContain(
      'without a vertical scrollbar',
    );
    expect(getInputSchemaField(tool, 'textFallback').description).toContain(
      'originating chat surface',
    );
    for (const field of ['html', 'title', 'css', 'height', 'textFallback']) {
      expect(getInputSchemaField(tool, field).description).not.toContain(
        'Roomote',
      );
    }
    expect(tool.config.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('documents manual visual-proof posting when Slack auto-post is disabled', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_SLACK_CHANNEL: 'C123',
      ROOMOTE_SLACK_THREAD_TS: '123.456',
    });
    const artifactsTool = getRegisteredTool(
      registeredTools,
      'manage_artifacts',
    );

    expect(artifactsTool.config.description).toContain(
      'Use type "visual-proof" for uploaded screenshots or proof artifacts that should be treated as visual proof. Visual-proof uploads are not auto-posted to chat for this task; when the image should appear in the originating thread, pass returned artifact IDs to `send_chat_reply` via `imageArtifactIds` (or share `viewUrl`/`rawUrl` in the reply text for non-images).',
    );
    expect(artifactsTool.config.description).not.toContain(
      'visual-proof uploads are posted back to the originating Slack thread automatically.',
    );
  });

  it('documents the artifact list action on manage_artifacts', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const artifactsTool = getRegisteredTool(
      registeredTools,
      'manage_artifacts',
    );
    const actionField = getInputSchemaField(artifactsTool, 'action');
    const artifactTypeField = getInputSchemaField(
      artifactsTool,
      'artifactType',
    );

    expect(actionField.options).toEqual([
      'create_plan',
      'upload',
      'download',
      'list',
    ]);
    expect(artifactsTool.config.description).toContain(
      'Use action "list" to list the artifacts already uploaded for a task (defaults to the current task) with their stored paths and URLs, optionally filtered by artifactType.',
    );
    expect(artifactsTool.config.description).toContain(
      'Use it to reuse previously uploaded artifact links (for example visual-proof links) instead of relying on transcript memory or re-uploading.',
    );
    expect(artifactTypeField.description).toBe(
      'Optional artifact type filter for list (one of "general", "plan", "visual-proof"). Omit to list all artifact types.',
    );
  });

  it('documents the default Slack chat reply tool', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_SLACK_CHANNEL: 'C123',
      ROOMOTE_SLACK_THREAD_TS: '123.456',
    });
    const replyTool = getRegisteredTool(registeredTools, 'send_chat_reply');
    const messageField = getInputSchemaField(replyTool, 'message');

    expect(replyTool.config.description).toContain(
      'Slack-visible: posts a lifecycle reply in the originating Slack thread.',
    );
    expect(replyTool.config.description).toContain(
      'Choose the current Slack turn purpose before writing: ack, progress, closeout, or clarification.',
    );
    expect(replyTool.config.description).toContain(
      `Use ack for the first visible response when work will continue; use progress only when the message adds new decision-useful state or prevents a 10-minute silence gap; use closeout for the answer, result, blocker, or handoff; use clarification for lightweight non-secret questions. Use closeout to finish a turn with an outcome; a clarification also ends the turn when the next step depends on the user's answer — do not follow it with a separate "waiting on your answer" message. Ack and progress keep the Slack turn open.`,
    );
    expect(replyTool.config.description).toContain(
      "For routine successful closeouts, focus on the shipped change and any blocker or delivery outcome that changes the user's next step; do not include exact validation commands, passed-check ledgers, or proof-applicability narration unless the user asked or that detail materially changes what they should do next.",
    );
    expect(replyTool.config.description).toContain(
      'Supports the modern Slack Markdown contract from the Slack instructions. Use rich Markdown when it improves scanability.',
    );
    expect(replyTool.config.description).toContain(
      'When the reply mentions actionable code references, follow the Slack prompt source-linking rule.',
    );
    expect(replyTool.config.description).not.toContain(
      '<slack_modern_markdown>',
    );
    expect(replyTool.config.description).toContain(
      'Write the message so its content clearly matches the selected purpose.',
    );
    expect(messageField.description).toBe(
      "Markdown text to post in the Slack thread. Match the selected purpose, lead with the useful takeaway, and keep it conversational like a teammate in a thread. For routine successful closeouts, focus on the shipped change and any blocker or delivery outcome that changes the user's next step instead of listing exact validation commands, passed checks, or proof-applicability notes unless the user asked for them or they materially change what the user should do next. Use the modern Slack Markdown contract from the Slack instructions; tables, headings, blockquotes, and fenced code blocks are allowed when they make the reply clearer.",
    );
    expect(getInputSchemaField(replyTool, 'purpose').description).toBe(
      'The lifecycle purpose for this Slack-visible reply. Choose ack for the first visible response before work that will not post to Slack, progress for new useful state or silence prevention, closeout for the final answer/result/blocker/handoff, or clarification for a lightweight question. Use closeout before final task completion.',
    );
    expect(replyTool.config.inputSchema.findings).toBeUndefined();
    expect(replyTool.config.inputSchema.questions).toBeUndefined();
    expect(replyTool.config.inputSchema.suggestedNextSteps).toBeUndefined();
  });

  it('documents the Teams chat reply tool when Teams communication context exists', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_COMMUNICATION_PROVIDER: 'teams',
      ROOMOTE_COMMUNICATION_CHANNEL_ID: '19:conversation@thread.v2',
      ROOMOTE_COMMUNICATION_THREAD_ID: 'activity-root',
      ROOMOTE_TASK_ID: 'task_123',
    });
    const replyTool = getRegisteredTool(registeredTools, 'send_chat_reply');
    const messageField = getInputSchemaField(replyTool, 'message');

    expect(replyTool.config.description).toContain(
      'Teams-visible: posts a lifecycle reply in the originating Teams thread.',
    );
    expect(replyTool.config.description).toContain(
      'Choose the current Teams turn purpose before writing: ack, progress, closeout, or clarification.',
    );
    expect(replyTool.config.description).toContain(
      'Use rich Markdown when it improves scanability.',
    );
    expect(replyTool.config.description).not.toContain(
      'send_chat_reaction_emoji',
    );
    expect(messageField.description).toContain(
      'Markdown text to post in the Teams thread.',
    );
    expect(getInputSchemaField(replyTool, 'purpose').description).toContain(
      'Teams-visible reply',
    );
    const reactionTool = getRegisteredTool(
      registeredTools,
      'send_chat_reaction_emoji',
    );
    expect(reactionTool.config.description).toContain(
      'Teams-visible: adds an emoji reaction to the latest Teams user message',
    );
    expect(reactionTool.config.description).toContain(
      'Teams reactions post a plain Teams message containing only the emoji',
    );
  });

  it('documents the Telegram chat reply tool when Telegram communication context exists', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_COMMUNICATION_PROVIDER: 'telegram',
      ROOMOTE_COMMUNICATION_CHANNEL_ID: '-100456',
      ROOMOTE_COMMUNICATION_THREAD_ID: '7',
      ROOMOTE_TASK_ID: 'task_123',
    });
    const replyTool = getRegisteredTool(registeredTools, 'send_chat_reply');
    const messageField = getInputSchemaField(replyTool, 'message');

    expect(replyTool.config.description).toContain(
      'Telegram-visible: posts a lifecycle reply in the originating Telegram thread.',
    );
    expect(replyTool.config.description).toContain(
      'Choose the current Telegram turn purpose before writing: ack, progress, closeout, or clarification.',
    );
    expect(replyTool.config.description).toContain(
      'Use rich Markdown when it improves scanability.',
    );
    expect(replyTool.config.description).not.toContain(
      'send_chat_reaction_emoji',
    );
    expect(messageField.description).toContain(
      'Markdown text to post in the Telegram thread.',
    );
    expect(getInputSchemaField(replyTool, 'purpose').description).toContain(
      'Telegram-visible reply',
    );

    // Telegram context registers the current-turn reaction shortcut too.
    const reactionTool = getRegisteredTool(
      registeredTools,
      'send_chat_reaction_emoji',
    );
    expect(reactionTool.config.description).toContain(
      'Telegram-visible: adds an emoji reaction to the latest Telegram user message',
    );
    expect(reactionTool.config.description).toContain(
      'Telegram supports a limited reaction set',
    );
  });

  it('only marks automation Slack summaries delivered when the platform accepted at least one item', async () => {
    const { module } = await importRoomoteMcpServer();
    const buildResult = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    });

    expect(
      module.taskSuggestionResultHasSubmittedSuggestions(
        buildResult({ success: true, suggestionCount: 1 }),
      ),
    ).toBe(true);
    expect(
      module.automationWorkItemsResultHasSubmittedWorkItems(
        buildResult({ success: true, workItemCount: 1 }),
      ),
    ).toBe(true);
    expect(
      module.taskSuggestionResultHasSubmittedSuggestions(
        buildResult({ success: true, suggestionCount: 0 }),
      ),
    ).toBe(false);
    expect(
      module.taskSuggestionResultHasSubmittedSuggestions(
        buildResult({ success: true }),
      ),
    ).toBe(false);
    expect(
      module.automationWorkItemsResultHasSubmittedWorkItems(
        buildResult({ success: true, workItemCount: 0 }),
      ),
    ).toBe(false);
    expect(
      module.automationWorkItemsResultHasSubmittedWorkItems(
        buildResult({ success: true }),
      ),
    ).toBe(false);
  });

  it('registers the Slack thread lookup tool without Slack reply context', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const lookupTool = getRegisteredTool(registeredTools, 'get_slack_thread');
    const channelField = getInputSchemaField(lookupTool, 'channel');
    const messageTsField = getInputSchemaField(lookupTool, 'messageTs');

    expect(lookupTool.config.description).toBe(
      'Look up a Slack message by timestamp in the originating Slack channel and return the full thread that contains it. Use this when a Slack thread references another Slack message timestamp and you need the surrounding thread context. When the current task did not start from Slack, provide the Slack channel ID, name, or channel mention. Explicit channel lookups require a linked acting Slack user, except bot-started Slack jobs are limited to public channels the app has joined.',
    );
    expect(channelField.description).toBe(
      'Optional Slack channel ID, channel name, or channel mention. Required when the current task did not start from Slack. Explicit channels require a linked acting Slack user unless the job only has bot Slack context, in which case only public channels are allowed.',
    );
    expect(messageTsField.description).toBe(
      'Slack message timestamp to look up in the originating or provided Slack channel.',
    );
    expect(registeredTools.find(({ name }) => name === 'send_chat_reply')).toBe(
      undefined,
    );
    expect(
      registeredTools.find(({ name }) => name === 'send_chat_reaction_emoji'),
    ).toBe(undefined);
  });

  it('registers the Slack channel history lookup tool', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const lookupTool = getRegisteredTool(
      registeredTools,
      'get_slack_channel_messages',
    );
    const channelField = getInputSchemaField(lookupTool, 'channel');
    const oldestField = getInputSchemaField(lookupTool, 'oldest');
    const latestField = getInputSchemaField(lookupTool, 'latest');

    expect(lookupTool.config.description).toBe(
      'Fetch history from the originating Slack channel or an explicitly provided Slack channel, but only when that channel is public and the Slack app has already joined it. Optional oldest/latest bounds accept Slack timestamps or ISO 8601 date strings. Explicit channel lookups still require a linked acting Slack user when the current task has one.',
    );
    expect(channelField.description).toBe(
      'Optional Slack channel ID, channel name, or channel mention. Required when the current task did not start from Slack. Only public channels the Slack app has already joined are supported.',
    );
    expect(oldestField.description).toBe(
      'Optional inclusive lower bound for returned messages, as a Slack timestamp or ISO 8601 date string.',
    );
    expect(latestField.description).toBe(
      'Optional inclusive upper bound for returned messages, as a Slack timestamp or ISO 8601 date string.',
    );
  });

  it('forwards explicit Slack lookup channels to the API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          channelId: 'C0B1H9DPHC0',
          requestedMessageTs: '1777486147.585109',
          threadTs: '1777486147.000000',
          matchedMessageIndex: 0,
          messageCount: 1,
          messages: [
            {
              ts: '1777486147.585109',
              user: 'U123',
              text: 'message',
              fileCount: 0,
            },
          ],
        }),
      }),
    );

    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_CLOUD_TOKEN: 'run-token',
      ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com',
    });
    const lookupTool = getRegisteredTool(registeredTools, 'get_slack_thread');

    expect(lookupTool.handler).toBeDefined();
    await lookupTool.handler?.({
      channel: 'C0B1H9DPHC0',
      messageTs: '1777486147.585109',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/slack/thread_lookup',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          channel: 'C0B1H9DPHC0',
          messageTs: '1777486147.585109',
        }),
      }),
    );
  });

  it('forwards Slack channel history lookup parameters to the API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          channelId: 'C0B1H9DPHC0',
          requestedOldest: '2026-04-01T00:00:00Z',
          requestedLatest: '2026-04-02T00:00:00Z',
          messageCount: 1,
          messages: [
            {
              ts: '1777486147.585109',
              user: 'U123',
              text: 'message',
              fileCount: 0,
            },
          ],
        }),
      }),
    );

    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_CLOUD_TOKEN: 'run-token',
      ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com',
    });
    const lookupTool = getRegisteredTool(
      registeredTools,
      'get_slack_channel_messages',
    );

    expect(lookupTool.handler).toBeDefined();
    await lookupTool.handler?.({
      channel: 'C0B1H9DPHC0',
      oldest: '2026-04-01T00:00:00Z',
      latest: '2026-04-02T00:00:00Z',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/slack/channel_messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          channel: 'C0B1H9DPHC0',
          oldest: '2026-04-01T00:00:00Z',
          latest: '2026-04-02T00:00:00Z',
        }),
      }),
    );
  });

  it('documents Slack channel post formatting on the text parameter', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_TASK_ID: 'task_123',
    });
    const postTool = getRegisteredTool(
      registeredTools,
      'post_to_slack_channel',
    );
    const textField = getInputSchemaField(postTool, 'text');

    expect(textField.description).toBe(
      'Markdown text to post. Slack messages posted by this tool render in Slack `markdown` blocks. Use modern Markdown as a readability tool when it improves scanability; headings, blockquotes, fenced code blocks, tables, links, and inline formatting are allowed when they make the reply clearer. Lead with the answer or takeaway, use short paragraphs with blank lines between them, and put each list item on its own line. Reserve backticks for literal code, not emphasis.',
    );
    expect(postTool.config.description).toBe(
      'Slack-visible: posts to a Slack channel that the Roomote Slack app is already a member of. Use this only when the current user explicitly asks you to send or relay an update to a different Slack channel or thread than the originating thread. Do not use it to answer a customer, third party, or linked Slack conversation just because that conversation appears in context. The channel can be a channel ID, channel name, or Slack channel mention like C123ABC456, #eng, eng, or <#C123ABC456>. Slack messages posted by this tool render in Slack `markdown` blocks. Use modern Markdown as a readability tool when it improves scanability; headings, blockquotes, fenced code blocks, tables, links, and inline formatting are allowed when they make the reply clearer. When the post mentions actionable code references, link the important ones with short-label GitHub blob permalinks at the exact inspected revision, add resolvable line anchors, and mention the file or symbol in prose rather than inventing a link. The tool will not join channels for you.',
    );
    expect(postTool.config.description).not.toContain(
      '<slack_modern_markdown>',
    );
    expect(textField.description).not.toContain(
      'Keep simple updates simple instead of forcing structure.',
    );
  });

  it('documents the Slack reaction tool', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_TASK_ID: 'task_123',
    });
    const reactionTool = getRegisteredTool(
      registeredTools,
      'add_reaction_to_slack_message',
    );

    expect(reactionTool.config.description).toBe(
      'Slack-visible: adds an emoji reaction to a specific Slack message. Use this when the user explicitly wants a reaction added to a known Slack message and you already have the channel and message timestamp. The channel can be a channel ID, channel name, or Slack channel mention like C123ABC456, #eng, eng, or <#C123ABC456>.',
    );
    expect(getInputSchemaField(reactionTool, 'channel').description).toBe(
      'Slack channel ID, channel name, or Slack channel mention that contains the target message',
    );
    expect(getInputSchemaField(reactionTool, 'messageTs').description).toBe(
      'Slack message timestamp for the message to react to',
    );
    expect(getInputSchemaField(reactionTool, 'name').description).toBe(
      'Slack emoji name without surrounding colons, for example eyes or white_check_mark',
    );
  });

  it('documents the current-turn Slack reaction shortcut tool', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_SLACK_CHANNEL: 'C123',
      ROOMOTE_SLACK_THREAD_TS: '123.456',
      ROOMOTE_TASK_ID: 'task_123',
    });
    const reactionTool = getRegisteredTool(
      registeredTools,
      'send_chat_reaction_emoji',
    );

    expect(reactionTool.config.description).toBe(
      'Slack-visible: adds an emoji reaction to the latest Slack user message for the active task session. Use this for fast acknowledgements or emoji-only answers only when the latest user turn itself came from Slack and the reaction should target that same message automatically, without looking up a channel or message timestamp first. Follow the current chat turn policy for whether this shortcut is available.',
    );
    expect(getInputSchemaField(reactionTool, 'name').description).toBe(
      'Emoji name without surrounding colons, for example eyes or thumbsup',
    );
  });

  it('documents chat replies without Slack/storage implementation details', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_SLACK_CHANNEL: 'C123',
      ROOMOTE_SLACK_THREAD_TS: '123.456',
      ROOMOTE_TASK_ID: 'task_123',
    });
    const chatReplyTool = getRegisteredTool(registeredTools, 'send_chat_reply');

    expect(chatReplyTool.config.description).toBe(
      `Slack-visible: posts a lifecycle reply in the originating Slack thread. Choose the current Slack turn purpose before writing: ack, progress, closeout, or clarification. Use ack for the first visible response when work will continue; use progress only when the message adds new decision-useful state or prevents a 10-minute silence gap; use closeout for the answer, result, blocker, or handoff; use clarification for lightweight non-secret questions. Use closeout to finish a turn with an outcome; a clarification also ends the turn when the next step depends on the user's answer — do not follow it with a separate "waiting on your answer" message. Ack and progress keep the Slack turn open. Use it again on later Slack turns when they need another direct reply; an earlier thread reply does not count as the reply for the current turn. For routine successful closeouts, focus on the shipped change and any blocker or delivery outcome that changes the user's next step; do not include exact validation commands, passed-check ledgers, or proof-applicability narration unless the user asked or that detail materially changes what they should do next. Supports the modern Slack Markdown contract from the Slack instructions. Use rich Markdown when it improves scanability. When the reply mentions actionable code references, follow the Slack prompt source-linking rule. Write the message so its content clearly matches the selected purpose.`,
    );
    expect(getInputSchemaField(chatReplyTool, 'message').description).toBe(
      "Markdown text to post in the Slack thread. Match the selected purpose, lead with the useful takeaway, and keep it conversational like a teammate in a thread. For routine successful closeouts, focus on the shipped change and any blocker or delivery outcome that changes the user's next step instead of listing exact validation commands, passed checks, or proof-applicability notes unless the user asked for them or they materially change what the user should do next. Use the modern Slack Markdown contract from the Slack instructions; tables, headings, blockquotes, and fenced code blocks are allowed when they make the reply clearer.",
    );
    expect(getInputSchemaField(chatReplyTool, 'purpose').description).toBe(
      'The lifecycle purpose for this Slack-visible reply. Choose ack for the first visible response before work that will not post to Slack, progress for new useful state or silence prevention, closeout for the final answer/result/blocker/handoff, or clarification for a lightweight question. Use closeout before final task completion.',
    );
    expect(chatReplyTool.config.description).not.toContain(
      '<slack_modern_markdown>',
    );
    expect(chatReplyTool.config.description).not.toContain(
      'legacy `mrkdwn` text objects',
    );
    expect(chatReplyTool.config.inputSchema.questions).toBeUndefined();
    expect(getInputSchemaField(chatReplyTool, 'imagePaths').description).toBe(
      'Optional workspace-relative or /tmp image file paths to attach.',
    );
    expect(
      getInputSchemaField(chatReplyTool, 'imageArtifactIds').description,
    ).toBe('Optional already-uploaded artifact IDs for images to attach.');
  });

  it('documents the standalone video description tool', () => {
    const source = readFileSync(
      path.resolve(thisDirPath, '../index.ts'),
      'utf8',
    );

    expect(source).toContain("'describe_video'");
    expect(source).toContain(
      'Describe the contents of a video file for understanding UI flows, errors, and screen recordings.',
    );
  });

  it('registers secure env-var requests for Slack-started setup tasks', () => {
    const source = readFileSync(
      path.resolve(thisDirPath, '../index.ts'),
      'utf8',
    );

    expect(source).toContain('TaskPayloadKind.StandardTask');
    expect(source).toContain('TaskPayloadKind.SlackAppMention');
    expect(source).toContain(
      'const WEB_TASK_TYPES_WITH_SECURE_ENV_REQUESTS = new Set<string>([',
    );
  });

  it('serializes manage_environments definition as a plain string schema, not a union', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const envTool = getRegisteredTool(registeredTools, 'manage_environments');
    const definitionField = envTool.config.inputSchema
      .definition as unknown as z.ZodType;

    // `definition` is optional (not required for the record_verification
    // action), so unwrap the optional before asserting the inner string schema.
    const definitionSchema =
      definitionField instanceof z.ZodOptional
        ? (definitionField.unwrap() as z.ZodType)
        : definitionField;

    expect(definitionSchema).toBeInstanceOf(z.ZodString);
    expect(definitionSchema).not.toBeInstanceOf(z.ZodUnion);
    expect(definitionField.description).toContain('YAML or JSON string');
  });

  it('documents hidden investigation context on task suggestions', () => {
    const source = readFileSync(
      path.resolve(thisDirPath, '../index.ts'),
      'utf8',
    );

    expect(source).toContain('investigationContext: z');
    expect(source).toContain(
      'Optional hidden implementation context for the implementing agent. This is not shown to Slack users.',
    );
  });
});
