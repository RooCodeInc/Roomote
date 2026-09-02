import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ALL_REPOSITORIES } from '@roomote/types';
import {
  SHOW_WIDGET_FIXED_CANVAS_GUIDANCE,
  SHOW_WIDGET_HEIGHT_DESCRIPTION,
  SHOW_WIDGET_THEME_GUIDANCE,
} from '../../show-widget';

import {
  bindFastAgentMcpToolExecutor,
  bindFastAgentNativeToolExecutor,
  countFastAgentModelOutputLines,
  createFastAgentSpillTurnBudget,
  FAST_AGENT_NATIVE_TOOL_FILTER,
  FAST_AGENT_NATIVE_TOOL_NAMES,
  FAST_AGENT_OPENCODE_TOOL_OUTPUT_LIMITS,
  FAST_AGENT_SPILL_TURN_CALL_LIMIT,
  FAST_AGENT_SPILL_TURN_OUTPUT_LIMIT_BYTES,
  FAST_AGENT_SUBAGENT_TOOL_FILTER,
  formatFastAgentMcpResultForModel,
  formatFastAgentSkillDocumentForModel,
  getFastAgentNativeToolRuntime,
  revokeFastAgentMcpCapabilitiesForConversation,
  shouldSpillFastAgentModelOutput,
} from '../fast-agent-native-tool-bridge';
import {
  FAST_AGENT_SPILL_MAX_FILE_BYTES,
  fastAgentSpillStore,
} from '../fast-agent-spill-store';
import {
  FAST_AGENT_PACKAGED_SKILL_NAMES,
  FastAgentSkillStore,
} from '../fast-agent-skill-store';
import { callMcpTool, listMcpTools } from '../../mcp-tool-client';
import { buildOpenCodeCliEnv } from '../../opencode-runtime';
import { buildFastAgentToolFilter } from '../fast-agent-tool-policy';

function stringWithSerializedByteLength(byteLength: number): string {
  return 'x'.repeat(byteLength - 2);
}

function textWithLineCount(lines: number): string {
  return Array.from({ length: lines }, () => 'x').join('\n');
}

function expectBoundedSpillDescriptor(output: string): void {
  expect(shouldSpillFastAgentModelOutput(output)).toBe(false);
  expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(
    FAST_AGENT_OPENCODE_TOOL_OUTPUT_LIMITS.maxBytes,
  );
  expect(countFastAgentModelOutputLines(output)).toBeLessThanOrEqual(
    FAST_AGENT_OPENCODE_TOOL_OUTPUT_LIMITS.maxLines,
  );
  expect(output).not.toMatch(/(?:\/tmp\/|tool-output|roomote-fast-spills)/u);
}

describe('Fast native OpenCode tool bridge', () => {
  it('serves Fast tools from one shared config directory per host', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-files', []);
    const otherRuntime = await getFastAgentNativeToolRuntime(
      'native-files-other',
      [],
    );
    const sharedToolsDirectory = runtime.env.OPENCODE_CONFIG_DIR;
    expect(sharedToolsDirectory).toMatch(
      /roomote-fast-opencode\/shared-tools-[a-f0-9]{32}$/u,
    );
    expect(otherRuntime.env.OPENCODE_CONFIG_DIR).toBe(sharedToolsDirectory);
    expect(buildOpenCodeCliEnv(runtime.env).OPENCODE_CONFIG_DIR).toBe(
      sharedToolsDirectory,
    );
    // The conversation directory itself carries only the session config, so
    // OpenCode's per-directory boot never runs a dependency install for it.
    expect((await readdir(runtime.directory)).sort()).toEqual([
      'opencode.json',
    ]);
    const toolsDirectory = join(sharedToolsDirectory!, 'tools');
    const installedToolFiles = await readdir(toolsDirectory);
    const replySource = await readFile(
      join(toolsDirectory, 'send_chat_reply.js'),
      'utf8',
    );
    const launchTaskSource = await readFile(
      join(toolsDirectory, 'launch_task.js'),
      'utf8',
    );
    const sendTaskMessageSource = await readFile(
      join(toolsDirectory, 'send_task_message.js'),
      'utf8',
    );
    const showWidgetSource = await readFile(
      join(toolsDirectory, 'show_widget.js'),
      'utf8',
    );
    const bridgeSource = await readFile(
      join(sharedToolsDirectory!, 'roomote-fast-tool-bridge.js'),
      'utf8',
    );
    const spillReadSource = await readFile(
      join(toolsDirectory, 'spill_read.js'),
      'utf8',
    );
    const skillSource = await readFile(
      join(toolsDirectory, 'load_skill.js'),
      'utf8',
    );
    const skillListSource = await readFile(
      join(toolsDirectory, 'list_skills.js'),
      'utf8',
    );
    const requestUserInputSource = await readFile(
      join(toolsDirectory, 'request_user_input.js'),
      'utf8',
    );

    expect(installedToolFiles.sort()).toEqual(
      Object.values(FAST_AGENT_NATIVE_TOOL_NAMES)
        .map((name) => `${name}.js`)
        .sort(),
    );
    expect(replySource).toContain('export default {');
    expect(replySource).toContain('invoke("send_chat_reply"');
    expect(replySource).toContain('suggestions: z.array');
    expect(replySource).toContain('Launchable follow-ups');
    expect(launchTaskSource).toContain('model: z.string().min(1)');
    expect(launchTaskSource).toContain('deployment-enabled model ID');
    expect(launchTaskSource).toContain(
      'includeAttachments: z.boolean().optional()',
    );
    expect(launchTaskSource).toContain(
      'Supported current-turn attachments are forwarded only when includeAttachments is true',
    );
    expect(launchTaskSource).toContain('defaults to false');
    expect(launchTaskSource).toContain(
      'Brief user-facing description of the work now underway',
    );
    expect(launchTaskSource).toContain(
      'do not mention delegation, launching, or queue state',
    );
    expect(launchTaskSource).not.toContain(
      'explanation of what is being delegated',
    );
    expect(launchTaskSource).toContain(ALL_REPOSITORIES);
    expect(launchTaskSource).toContain(
      'to run against all active repositories',
    );
    expect(sendTaskMessageSource).toContain(
      'includeAttachments: z.boolean().optional()',
    );
    expect(sendTaskMessageSource).toContain(
      'Supported current-turn attachments are forwarded only when includeAttachments is true',
    );
    expect(sendTaskMessageSource).toContain('defaults to false');
    expect(showWidgetSource).toContain('invoke("show_widget"');
    expect(showWidgetSource).toContain('textFallback: z.string().max(4000)');
    expect(showWidgetSource).toContain(
      'On Slack or Discord, textFallback is posted as a chat preview with a link to open the rendered widget',
    );
    expect(showWidgetSource).toContain(
      'Optional chat preview shown on Slack or Discord with a link to open the rendered widget',
    );
    expect(showWidgetSource).not.toContain('textFallback is posted instead');
    expect(showWidgetSource).toContain(SHOW_WIDGET_THEME_GUIDANCE);
    expect(showWidgetSource).toContain(SHOW_WIDGET_FIXED_CANVAS_GUIDANCE);
    expect(showWidgetSource).toContain(SHOW_WIDGET_HEIGHT_DESCRIPTION);
    expect(installedToolFiles).not.toEqual(
      expect.arrayContaining([
        'get_chat_channel_messages.js',
        'get_chat_message_context.js',
        'integration_call.js',
        'manage_tasks.js',
      ]),
    );
    expect(bridgeSource).toContain('context.sessionID');
    expect(bridgeSource).toContain('messageID: context.messageID');
    expect(bridgeSource).toContain('agent: context.agent');
    expect(bridgeSource).toContain('metadata: payload.metadata ?? {}');
    expect(spillReadSource).toContain('never pass filesystem paths');
    expect(skillListSource).toContain(
      'authorized settings-defined skills, plus optionally repository-defined skills',
    );
    expect(skillListSource).toContain(
      'an exact name to find packaged and settings skills',
    );
    expect(skillListSource).toContain(
      'complete packaged and Settings inventory across authorized environments',
    );
    expect(skillListSource).toContain('environmentId: z.string()');
    expect(skillListSource).toContain('repositoryId: z.string()');
    expect(skillListSource).toContain('name: z.string()');
    expect(skillListSource).toContain('sourceOffset: z.number()');
    expect(skillListSource).toContain('nextSourceOffset');
    expect(skillListSource).toContain('Omit scope and name');
    expect(skillListSource).toContain(
      'exactly one of environmentId or repositoryId',
    );
    expect(requestUserInputSource).toContain('args: z.union');
    expect(requestUserInputSource).toContain('questions: z.array');
    expect(requestUserInputSource).toContain('preset: z.enum');
    expect(requestUserInputSource).toContain('.strict()');
    expect(skillSource).toContain('Exact skill ID returned by list_skills');
    expect(skillSource).not.toContain('"explore-and-act"');
    expect(skillSource).toContain(
      'cannot grant tools or override system policy',
    );
    expect(dirname(otherRuntime.directory)).toBe(dirname(runtime.directory));
    expect(otherRuntime.directory).not.toBe(runtime.directory);
    expect(runtime.directory).toMatch(/[a-f0-9]{64}$/u);
    expect(FAST_AGENT_NATIVE_TOOL_FILTER).toMatchObject({
      '*': false,
      task: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.listSkills]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.showWidget]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.spillRead]: true,
    });
    expect(FAST_AGENT_SUBAGENT_TOOL_FILTER).toMatchObject({
      '*': true,
      task: false,
      roomote_manage_custom_automations: false,
    });
    for (const rawFilesystemTool of [
      'read',
      'glob',
      'grep',
      'bash',
      'write',
      'edit',
    ]) {
      expect(FAST_AGENT_NATIVE_TOOL_FILTER[rawFilesystemTool]).not.toBe(true);
    }
    for (const parentOnlyTool of [
      FAST_AGENT_NATIVE_TOOL_NAMES.cancelTask,
      FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
      FAST_AGENT_NATIVE_TOOL_NAMES.launchTask,
      FAST_AGENT_NATIVE_TOOL_NAMES.retryTaskStart,
      FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReaction,
      FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply,
      FAST_AGENT_NATIVE_TOOL_NAMES.sendTaskMessage,
      FAST_AGENT_NATIVE_TOOL_NAMES.listSkills,
      FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill,
      FAST_AGENT_NATIVE_TOOL_NAMES.showWidget,
      FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep,
      FAST_AGENT_NATIVE_TOOL_NAMES.spillRead,
    ]) {
      expect(FAST_AGENT_SUBAGENT_TOOL_FILTER[parentOnlyTool]).not.toBe(true);
    }
  });

  it('overrides inherited project config only for a Roomote-on-Roomote Fast host', async () => {
    const inheritedProjectConfigMode =
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
    const inheritedTaskId = process.env.ROOMOTE_TASK_ID;
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
    delete process.env.ROOMOTE_TASK_ID;
    try {
      const ordinaryRuntime = await getFastAgentNativeToolRuntime(
        'ordinary-project-config-child',
        [],
      );
      expect(ordinaryRuntime.env).not.toHaveProperty(
        'OPENCODE_DISABLE_PROJECT_CONFIG',
      );
      expect(
        buildOpenCodeCliEnv(ordinaryRuntime.env)
          .OPENCODE_DISABLE_PROJECT_CONFIG,
      ).toBe('1');

      process.env.ROOMOTE_TASK_ID = 'outer-coding-task';
      const nestedRuntime = await getFastAgentNativeToolRuntime(
        'roomote-on-roomote-project-config-child',
        [],
      );

      expect(nestedRuntime.directory).toMatch(
        /roomote-fast-opencode\/[a-f0-9]{64}$/u,
      );
      expect(nestedRuntime.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('0');
      expect(
        buildOpenCodeCliEnv(nestedRuntime.env).OPENCODE_DISABLE_PROJECT_CONFIG,
      ).toBe('0');
      expect(process.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    } finally {
      if (inheritedProjectConfigMode === undefined) {
        delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
      } else {
        process.env.OPENCODE_DISABLE_PROJECT_CONFIG =
          inheritedProjectConfigMode;
      }
      if (inheritedTaskId === undefined) {
        delete process.env.ROOMOTE_TASK_ID;
      } else {
        process.env.ROOMOTE_TASK_ID = inheritedTaskId;
      }
    }
  });

  it('normalizes null skill arguments only for a Roomote-on-Roomote Fast host', async () => {
    const inheritedTaskId = process.env.ROOMOTE_TASK_ID;
    delete process.env.ROOMOTE_TASK_ID;
    const runtime = await getFastAgentNativeToolRuntime(
      'roomote-on-roomote-null-skill-args',
      [],
    );
    const sessionId = 'roomote-on-roomote-null-skill-args-parent';
    const unbind = bindFastAgentNativeToolExecutor(
      sessionId,
      'roomote-on-roomote-null-skill-args-conversation',
      async () => null,
      { allowSkillAccess: true, allowSpillRecovery: true },
    );
    const callBridge = (tool: string, args: Record<string, unknown>) =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionID: sessionId, tool, args }),
      })
        .then((response) => response.json())
        .then((payload) => JSON.parse(payload.output));

    try {
      await expect(
        callBridge(FAST_AGENT_NATIVE_TOOL_NAMES.listSkills, {
          environmentId: null,
          repositoryId: null,
        }),
      ).resolves.toEqual({
        success: false,
        error: 'The requested skill catalog is unavailable.',
      });

      process.env.ROOMOTE_TASK_ID = 'outer-coding-task';
      await expect(
        callBridge(FAST_AGENT_NATIVE_TOOL_NAMES.listSkills, {
          environmentId: null,
          repositoryId: null,
        }),
      ).resolves.toMatchObject({ success: true });
      await expect(
        callBridge(FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill, {
          id: 'packaged:security-review',
          resource: null,
        }),
      ).resolves.toMatchObject({
        success: true,
        result: { resource: 'SKILL.md' },
      });
    } finally {
      unbind();
      if (inheritedTaskId === undefined) {
        delete process.env.ROOMOTE_TASK_ID;
      } else {
        process.env.ROOMOTE_TASK_ID = inheritedTaskId;
      }
    }
  });

  it('lists and loads packaged and repository skills without filesystem access', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-skills', []);
    const parentSession = 'opencode-parent-skills';
    const childSession = 'opencode-child-skills';
    const repositorySkillId =
      'repository:repo-1:.agents/skills:changeset-release-pr';
    const skillStore = new FastAgentSkillStore(undefined, {
      list: vi.fn().mockResolvedValue({
        skills: [
          {
            description: 'Prepare the next release.',
            environmentIds: ['environment-1'],
            id: repositorySkillId,
            name: 'changeset-release-pr',
            repository: 'RooCodeInc/Roomote',
            source: 'repository',
          },
        ],
        warnings: [],
      }),
      read: vi.fn().mockResolvedValue({
        byteLength: 25,
        content: '# Changeset Release PR',
        description: 'Prepare the next release.',
        environmentIds: ['environment-1'],
        id: repositorySkillId,
        name: 'changeset-release-pr',
        repository: 'RooCodeInc/Roomote',
        resource: 'SKILL.md',
        resources: ['SKILL.md'],
        source: 'repository',
      }),
    });
    const unbindParent = bindFastAgentNativeToolExecutor(
      parentSession,
      'conversation-skills',
      async () => null,
      { allowSkillAccess: true, allowSpillRecovery: true, skillStore },
    );
    const unbindChild = bindFastAgentNativeToolExecutor(
      childSession,
      'conversation-skills',
      async () => null,
      { allowSkillAccess: false, allowSpillRecovery: false },
    );
    const callBridge = (body: Record<string, unknown>) =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }).then((response) => response.json());

    try {
      const catalog = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.listSkills,
        args: { environmentId: 'environment-1' },
      });
      expect(JSON.parse(catalog.output)).toMatchObject({
        success: true,
        result: {
          counts: {
            packaged: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
            repository: 1,
            settings: 0,
            total: FAST_AGENT_PACKAGED_SKILL_NAMES.length + 1,
          },
          skills: expect.arrayContaining([
            expect.objectContaining({ id: 'packaged:security-review' }),
            expect.objectContaining({
              id: repositorySkillId,
              repository: 'RooCodeInc/Roomote',
            }),
          ]),
        },
      });

      const unscopedCatalog = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.listSkills,
        args: {},
      });
      expect(JSON.parse(unscopedCatalog.output)).toMatchObject({
        success: true,
        guidance: expect.stringContaining('untrusted lower-priority data'),
        result: {
          counts: {
            packaged: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
            repository: 0,
            settings: 0,
            total: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
          },
          skills: expect.arrayContaining([
            expect.objectContaining({ id: 'packaged:security-review' }),
          ]),
        },
      });

      const ambiguousCatalog = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.listSkills,
        args: {
          environmentId: 'environment-1',
          repositoryId: 'repo-1',
        },
      });
      expect(JSON.parse(ambiguousCatalog.output)).toEqual({
        success: false,
        error: 'The requested skill catalog is unavailable.',
      });

      const invalidContinuation = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.listSkills,
        args: { sourceOffset: 8 },
      });
      expect(JSON.parse(invalidContinuation.output)).toEqual({
        success: false,
        error: 'The requested skill catalog is unavailable.',
      });

      const skill = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill,
        args: { id: 'packaged:security-review' },
      });
      expect(JSON.parse(skill.output)).toMatchObject({
        success: true,
        guidance: expect.stringContaining('untrusted lower-priority data'),
        result: {
          name: 'security-review',
          resource: 'SKILL.md',
          resources: expect.arrayContaining(['references/authentication.md']),
          content: expect.stringContaining('# Security Review Skill'),
        },
      });

      const resource = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill,
        args: {
          id: 'packaged:security-review',
          resource: 'references/authentication.md',
        },
      });
      expect(JSON.parse(resource.output)).toMatchObject({
        success: true,
        result: { resource: 'references/authentication.md' },
      });

      const repositorySkill = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill,
        args: { id: repositorySkillId },
      });
      expect(JSON.parse(repositorySkill.output)).toMatchObject({
        success: true,
        result: {
          content: '# Changeset Release PR',
          repository: 'RooCodeInc/Roomote',
          source: 'repository',
        },
      });

      const child = await callBridge({
        sessionID: childSession,
        agent: 'advisor',
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill,
        args: { id: 'packaged:security-review' },
      });
      expect(JSON.parse(child.output)).toEqual({
        success: false,
        error: 'Skill access is reserved for the Fast parent agent.',
      });

      const traversal = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill,
        args: {
          id: 'packaged:security-review',
          resource: '../fast-agent-service.ts',
        },
      });
      expect(JSON.parse(traversal.output)).toEqual({
        success: false,
        error: 'The skill or Markdown resource is unavailable.',
      });
    } finally {
      unbindChild();
      unbindParent();
    }
  });

  it('keeps an accepted 8 MiB skill recoverable despite JSON escaping', async () => {
    const runtime = await getFastAgentNativeToolRuntime('max-skill', []);
    const sessionId = 'max-skill-parent';
    const root = await mkdtemp(join(tmpdir(), 'fast-max-skill-'));
    const skillDirectory = join(root, 'security-review');
    const marker = 'MAX_SKILL_MARKER';
    const content = `${marker}${'"'.repeat(
      FAST_AGENT_SPILL_MAX_FILE_BYTES - Buffer.byteLength(marker, 'utf8'),
    )}`;
    await mkdir(skillDirectory);
    await writeFile(join(skillDirectory, 'SKILL.md'), content, 'utf8');
    const store = new FastAgentSkillStore(root);
    const unbind = bindFastAgentNativeToolExecutor(
      sessionId,
      'max-skill-conversation',
      async () => null,
      { allowSkillAccess: true, allowSpillRecovery: true },
    );
    const callBridge = (body: Record<string, unknown>) =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }).then((response) => response.json());

    try {
      const document = await store.read('packaged:security-review');
      expect(document.byteLength).toBe(FAST_AGENT_SPILL_MAX_FILE_BYTES);
      expect(
        Buffer.byteLength(JSON.stringify(document), 'utf8'),
      ).toBeGreaterThan(FAST_AGENT_SPILL_MAX_FILE_BYTES);

      const formatted = await formatFastAgentSkillDocumentForModel(
        sessionId,
        document,
      );
      expectBoundedSpillDescriptor(formatted.output);
      const descriptor = JSON.parse(formatted.output);
      expect(descriptor.result.content.spill).toMatchObject({
        handle: expect.any(String),
        byteLength: FAST_AGENT_SPILL_MAX_FILE_BYTES,
      });
      const handle = descriptor.result.content.spill.handle as string;

      const search = await callBridge({
        sessionID: sessionId,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep,
        args: { handle, query: marker },
      });
      expect(JSON.parse(search.output)).toMatchObject({
        success: true,
        result: { matches: [expect.objectContaining({ offset: 0 })] },
      });

      const read = await callBridge({
        sessionID: sessionId,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillRead,
        args: { handle, offset: FAST_AGENT_SPILL_MAX_FILE_BYTES - 8 },
      });
      expect(JSON.parse(read.output)).toMatchObject({
        success: true,
        result: {
          byteLength: FAST_AGENT_SPILL_MAX_FILE_BYTES,
          content: '"'.repeat(8),
          nextOffset: null,
        },
      });
    } finally {
      unbind();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mounts actor-resolved MCP tools with their native JSON schemas', async () => {
    const inputSchema = {
      type: 'object' as const,
      properties: {
        query: { type: 'string', minLength: 2 },
        filters: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'null' },
          ],
        },
      },
      required: ['query'],
      additionalProperties: false,
    };
    const runtime = await getFastAgentNativeToolRuntime('native-mcp', [
      {
        id: 'roomote',
        name: 'GitHub',
        description: 'Repository access',
        tools: [
          { name: 'search_code', description: 'Search code', inputSchema },
        ],
      },
    ]);
    const config = JSON.parse(
      await readFile(join(runtime.directory, 'opencode.json'), 'utf8'),
    ) as {
      agent: { build: { tools: Record<string, boolean> } };
      mcp: Record<string, { url: string; headers: Record<string, string> }>;
    };
    const executor = vi.fn(async ({ args }) => ({ matches: [args.query] }));
    expect(config.mcp.roomote!.headers.Authorization).toBe(
      `Bearer ${runtime.mcpCapability}`,
    );
    expect(config.mcp.roomote!.headers.Authorization).not.toContain(
      runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN,
    );
    expect(config.agent.build.tools).toMatchObject({
      '*': false,
      task: true,
      'roomote_*': true,
    });
    const serverConfig = JSON.parse(
      buildOpenCodeCliEnv(runtime.env, {
        preserveReasoning: true,
        promptOnlySubagents: true,
      }).OPENCODE_CONFIG_CONTENT ?? '{}',
    ) as {
      agent: Record<string, { tools: Record<string, boolean> }>;
    };
    expect(serverConfig.agent.advisor!.tools).toMatchObject({
      '*': true,
      task: false,
      roomote_manage_custom_automations: false,
      [FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply]: false,
    });
    const unbind = bindFastAgentMcpToolExecutor(
      runtime.mcpCapability,
      executor,
    );

    try {
      await expect(
        listMcpTools({
          url: config.mcp.roomote!.url,
          headers: config.mcp.roomote!.headers,
        }),
      ).resolves.toEqual([
        { name: 'search_code', description: 'Search code', inputSchema },
      ]);
      await expect(
        callMcpTool({
          url: config.mcp.roomote!.url,
          headers: config.mcp.roomote!.headers,
          toolName: 'search_code',
          args: { query: 'Fast', filters: null },
        }),
      ).resolves.toEqual({ matches: ['Fast'] });
      expect(executor).toHaveBeenCalledWith({
        integrationId: 'roomote',
        toolName: 'search_code',
        args: { query: 'Fast', filters: null },
      });
    } finally {
      unbind();
    }
  });

  it('omits web-only structured input from non-web runtimes', async () => {
    const runtime = await getFastAgentNativeToolRuntime(
      'non-web-native-tools',
      [],
      { surface: 'slack' },
    );
    const config = JSON.parse(
      await readFile(join(runtime.directory, 'opencode.json'), 'utf8'),
    ) as {
      agent: { build: { tools: Record<string, boolean> } };
    };

    expect(
      config.agent.build.tools[FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput],
    ).toBe(false);
  });

  it('registers only native servers with OpenCode and keeps on-demand servers off the request', async () => {
    const runtime = await getFastAgentNativeToolRuntime('lazy-mcp', [
      {
        id: 'roomote',
        name: 'Roomote',
        description: 'Deployment access',
        tools: [{ name: 'manage_tasks', inputSchema: { type: 'object' } }],
      },
      {
        id: 'gbrain',
        name: 'Brain',
        description: 'Deployment memory',
        tools: [{ name: 'query', inputSchema: { type: 'object' } }],
      },
      {
        id: 'github',
        name: 'GitHub',
        description: 'Repository access',
        tools: Array.from({ length: 40 }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: { type: 'object' },
        })),
      },
    ]);
    const config = JSON.parse(
      await readFile(join(runtime.directory, 'opencode.json'), 'utf8'),
    ) as {
      agent: { build: { tools: Record<string, boolean> } };
      mcp: Record<string, unknown>;
    };

    expect(Object.keys(config.mcp).sort()).toEqual(['gbrain', 'roomote']);
    expect(config.agent.build.tools).toMatchObject({
      'roomote_*': true,
      'gbrain_*': true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool]: true,
    });
    expect(config.agent.build.tools).not.toHaveProperty('github_*');
    const toolsDirectory = join(runtime.env.OPENCODE_CONFIG_DIR!, 'tools');
    expect(await readdir(toolsDirectory)).toEqual(
      expect.arrayContaining([
        'find_integration_tools.js',
        'call_integration_tool.js',
      ]),
    );
  });

  it('keeps member task inspection namespaced from native task mutations', async () => {
    const roomoteToolName = 'manage_tasks';
    const runtime = await getFastAgentNativeToolRuntime('roomote-member-mcp', [
      {
        id: 'roomote',
        name: 'Roomote',
        description: 'Deployment access',
        tools: [{ name: roomoteToolName, inputSchema: { type: 'object' } }],
      },
    ]);
    const config = JSON.parse(
      await readFile(join(runtime.directory, 'opencode.json'), 'utf8'),
    ) as { mcp: Record<string, unknown> };
    const toolFilter = buildFastAgentToolFilter(['roomote']);
    const namespacedMemberTool = `roomote_${roomoteToolName}`;

    expect(config.mcp).toHaveProperty('roomote');
    expect(toolFilter).toMatchObject({
      'roomote_*': true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.launchTask]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.sendTaskMessage]: true,
      [FAST_AGENT_NATIVE_TOOL_NAMES.cancelTask]: true,
    });
    expect(namespacedMemberTool).toBe('roomote_manage_tasks');
    expect(Object.values(FAST_AGENT_NATIVE_TOOL_NAMES)).not.toContain(
      namespacedMemberTool,
    );
  });

  it('spills oversized MCP results for direct parent recovery', async () => {
    const conversationId = 'mcp-spill-conversation';
    const parentSessionId = 'mcp-spill-parent-session';
    const runtime = await getFastAgentNativeToolRuntime(conversationId, [
      {
        id: 'roomote',
        name: 'GitHub',
        description: 'Repository access',
        tools: [{ name: 'search_code' }],
      },
    ]);
    const config = JSON.parse(
      await readFile(join(runtime.directory, 'opencode.json'), 'utf8'),
    ) as {
      mcp: Record<string, { url: string; headers: Record<string, string> }>;
    };
    const unbindMcp = bindFastAgentMcpToolExecutor(
      runtime.mcpCapability,
      async () => ({ text: 'MCP evidence '.repeat(6_000) }),
    );
    const unbindParent = bindFastAgentNativeToolExecutor(
      parentSessionId,
      conversationId,
      async () => null,
      { allowSpillRecovery: true },
    );

    try {
      const descriptor = (await callMcpTool({
        url: config.mcp.roomote!.url,
        headers: config.mcp.roomote!.headers,
        toolName: 'search_code',
        args: {},
      })) as {
        preview: string;
        spill: { byteLength: number; guidance: string; handle: string };
        truncated: boolean;
      };
      expect(descriptor).toMatchObject({
        truncated: true,
        spill: { handle: expect.any(String), byteLength: expect.any(Number) },
      });
      expect(descriptor.spill.guidance).toContain(
        'subagent should return the handle verbatim',
      );
      expect(
        Buffer.byteLength(JSON.stringify(descriptor), 'utf8'),
      ).toBeLessThanOrEqual(FAST_AGENT_OPENCODE_TOOL_OUTPUT_LIMITS.maxBytes);

      const response = await fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionID: parentSessionId,
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep,
          args: { handle: descriptor.spill.handle, query: 'MCP evidence' },
        }),
      }).then((result) => result.json());
      expect(JSON.parse(response.output)).toMatchObject({
        success: true,
        result: { matches: expect.any(Array) },
      });
    } finally {
      unbindParent();
      unbindMcp();
    }
  });

  it('finds the first match near the end of a maximum-size MCP result', async () => {
    const conversationId = 'mcp-max-result-conversation';
    const parentSessionId = 'mcp-max-result-parent';
    const marker = 'FIRST_MATCH_NEAR_EOF';
    const result = `${'x'.repeat(
      FAST_AGENT_SPILL_MAX_FILE_BYTES - marker.length - 2,
    )}${marker}`;
    const runtime = await getFastAgentNativeToolRuntime(conversationId, [
      {
        id: 'roomote',
        name: 'GitHub',
        description: 'Repository access',
        tools: [{ name: 'search_code' }],
      },
    ]);
    const config = JSON.parse(
      await readFile(join(runtime.directory, 'opencode.json'), 'utf8'),
    ) as {
      mcp: Record<string, { url: string; headers: Record<string, string> }>;
    };
    const budget = createFastAgentSpillTurnBudget();
    const unbindMcp = bindFastAgentMcpToolExecutor(
      runtime.mcpCapability,
      async () => result,
    );
    const unbindParent = bindFastAgentNativeToolExecutor(
      parentSessionId,
      conversationId,
      async () => null,
      { allowSpillRecovery: true, spillBudget: budget },
    );

    try {
      const descriptor = (await callMcpTool({
        url: config.mcp.roomote!.url,
        headers: config.mcp.roomote!.headers,
        toolName: 'search_code',
        args: {},
      })) as { spill: { byteLength: number; handle: string } };
      expect(descriptor.spill.byteLength).toBe(FAST_AGENT_SPILL_MAX_FILE_BYTES);
      expect(budget.calls).toBe(0);

      let offset = 0;
      let matchOffset: number | undefined;
      while (
        offset < descriptor.spill.byteLength &&
        matchOffset === undefined
      ) {
        const response = await fetch(
          runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              sessionID: parentSessionId,
              tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep,
              args: { handle: descriptor.spill.handle, query: marker, offset },
            }),
          },
        ).then((value) => value.json());
        const search = JSON.parse(response.output);
        expect(search.success).toBe(true);
        matchOffset = search.result.matches[0]?.offset;
        offset = search.result.nextOffset ?? descriptor.spill.byteLength;
      }

      expect(matchOffset).toBe(
        FAST_AGENT_SPILL_MAX_FILE_BYTES - marker.length - 1,
      );
      expect(budget.calls).toBe(4);
    } finally {
      unbindParent();
      unbindMcp();
    }
  });

  it('revokes an in-flight MCP completion before it can recreate spill state', async () => {
    const conversationId = 'mcp-revocation-conversation';
    const integration = {
      id: 'roomote',
      name: 'GitHub',
      description: 'Repository access',
      tools: [{ name: 'search_code' }],
    };
    const runtime = await getFastAgentNativeToolRuntime(conversationId, [
      integration,
    ]);
    const config = JSON.parse(
      await readFile(join(runtime.directory, 'opencode.json'), 'utf8'),
    ) as {
      mcp: Record<string, { url: string; headers: Record<string, string> }>;
    };
    let resolveExecutor!: (value: unknown) => void;
    let markExecutorStarted!: () => void;
    const executorStarted = new Promise<void>((resolve) => {
      markExecutorStarted = resolve;
    });
    const pendingResult = new Promise<unknown>((resolve) => {
      resolveExecutor = resolve;
    });
    const staleUnbind = bindFastAgentMcpToolExecutor(
      runtime.mcpCapability,
      async () => {
        markExecutorStarted();
        return pendingResult;
      },
    );
    const writeSpy = vi.spyOn(fastAgentSpillStore, 'writeForConversation');

    try {
      const staleCall = callMcpTool({
        url: config.mcp.roomote!.url,
        headers: config.mcp.roomote!.headers,
        toolName: 'search_code',
        args: {},
      });
      const staleExpectation = expect(staleCall).rejects.toThrow(
        'Fast turn is no longer active.',
      );
      await executorStarted;

      revokeFastAgentMcpCapabilitiesForConversation(conversationId);
      await fastAgentSpillStore.cleanupConversation(conversationId);
      staleUnbind();
      resolveExecutor({ text: 'stale output '.repeat(6_000) });

      await staleExpectation;
      expect(writeSpy).not.toHaveBeenCalled();

      const freshRuntime = await getFastAgentNativeToolRuntime(conversationId, [
        integration,
      ]);
      const freshUnbind = bindFastAgentMcpToolExecutor(
        freshRuntime.mcpCapability,
        async () => ({ text: 'fresh output '.repeat(6_000) }),
      );
      const parentSessionId = 'mcp-revocation-fresh-parent';
      const unbindParent = bindFastAgentNativeToolExecutor(
        parentSessionId,
        conversationId,
        async () => null,
        { allowSpillRecovery: true },
      );
      try {
        const descriptor = (await callMcpTool({
          url: config.mcp.roomote!.url,
          headers: config.mcp.roomote!.headers,
          toolName: 'search_code',
          args: {},
        })) as { spill: { handle: string }; truncated: boolean };
        expect(descriptor).toMatchObject({
          truncated: true,
          spill: { handle: expect.any(String) },
        });
        expect(writeSpy).toHaveBeenCalledOnce();

        const response = await fetch(
          freshRuntime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${freshRuntime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              sessionID: parentSessionId,
              tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep,
              args: { handle: descriptor.spill.handle, query: 'fresh output' },
            }),
          },
        ).then((result) => result.json());
        expect(JSON.parse(response.output)).toMatchObject({
          success: true,
          result: { matches: expect.any(Array) },
        });
      } finally {
        unbindParent();
        freshUnbind();
      }
    } finally {
      writeSpy.mockRestore();
      revokeFastAgentMcpCapabilitiesForConversation(conversationId);
      await fastAgentSpillStore.cleanupConversation(conversationId);
    }
  });

  it('routes raw JSON arguments and results by OpenCode session id', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-route', []);
    const executor = vi.fn(async ({ agent, messageId, name, args }) => ({
      agent,
      messageId,
      name,
      echoed: args,
      nestedResult: { values: [1, 2, 3] },
    }));
    const unbind = bindFastAgentNativeToolExecutor(
      'opencode-session-1',
      'conversation-1',
      executor,
      { allowSpillRecovery: true },
    );

    try {
      const response = await fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionID: 'opencode-session-1',
          messageID: 'assistant-message-1',
          agent: 'judge',
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
          args: { reason: 'test' },
        }),
      });

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toMatchObject({
        ok: true,
        metadata: {
          roomoteResult: {
            agent: 'judge',
            messageId: 'assistant-message-1',
            name: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
          },
        },
      });
      expect(JSON.parse(payload.output)).toEqual({
        agent: 'judge',
        messageId: 'assistant-message-1',
        name: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
        echoed: { reason: 'test' },
        nestedResult: { values: [1, 2, 3] },
      });
      expect(executor).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'judge',
          messageId: 'assistant-message-1',
        }),
      );
    } finally {
      unbind();
    }
  });

  it('matches OpenCode byte boundaries for native output without early takeover', async () => {
    const conversationId = 'native-byte-boundaries';
    const sessionID = 'native-byte-boundaries-session';
    const runtime = await getFastAgentNativeToolRuntime(conversationId, []);
    let nativeResult = '';
    const unbind = bindFastAgentNativeToolExecutor(
      sessionID,
      conversationId,
      async () => nativeResult,
      { allowSpillRecovery: true },
    );
    const writeSpy = vi.spyOn(fastAgentSpillStore, 'write');
    const callNative = () =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionID,
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
          args: {},
        }),
      }).then((response) => response.json());

    try {
      for (const byteLength of [39_999, 40_000, 40_001, 51_199, 51_200]) {
        nativeResult = stringWithSerializedByteLength(byteLength);
        const expectedOutput = JSON.stringify(nativeResult);
        writeSpy.mockClear();

        const payload = await callNative();

        expect(Buffer.byteLength(payload.output, 'utf8')).toBe(byteLength);
        expect(payload.output).toBe(expectedOutput);
        expect(payload.metadata).toEqual({ roomoteResult: nativeResult });
        expect(writeSpy).not.toHaveBeenCalled();
      }

      nativeResult = stringWithSerializedByteLength(51_201);
      writeSpy.mockClear();
      const payload = await callNative();
      const descriptor = JSON.parse(payload.output);

      expect(writeSpy).toHaveBeenCalledOnce();
      expect(payload.metadata).not.toHaveProperty('roomoteResult');
      expect(descriptor).toMatchObject({
        truncated: true,
        spill: { handle: expect.any(String), byteLength: 51_201 },
      });
      expectBoundedSpillDescriptor(payload.output);
    } finally {
      writeSpy.mockRestore();
      unbind();
      await fastAgentSpillStore.cleanupConversation(conversationId);
    }
  });

  it('matches OpenCode byte boundaries for direct MCP output', async () => {
    const conversationId = 'mcp-byte-boundaries';
    const writeSpy = vi.spyOn(fastAgentSpillStore, 'writeForConversation');
    try {
      for (const byteLength of [39_999, 40_000, 40_001, 51_199, 51_200]) {
        const result = stringWithSerializedByteLength(byteLength);
        const expectedOutput = JSON.stringify(result);
        writeSpy.mockClear();

        const output = await formatFastAgentMcpResultForModel(
          conversationId,
          result,
        );

        expect(Buffer.byteLength(output, 'utf8')).toBe(byteLength);
        expect(output).toBe(expectedOutput);
        expect(writeSpy).not.toHaveBeenCalled();
      }

      const output = await formatFastAgentMcpResultForModel(
        conversationId,
        stringWithSerializedByteLength(51_201),
      );
      const descriptor = JSON.parse(output);

      expect(writeSpy).toHaveBeenCalledOnce();
      expect(descriptor).toMatchObject({
        truncated: true,
        spill: { handle: expect.any(String), byteLength: 51_201 },
      });
      expectBoundedSpillDescriptor(output);
    } finally {
      writeSpy.mockRestore();
      await fastAgentSpillStore.cleanupConversation(conversationId);
    }
  });

  it('matches OpenCode literal line boundaries without counting escaped JSON newlines', () => {
    for (const lines of [1_999, 2_000]) {
      const output = textWithLineCount(lines);
      expect(countFastAgentModelOutputLines(output)).toBe(lines);
      expect(shouldSpillFastAgentModelOutput(output)).toBe(false);
    }

    const oversized = textWithLineCount(2_001);
    expect(countFastAgentModelOutputLines(oversized)).toBe(2_001);
    expect(shouldSpillFastAgentModelOutput(oversized)).toBe(true);

    const serialized = JSON.stringify(oversized);
    expect(serialized).toContain('\\n');
    expect(countFastAgentModelOutputLines(serialized)).toBe(1);
    expect(shouldSpillFastAgentModelOutput(serialized)).toBe(false);
  });

  it('does not expose unexpected executor errors through the bridge', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-errors', []);
    const unbind = bindFastAgentNativeToolExecutor(
      'opencode-session-sensitive-error',
      'conversation-sensitive-error',
      async () => {
        throw new Error('database password appeared in a downstream stack');
      },
      { allowSpillRecovery: true },
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const response = await fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionID: 'opencode-session-sensitive-error',
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
          args: {},
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'Fast tool execution failed.',
      });
      expect(consoleError).toHaveBeenCalledWith(
        '[Fast Agent] Native tool bridge request failed.',
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
      unbind();
    }
  });

  it('spills oversized output before OpenCode can invoke its native spill writer', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-spill', []);
    const parentSession = 'opencode-parent-spill';
    const childSession = 'opencode-child-spill';
    const otherSession = 'opencode-other-spill';
    const unbindParent = bindFastAgentNativeToolExecutor(
      parentSession,
      'conversation-spill',
      async () => ({ text: '😀'.repeat(20_000) }),
      { allowSpillRecovery: true },
    );
    const unbindChild = bindFastAgentNativeToolExecutor(
      childSession,
      'conversation-spill',
      async () => null,
      { allowSpillRecovery: false },
    );
    const unbindOther = bindFastAgentNativeToolExecutor(
      otherSession,
      'other-conversation',
      async () => null,
      { allowSpillRecovery: true },
    );
    const callBridge = (body: Record<string, unknown>) =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }).then((response) => response.json());

    try {
      const oversized = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
        args: {},
      });
      expect(Buffer.byteLength(oversized.output, 'utf8')).toBeLessThanOrEqual(
        FAST_AGENT_OPENCODE_TOOL_OUTPUT_LIMITS.maxBytes,
      );
      expect(oversized.output.split('\n')).toHaveLength(1);
      expect(oversized.metadata).toMatchObject({ truncated: true });
      const descriptor = JSON.parse(oversized.output);
      expect(descriptor).toMatchObject({
        truncated: true,
        spill: { byteLength: expect.any(Number), handle: expect.any(String) },
      });
      expect(descriptor.preview).not.toContain('�');

      const parentRead = await callBridge({
        sessionID: parentSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillRead,
        args: { handle: descriptor.spill.handle, limit: 64 },
      });
      expect(Buffer.byteLength(parentRead.output, 'utf8')).toBeLessThanOrEqual(
        FAST_AGENT_OPENCODE_TOOL_OUTPUT_LIMITS.maxBytes,
      );
      expect(JSON.parse(parentRead.output)).toMatchObject({
        success: true,
        result: { handle: descriptor.spill.handle },
      });

      const crossSessionRead = await callBridge({
        sessionID: otherSession,
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillRead,
        args: { handle: descriptor.spill.handle },
      });
      expect(JSON.parse(crossSessionRead.output)).toEqual({
        success: false,
        error:
          'The result handle is unavailable for this conversation or has expired.',
      });
    } finally {
      unbindOther();
      unbindChild();
      unbindParent();
    }
  });

  it('denies spill recovery to every child agent capability', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-advisor', []);
    const budget = createFastAgentSpillTurnBudget();
    const unbindAdvisor = bindFastAgentNativeToolExecutor(
      'advisor-session',
      'shared-conversation',
      async () => ({ text: 'advisor evidence '.repeat(5_000) }),
      { allowSpillRecovery: false, spillBudget: budget },
    );
    const unbindParent = bindFastAgentNativeToolExecutor(
      'parent-session',
      'shared-conversation',
      async () => null,
      { allowSpillRecovery: true, spillBudget: budget },
    );
    const callBridge = (body: Record<string, unknown>) =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }).then((response) => response.json());

    try {
      const oversized = await callBridge({
        sessionID: 'advisor-session',
        agent: 'advisor',
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
        args: {},
      });
      const descriptor = JSON.parse(oversized.output);
      expect(descriptor.spill.guidance).toContain(
        'subagent should return the handle verbatim',
      );

      for (const agent of ['general', 'explore', 'advisor', 'judge']) {
        const childRead = await callBridge({
          sessionID: 'advisor-session',
          agent,
          tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillRead,
          args: { handle: descriptor.spill.handle },
        });
        expect(JSON.parse(childRead.output)).toEqual({
          success: false,
          error:
            'Result recovery tools are reserved for the Fast parent agent.',
        });
      }

      const parentSearch = await callBridge({
        sessionID: 'parent-session',
        tool: FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep,
        args: { handle: descriptor.spill.handle, query: 'advisor evidence' },
      });
      const searchResult = JSON.parse(parentSearch.output);
      expect(searchResult).toMatchObject({ success: true });
      expect(searchResult.result.matches[0]).toEqual(
        expect.objectContaining({ offset: expect.any(Number) }),
      );
    } finally {
      unbindParent();
      unbindAdvisor();
    }
  });

  it('enforces the cumulative per-turn spill call limit', async () => {
    const runtime = await getFastAgentNativeToolRuntime(
      'native-call-budget',
      [],
    );
    const budget = createFastAgentSpillTurnBudget();
    const sessionID = 'opencode-spill-call-budget';
    const unbind = bindFastAgentNativeToolExecutor(
      sessionID,
      'conversation-call-budget',
      async () => ({ text: 'x'.repeat(60_000) }),
      { allowSpillRecovery: true, spillBudget: budget },
    );
    const callBridge = (tool: string, args: Record<string, unknown>) =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionID, tool, args }),
      }).then((response) => response.json());

    try {
      const oversized = await callBridge(
        FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
        {},
      );
      const handle = JSON.parse(oversized.output).spill.handle;
      for (
        let index = 0;
        index < FAST_AGENT_SPILL_TURN_CALL_LIMIT;
        index += 1
      ) {
        const read = await callBridge(FAST_AGENT_NATIVE_TOOL_NAMES.spillRead, {
          handle,
          limit: 1,
          offset: index,
        });
        expect(JSON.parse(read.output)).toMatchObject({ success: true });
      }
      const blocked = await callBridge(FAST_AGENT_NATIVE_TOOL_NAMES.spillRead, {
        handle,
        limit: 1,
      });
      expect(JSON.parse(blocked.output)).toEqual({
        success: false,
        error: 'The per-turn result recovery call limit has been reached.',
      });
    } finally {
      unbind();
    }
  });

  it('enforces the cumulative per-turn spill output budget', async () => {
    const runtime = await getFastAgentNativeToolRuntime(
      'native-output-budget',
      [],
    );
    const budget = createFastAgentSpillTurnBudget();
    const sessionID = 'opencode-spill-output-budget';
    const unbind = bindFastAgentNativeToolExecutor(
      sessionID,
      'conversation-output-budget',
      async () => ({ text: 'x'.repeat(60_000) }),
      { allowSpillRecovery: true, spillBudget: budget },
    );
    const callBridge = (tool: string, args: Record<string, unknown>) =>
      fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionID, tool, args }),
      }).then((response) => response.json());

    try {
      const oversized = await callBridge(
        FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
        {},
      );
      const handle = JSON.parse(oversized.output).spill.handle;
      let blocked: { output: string } | undefined;
      for (
        let index = 0;
        index < FAST_AGENT_SPILL_TURN_CALL_LIMIT;
        index += 1
      ) {
        const read = await callBridge(FAST_AGENT_NATIVE_TOOL_NAMES.spillRead, {
          handle,
          limit: 5_000,
          offset: index * 5_000,
        });
        if (!JSON.parse(read.output).success) {
          blocked = read;
          break;
        }
      }
      expect(blocked).toBeDefined();
      expect(JSON.parse(blocked!.output)).toEqual({
        success: false,
        error: 'The per-turn result recovery output budget has been reached.',
      });
      expect(budget.outputBytes).toBeLessThanOrEqual(
        FAST_AGENT_SPILL_TURN_OUTPUT_LIMIT_BYTES,
      );
    } finally {
      unbind();
    }
  });

  it('rejects unauthenticated and inactive-session calls', async () => {
    const runtime = await getFastAgentNativeToolRuntime('native-auth', []);
    const body = JSON.stringify({
      sessionID: 'missing-session',
      tool: FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent,
      args: { reason: 'duplicate' },
    });

    const unauthorized = await fetch(
      runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      },
    );
    expect(unauthorized.status).toBe(401);

    const inactive = await fetch(runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_URL!, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body,
    });
    expect(inactive.status).toBe(409);
  });
});
