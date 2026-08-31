import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  OPENCODE_REDACT_ENV_NAMES_ENV_VAR_NAME,
  OPENCODE_TOOL_SAFETY_PLUGIN_SCRIPT,
} from '../opencode-tool-safety-plugin-script';

interface ToolHookInput {
  tool: string;
  args?: unknown;
}

type ToolHooks = {
  'tool.execute.before': (
    input: ToolHookInput,
    output: { args?: unknown },
  ) => Promise<void>;
  'tool.execute.after': (
    input: ToolHookInput,
    output: { output?: unknown },
  ) => Promise<void>;
};

describe('OPENCODE_TOOL_SAFETY_PLUGIN_SCRIPT', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-opencode-tool-safety-plugin-'),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadHooks(): Promise<ToolHooks> {
    const pluginPath = path.join(tempDir, 'roomote-tool-safety.mjs');
    fs.writeFileSync(pluginPath, OPENCODE_TOOL_SAFETY_PLUGIN_SCRIPT, 'utf8');

    const module = (await import(
      /* @vite-ignore */ pathToFileURL(pluginPath).href
    )) as {
      RoomoteOpenCodeToolSafety: () => Promise<ToolHooks>;
    };

    return await module.RoomoteOpenCodeToolSafety();
  }

  it.each([
    '/tmp/site-icon.ico',
    '/tmp/site-icon.CUR',
    String.raw`C:\tmp\site-icon.ICO`,
    '/tmp/site-icon.ico?cache=1',
  ])('rejects unsupported icon reads for %s', async (filePath) => {
    const hooks = await loadHooks();

    await expect(
      hooks['tool.execute.before']({ tool: 'read' }, { args: { filePath } }),
    ).rejects.toThrow('cannot safely attach ICO or CUR image files');
  });

  it('checks read arguments supplied on the hook input', async () => {
    const hooks = await loadHooks();

    await expect(
      hooks['tool.execute.before'](
        { tool: 'read', args: { file_path: '/tmp/site-icon.ico' } },
        {},
      ),
    ).rejects.toThrow('cannot safely attach ICO or CUR image files');
  });

  it('accepts the generic path argument shape', async () => {
    const hooks = await loadHooks();

    await expect(
      hooks['tool.execute.before'](
        { tool: 'read' },
        { args: { path: '/tmp/site-icon.ico' } },
      ),
    ).rejects.toThrow('cannot safely attach ICO or CUR image files');
  });

  it('rejects a safe-looking symlink whose target is an unsupported icon', async () => {
    const hooks = await loadHooks();
    const targetPath = path.join(tempDir, 'target.ico');
    const symlinkPath = path.join(tempDir, 'preview.png');
    fs.writeFileSync(targetPath, 'not inspected by the plugin', 'utf8');
    fs.symlinkSync(targetPath, symlinkPath);

    await expect(
      hooks['tool.execute.before'](
        { tool: 'read' },
        { args: { filePath: symlinkPath } },
      ),
    ).rejects.toThrow('cannot safely attach ICO or CUR image files');
  });

  it('allows a symlink to a supported image path', async () => {
    const hooks = await loadHooks();
    const targetPath = path.join(tempDir, 'target.png');
    const symlinkPath = path.join(tempDir, 'preview.png');
    fs.writeFileSync(targetPath, 'not inspected by the plugin', 'utf8');
    fs.symlinkSync(targetPath, symlinkPath);

    await expect(
      hooks['tool.execute.before'](
        { tool: 'read' },
        { args: { filePath: symlinkPath } },
      ),
    ).resolves.toBeUndefined();
  });

  it.each(['/tmp/screenshot.png', '/tmp/component.ts'])(
    'allows safe reads for %s',
    async (filePath) => {
      const hooks = await loadHooks();

      await expect(
        hooks['tool.execute.before']({ tool: 'read' }, { args: { filePath } }),
      ).resolves.toBeUndefined();
    },
  );

  it('does not inspect arguments for other tools', async () => {
    const hooks = await loadHooks();

    await expect(
      hooks['tool.execute.before'](
        { tool: 'bash' },
        { args: { filePath: '/tmp/site-icon.ico' } },
      ),
    ).resolves.toBeUndefined();
  });

  it('redacts known environment values from tool output', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:p[a]ss@db.example/app');
    vi.stubEnv('API_TOKEN', 'token-value-longer');
    vi.stubEnv(
      OPENCODE_REDACT_ENV_NAMES_ENV_VAR_NAME,
      JSON.stringify(['DATABASE_URL', 'API_TOKEN']),
    );
    const hooks = await loadHooks();
    const output = {
      output:
        'DATABASE_URL=postgres://user:p[a]ss@db.example/app\n' +
        'API_TOKEN=token-value-longer token-value-longer',
    };

    await hooks['tool.execute.after']({ tool: 'bash' }, output);

    expect(output.output).toBe(
      'DATABASE_URL=[redacted]\nAPI_TOKEN=[redacted] [redacted]',
    );
  });

  it('redacts overlapping values longest-first', async () => {
    vi.stubEnv('SHORT_TOKEN', 'shared-token');
    vi.stubEnv('LONG_TOKEN', 'shared-token-suffix');
    vi.stubEnv(
      OPENCODE_REDACT_ENV_NAMES_ENV_VAR_NAME,
      JSON.stringify(['SHORT_TOKEN', 'LONG_TOKEN']),
    );
    const hooks = await loadHooks();
    const output = { output: 'shared-token-suffix shared-token' };

    await hooks['tool.execute.after']({ tool: 'shell' }, output);

    expect(output.output).toBe('[redacted] [redacted]');
  });

  it('redacts a trimmed environment value printed by a command', async () => {
    vi.stubEnv('PADDED_TOKEN', '  token-value-padded  \n');
    vi.stubEnv(
      OPENCODE_REDACT_ENV_NAMES_ENV_VAR_NAME,
      JSON.stringify(['PADDED_TOKEN']),
    );
    const hooks = await loadHooks();
    const output = { output: 'PADDED_TOKEN=token-value-padded' };

    await hooks['tool.execute.after']({ tool: 'bash' }, output);

    expect(output.output).toBe('PADDED_TOKEN=[redacted]');
  });

  it('ignores short, missing, and unlisted environment values', async () => {
    vi.stubEnv('SHORT_VALUE', 'local');
    vi.stubEnv('UNLISTED_TOKEN', 'must-remain-visible');
    vi.stubEnv(
      OPENCODE_REDACT_ENV_NAMES_ENV_VAR_NAME,
      JSON.stringify(['SHORT_VALUE', 'MISSING_VALUE']),
    );
    const hooks = await loadHooks();
    const output = { output: 'local must-remain-visible' };

    await hooks['tool.execute.after']({ tool: 'bash' }, output);

    expect(output.output).toBe('local must-remain-visible');
  });

  it('leaves non-text tool output unchanged', async () => {
    vi.stubEnv('API_TOKEN', 'token-value-longer');
    vi.stubEnv(
      OPENCODE_REDACT_ENV_NAMES_ENV_VAR_NAME,
      JSON.stringify(['API_TOKEN']),
    );
    const hooks = await loadHooks();
    const output = { output: { token: 'token-value-longer' } };

    await hooks['tool.execute.after']({ tool: 'custom' }, output);

    expect(output.output).toEqual({ token: 'token-value-longer' });
  });
});
