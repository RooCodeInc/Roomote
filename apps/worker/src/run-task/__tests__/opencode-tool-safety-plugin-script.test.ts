import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { OPENCODE_TOOL_SAFETY_PLUGIN_SCRIPT } from '../opencode-tool-safety-plugin-script';

interface ToolHookInput {
  tool: string;
  args?: unknown;
}

type ToolHooks = {
  'tool.execute.before': (
    input: ToolHookInput,
    output: { args?: unknown },
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
});
