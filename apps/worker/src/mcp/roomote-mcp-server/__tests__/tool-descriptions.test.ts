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
  delete process.env.ROOMOTE_AUTOMATION_TASK;
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

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;

  while (current instanceof z.ZodOptional || current instanceof z.ZodEffects) {
    current =
      current instanceof z.ZodOptional ? current.unwrap() : current.innerType();
  }

  return current;
}

describe('roomote MCP tool descriptions', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('documents every built-in custom automation schedule preset', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const automationsTool = getRegisteredTool(
      registeredTools,
      'manage_custom_automations',
    );
    const scheduleDescription = getInputSchemaField(
      automationsTool,
      'schedule',
    ).description;

    expect(scheduleDescription).toContain(
      'built-in presets: off, every_hour, every_6_hours, daily, weekly',
    );
    expect(scheduleDescription).toContain(
      'Prefer a built-in preset when it matches the requested cadence.',
    );
  });

  it('keeps cadence out of generated custom automation prompts', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const automationsTool = getRegisteredTool(
      registeredTools,
      'manage_custom_automations',
    );

    expect(automationsTool.config.description).toContain(
      'Keep cadence only in the schedule field; do not repeat it in the stored prompt.',
    );
    expect(
      getInputSchemaField(automationsTool, 'prompt').description,
    ).toContain(
      'Do not include the automation cadence; keep it only in the schedule field.',
    );
  });

  it('prompts agents to offer a test run after conversational creation', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const automationsTool = getRegisteredTool(
      registeredTools,
      'manage_custom_automations',
    );

    expect(automationsTool.config.description).toContain(
      'After successfully creating an automation in response to a conversational request, ask the user whether they want to run it now to test it.',
    );
  });

  it('directs agents to discover enabled models before setting an override', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const automationsTool = getRegisteredTool(
      registeredTools,
      'manage_custom_automations',
    );

    expect(automationsTool.config.description).toContain(
      'Use list_models before setting a model override',
    );
    expect(getInputSchemaField(automationsTool, 'model').description).toContain(
      'Call list_models first and pass an exact returned model ID',
    );
    expect(automationsTool.config.description).toContain(
      'Model IDs encode the inference route',
    );
    expect(automationsTool.config.description).toContain(
      'openai/... uses the deployment OpenAI route, including a connected ChatGPT subscription',
    );
  });

  it('maps conversational automation intent to launchable suggested tasks', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const automationsTool = getRegisteredTool(
      registeredTools,
      'manage_custom_automations',
    );

    expect(automationsTool.config.description).toContain(
      'offer help, suggest tasks, make follow-ups actionable or launchable, or turn findings or action items into tasks',
    );
    expect(automationsTool.config.description).toContain(
      'Do not expose runtime tool names or parameter syntax in the stored prompt.',
    );
    expect(automationsTool.config.description).toContain(
      'A request only to summarize or list action items is not suggested-task intent.',
    );
    expect(automationsTool.config.description).toContain(
      'Only promise launchable suggested tasks when the automation has both a configured chat report destination and a repository or environment for executable work',
    );
    expect(
      getInputSchemaField(automationsTool, 'prompt').description,
    ).toContain('both a chat report destination and an executable workspace');
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
      'Positive result limit: 1 to 100 for search (default 20), or 1 to 1000 for get_messages',
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
      'Use it proactively when the user asks to show, mock up, preview, or visualize',
    );
    expect(tool.config.description).toContain(
      'prefer it over an ASCII or text-only example when a compact visual would answer the request better',
    );
    expect(tool.config.description).toContain(
      'Do not use it for ordinary prose',
    );
    expect(tool.config.description).toContain('rw-card');
    expect(tool.config.description).toContain('`--rw-*` theme variables');
    expect(tool.config.description).toContain(
      'Keep widgets compact enough to fit without scrolling',
    );
    expect(tool.config.description).toContain(
      'HTML, CSS, and inline SVG are displayed in a sandboxed iframe',
    );
    expect(tool.config.description).toContain('request_user_input');
    expect(getInputSchemaField(tool, 'html').description).toContain('HTML');
    expect(getInputSchemaField(tool, 'html').description).toContain(
      'Avoid long prose',
    );
    expect(getInputSchemaField(tool, 'html').description).toContain(
      'including inline SVG',
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

  it('documents explicit visual-proof sharing', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_SLACK_CHANNEL: 'C123',
      ROOMOTE_SLACK_THREAD_TS: '123.456',
    });
    const artifactsTool = getRegisteredTool(
      registeredTools,
      'manage_artifacts',
    );

    expect(artifactsTool.config.description).toContain(
      'Use type "visual-proof" for uploaded screenshots or proof artifacts that should be treated as visual proof. Visual-proof uploads are not posted to chat automatically; when the image should appear in the originating thread, pass returned artifact IDs to `send_chat_reply` via `imageArtifactIds` (or share `viewUrl`/`rawUrl` in the reply text for non-images).',
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
    expect(replyTool.config.description).not.toContain(
      'optional suggestions parameter',
    );
    expect(messageField.description).toBe(
      "Non-empty Markdown text to post in the Slack thread. Match the selected purpose, lead with the useful takeaway, and keep it conversational like a teammate in a thread. For routine successful closeouts, focus on the shipped change and any blocker or delivery outcome that changes the user's next step instead of listing exact validation commands, passed checks, or proof-applicability notes unless the user asked for them or they materially change what the user should do next. Use the modern Slack Markdown contract from the Slack instructions; tables, headings, blockquotes, and fenced code blocks are allowed when they make the reply clearer.",
    );
    expect(getInputSchemaField(replyTool, 'purpose').description).toBe(
      'The lifecycle purpose for this Slack-visible reply. Choose ack for the first visible response before work that will not post to Slack, progress for new useful state or silence prevention, closeout for the final answer/result/blocker/handoff, or clarification for a lightweight question. Use closeout before final task completion.',
    );
    expect(replyTool.config.inputSchema.findings).toBeUndefined();
    expect(replyTool.config.inputSchema.questions).toBeUndefined();
    expect(replyTool.config.inputSchema.suggestedNextSteps).toBeUndefined();
    expect(replyTool.config.inputSchema.suggestions).toBeUndefined();
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
      'Non-empty Markdown text to post in the Teams thread.',
    );
    expect(getInputSchemaField(replyTool, 'purpose').description).toContain(
      'Teams-visible reply',
    );
    expect(replyTool.config.inputSchema.suggestions).toBeUndefined();
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

  it('keeps the rich suggestion contract for scheduled scan workflows', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_SLACK_CHANNEL: 'C123',
      ROOMOTE_SLACK_THREAD_TS: '123.456',
      ROOMOTE_TASK_TYPE: 'scan',
      ROOMOTE_AUTOMATION_TASK: 'true',
    });
    const replyTool = getRegisteredTool(registeredTools, 'send_chat_reply');
    const suggestionItem = (
      unwrapSchema(
        replyTool.config.inputSchema.suggestions as unknown as z.ZodTypeAny,
      ) as z.ZodArray<z.ZodObject<z.ZodRawShape>>
    ).element;

    expect(Object.keys(suggestionItem.shape)).toEqual([
      'title',
      'brief',
      'category',
      'priority',
      'investigationContext',
      'targetRepositoryFullName',
      'targetEnvironmentId',
      'workspaceReadiness',
      'readinessMessage',
    ]);
    expect(getInputSchemaField(replyTool, 'suggestions').description).toContain(
      'scheduled suggestion workflow must include its verified target repository',
    );
    expect(replyTool.config.description).toContain(
      'Use the optional suggestions parameter when the automation prompt explicitly asks for task suggestions',
    );
  });

  it('exposes the compact suggestion contract for channel-backed custom automations', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_SLACK_CHANNEL: 'C123',
      ROOMOTE_SLACK_THREAD_TS: '123.456',
      ROOMOTE_TASK_TYPE: 'standard',
      ROOMOTE_AUTOMATION_TASK: 'true',
    });
    const replyTool = getRegisteredTool(registeredTools, 'send_chat_reply');
    const suggestionItem = (
      unwrapSchema(
        replyTool.config.inputSchema.suggestions as unknown as z.ZodTypeAny,
      ) as z.ZodArray<z.ZodObject<z.ZodRawShape>>
    ).element;

    expect(Object.keys(suggestionItem.shape)).toEqual([
      'title',
      'brief',
      'targetRepositoryFullName',
    ]);
    expect(getInputSchemaField(replyTool, 'suggestions').description).toContain(
      'when the automation prompt explicitly asks for task suggestions',
    );
    expect(getInputSchemaField(replyTool, 'suggestions').description).toContain(
      'For org-wide runs, include the concrete targetRepositoryFullName',
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
      'Non-empty Markdown text to post in the Telegram thread.',
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

  it('registers one provider-neutral message context tool', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const lookupTool = getRegisteredTool(
      registeredTools,
      'get_chat_message_context',
    );
    const channelField = getInputSchemaField(lookupTool, 'channel');
    const messageIdField = getInputSchemaField(lookupTool, 'messageId');
    const messageLinkField = getInputSchemaField(lookupTool, 'messageLink');

    expect(lookupTool.config.description).toBe(
      'Look up a message in the task communication channel and return its surrounding conversation context. When the task has no communication channel, provide a Slack or Discord message link. Explicit cross-channel lookups require the acting user to have access.',
    );
    expect(channelField.description).toBe(
      'Optional channel ID, name, mention, or message link. Omit it to use the task communication channel.',
    );
    expect(messageIdField.description).toContain('Provider message ID');
    expect(messageLinkField.description).toContain(
      'full Slack or Discord message link',
    );
    expect(
      registeredTools.find(({ name }) => name.startsWith('get_slack_')),
    ).toBeUndefined();
    expect(
      registeredTools.find(({ name }) => name.startsWith('get_discord_')),
    ).toBeUndefined();
    expect(registeredTools.find(({ name }) => name === 'send_chat_reply')).toBe(
      undefined,
    );
    expect(
      registeredTools.find(({ name }) => name === 'send_chat_reaction_emoji'),
    ).toBe(undefined);
  });

  it('registers one provider-neutral channel history lookup tool', async () => {
    const { registeredTools } = await importRoomoteMcpServer();
    const lookupTool = getRegisteredTool(
      registeredTools,
      'get_chat_channel_messages',
    );
    const channelField = getInputSchemaField(lookupTool, 'channel');
    const oldestField = getInputSchemaField(lookupTool, 'oldest');
    const latestField = getInputSchemaField(lookupTool, 'latest');

    expect(lookupTool.config.description).toBe(
      'Fetch readable history from the task communication channel. When the task has no communication channel, or when another channel is needed, provide a Slack or Discord channel/message link. Provider-specific access checks still apply.',
    );
    expect(channelField.description).toBe(
      'Optional channel ID, name, mention, or Slack/Discord channel/message link. Omit it to use the task communication channel.',
    );
    expect(oldestField.description).toContain('Slack timestamp');
    expect(latestField.description).toContain('message snowflake');
  });

  it('forwards generic thread lookups to the communication API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          provider: 'discord',
          channelId: 'C0B1H9DPHC0',
          requestedMessageId: '1777486147.585109',
          threadId: '1777486147.000000',
          matchedMessageIndex: 0,
          messageCount: 1,
          messages: [
            {
              provider: 'discord',
              id: '1777486147.585109',
              user: 'U123',
              text: 'message',
              channelId: 'C0B1H9DPHC0',
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
      'get_chat_message_context',
    );

    expect(lookupTool.handler).toBeDefined();
    await lookupTool.handler?.({
      channel: 'C0B1H9DPHC0',
      messageId: '1777486147.585109',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/communication/message_context',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          channel: 'C0B1H9DPHC0',
          messageId: '1777486147.585109',
        }),
      }),
    );
  });

  it('forwards channel history parameters to the communication API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          provider: 'slack',
          channelId: 'C0B1H9DPHC0',
          requestedOldest: '2026-04-01T00:00:00Z',
          requestedLatest: '2026-04-02T00:00:00Z',
          messageCount: 1,
          messages: [
            {
              provider: 'slack',
              id: '1777486147.585109',
              user: 'U123',
              text: 'message',
              channelId: 'C0B1H9DPHC0',
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
      'get_chat_channel_messages',
    );

    expect(lookupTool.handler).toBeDefined();
    await lookupTool.handler?.({
      channel: 'C0B1H9DPHC0',
      oldest: '2026-04-01T00:00:00Z',
      latest: '2026-04-02T00:00:00Z',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/communication/channel_messages',
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

  it('documents the provider-neutral channel post tool', async () => {
    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_TASK_ID: 'task_123',
      ROOMOTE_SLACK_CHANNEL: 'C123',
    });
    const postTool = getRegisteredTool(registeredTools, 'post_to_channel');
    const channelField = getInputSchemaField(postTool, 'channel');
    const textField = getInputSchemaField(postTool, 'text');

    expect(textField.description).toBe(
      'Markdown text to post. Lead with the answer or takeaway.',
    );
    expect(postTool.config.description).toBe(
      'Slack-visible: posts a new standalone message into a Slack channel the Roomote app can access. Use this only when the current user explicitly asks you to post a separate update message rather than replying in the ongoing exchange; prefer send_chat_reply for normal replies. Pass a channel ID (Slack also accepts a channel name or mention, DM ID, or linked Slack user ID/mention). Cross-channel posts and DMs are subject to provider-specific authorization and target support. The message text renders as Markdown. Lead with the answer or takeaway, use short paragraphs, and put each list item on its own line.',
    );
    expect(postTool.config.description).not.toContain(
      '<slack_modern_markdown>',
    );
    expect(channelField.description).toBe(
      'Slack channel ID the Roomote app can access; Slack also accepts a linked user ID or mention for DMs',
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
      'Non-empty Slack message timestamp for the message to react to',
    );
    expect(getInputSchemaField(reactionTool, 'name').description).toBe(
      'Non-empty Slack emoji name without surrounding colons, for example eyes or white_check_mark',
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
      'Non-empty emoji name without surrounding colons, for example eyes or thumbsup',
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
      "Non-empty Markdown text to post in the Slack thread. Match the selected purpose, lead with the useful takeaway, and keep it conversational like a teammate in a thread. For routine successful closeouts, focus on the shipped change and any blocker or delivery outcome that changes the user's next step instead of listing exact validation commands, passed checks, or proof-applicability notes unless the user asked for them or they materially change what the user should do next. Use the modern Slack Markdown contract from the Slack instructions; tables, headings, blockquotes, and fenced code blocks are allowed when they make the reply clearer.",
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

  it('forwards issueNumber from manage_source_control tool params', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          action: 'get_issue',
          provider: 'github',
          repositoryFullName: 'RooCodeInc/Roomote',
          number: 640,
          warnings: [],
          title: 'Example issue',
          state: 'open',
        }),
      }),
    );

    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_CLOUD_TOKEN: 'run-token',
      ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com',
      ROOMOTE_TASK_ID: 'task_123',
    });
    const sourceControlTool = getRegisteredTool(
      registeredTools,
      'manage_source_control',
    );

    expect(sourceControlTool.handler).toBeDefined();
    const result = await sourceControlTool.handler?.({
      action: 'get_issue',
      repositoryFullName: 'RooCodeInc/Roomote',
      issueNumber: 640,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/tasks/task_123/source_control',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'get_issue',
          repositoryFullName: 'RooCodeInc/Roomote',
          issueNumber: 640,
        }),
      }),
    );
    expect(result).toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('"number":640'),
        },
      ],
    });
  });

  it('forwards inline review comment anchor fields from manage_source_control tool params', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          action: 'create_pull_request_review_comment',
          provider: 'github',
          repositoryFullName: 'RooCodeInc/Roomote',
          number: 12,
          threadId: null,
          commentId: '3001',
          url: 'https://github.com/RooCodeInc/Roomote/pull/12#discussion_r3001',
          applied: true,
          warnings: [],
        }),
      }),
    );

    const { registeredTools } = await importRoomoteMcpServer({
      ROOMOTE_CLOUD_TOKEN: 'run-token',
      ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com',
      ROOMOTE_TASK_ID: 'task_123',
    });
    const sourceControlTool = getRegisteredTool(
      registeredTools,
      'manage_source_control',
    );

    const result = await sourceControlTool.handler?.({
      action: 'create_pull_request_review_comment',
      repositoryFullName: 'RooCodeInc/Roomote',
      prNumber: 12,
      path: 'src/index.ts',
      line: 42,
      side: 'RIGHT',
      body: 'Missing error handling here.',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/tasks/task_123/source_control',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'RooCodeInc/Roomote',
          prNumber: 12,
          body: 'Missing error handling here.',
          path: 'src/index.ts',
          line: 42,
          side: 'RIGHT',
        }),
      }),
    );
    expect(result).toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('"commentId":"3001"'),
        },
      ],
    });
  });
});
