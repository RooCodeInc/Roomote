import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { OPENCODE_TOOL_SAFETY_PLUGIN_SCRIPT } from '../opencode-tool-safety-plugin-script';

interface ToolHookInput {
  tool: string;
  args?: unknown;
}

type ToolHooks = {
  'tool.execute.after': (
    input: ToolHookInput,
    output: { output: string; metadata?: unknown },
  ) => Promise<void>;
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

  it('keeps the standalone factory working in a minified keepNames bundle', async () => {
    const sourcePath = fileURLToPath(
      new URL('../opencode-tool-safety-plugin-script.ts', import.meta.url),
    );
    const outputDir = path.join(tempDir, 'bundle');
    const configPath = path.join(tempDir, 'build.config.mjs');
    fs.writeFileSync(
      configPath,
      `export default { entry: [${JSON.stringify(sourcePath)}], outDir: ${JSON.stringify(outputDir)}, format: ['esm'], splitting: false, minify: true, keepNames: true, noExternal: [/.*/], banner: { js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);" } };`,
    );
    execFileSync('pnpm', ['exec', 'tsup', '--config', configPath], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { PATH: process.env.PATH, HOME: tempDir },
      stdio: 'pipe',
    });
    const built = await import(
      /* @vite-ignore */ pathToFileURL(
        path.join(outputDir, 'opencode-tool-safety-plugin-script.js'),
      ).href
    );
    const pluginPath = path.join(tempDir, 'built-plugin.mjs');
    fs.writeFileSync(pluginPath, built.OPENCODE_TOOL_SAFETY_PLUGIN_SCRIPT);
    const plugin = await import(
      /* @vite-ignore */ pathToFileURL(pluginPath).href
    );
    const hooks = await plugin.RoomoteOpenCodeToolSafety();
    const value = `glpat-${'G1h2'.repeat(6)}`;
    const parts = [
      'fixture-segment-a',
      'fixture-segment-b',
      'fixture-segment-c',
    ];
    const diagnosticPath = path.join(tempDir, 'synthetic-diagnostic.txt');
    fs.writeFileSync(
      diagnosticPath,
      `password: ${parts.join(' ')}\nstatus: online\n`,
    );
    const shellOutput = {
      output: execFileSync(
        'bash',
        ['-c', 'cat "$1"', 'synthetic-test', diagnosticPath],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
      ),
      metadata: { exitCode: 0 },
    };
    await hooks['tool.execute.after']({ tool: 'bash' }, shellOutput);
    expect(parts.some((part) => shellOutput.output.includes(part))).toBe(false);
    expect(shellOutput.output.includes('status: online')).toBe(true);
    expect(shellOutput.metadata.exitCode).toBe(0);
    const output = { output: JSON.stringify({ value, tokenCount: 42 }) };
    await hooks['tool.execute.after']({ tool: 'bash' }, output);
    expect(output.output.includes(value)).toBe(false);
    expect(JSON.parse(output.output).tokenCount).toBe(42);
  }, 30_000);

  it('instantiates the shared credential inventory in the standalone plugin', async () => {
    const hooks = await loadHooks();
    const values = [
      `glpat-${'G1h2'.repeat(6)}`,
      `sk_${'live'}_${'S3t4'.repeat(6)}`,
      `AKIA${'A1B2'.repeat(4)}`,
      `AIza${'C1d2E'.repeat(7)}`,
      [...`ghp_${'F5g6'.repeat(9)}`]
        .map((char) => `%${char.charCodeAt(0).toString(16)}`)
        .join(''),
      '-----BEGIN RSA PRIVATE KEY-----\nsynthetic-private-material',
    ];
    const output = { output: JSON.stringify({ values, tokenCount: 42 }) };
    await hooks['tool.execute.after']({ tool: 'bash' }, output);
    const probes = [...values.slice(0, 5), 'synthetic-private-material'];
    expect(probes.some((probe) => output.output.includes(probe))).toBe(false);
    expect(JSON.parse(output.output).tokenCount).toBe(42);
  });

  it('removes diagnostic environment values and authorization before returning tool output', async () => {
    const hooks = await loadHooks();
    const sentinel = 'synthetic diagnostic value';
    const output = {
      output: JSON.stringify({
        name: 'api',
        pid: 123,
        env: { CUSTOM_SETTING: sentinel },
        headers: { Authorization: sentinel, 'X-Request-Id': 'request-1' },
      }),
      metadata: { headers: { authorization: sentinel } },
    };
    await hooks['tool.execute.after']({ tool: 'bash' }, output);
    expect(JSON.stringify(output).includes(sentinel)).toBe(false);
    expect(output.output.includes('request-1')).toBe(true);
    expect(output.output.includes('123')).toBe(true);
  });

  it('sanitizes actual shell output from a synthetic environment file with arbitrary names', async () => {
    const hooks = await loadHooks();
    const sentinel = 'synthetic environment fixture value';
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      `CUSTOM_SETTING=${sentinel}\nexport another_setting="${sentinel}\ncontinued fixture"\n`,
      'utf8',
    );
    const command = 'cat .env';
    await hooks['tool.execute.before']({ tool: 'bash' }, { args: { command } });
    const output = {
      output: execFileSync('bash', ['-c', command], {
        cwd: tempDir,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      }),
      metadata: { exitCode: 0 },
    };
    await hooks['tool.execute.after']({ tool: 'bash' }, output);
    expect(output.output.includes(sentinel)).toBe(false);
    expect(output.output.includes('continued fixture')).toBe(false);
    expect(output.output.includes('CUSTOM_SETTING=')).toBe(true);
    expect(output.metadata.exitCode).toBe(0);
  });

  it('sanitizes numbered diagnostic output from a synthetic environment fixture', async () => {
    const hooks = await loadHooks();
    const sentinel = 'synthetic environment fixture value';
    const output = {
      output: `     1\tCUSTOM_SETTING=${sentinel}\n     2\texport another_setting="${sentinel}\ncontinued fixture"\n`,
      metadata: { exitCode: 0 },
    };
    await hooks['tool.execute.after']({ tool: 'bash' }, output);
    expect(output.output.includes(sentinel)).toBe(false);
    expect(output.output.includes('continued fixture')).toBe(false);
    expect(output.output.includes('CUSTOM_SETTING=')).toBe(true);
    expect(output.metadata.exitCode).toBe(0);
  });

  it('redacts lowercase process environment entries from synthetic diagnostic JSON', async () => {
    const hooks = await loadHooks();
    const sentinel = 'synthetic environment fixture value';
    const output = {
      output: JSON.stringify({
        pid: 123,
        pm2_env: { custom_setting: sentinel, status: 'online' },
      }),
    };
    await hooks['tool.execute.after']({ tool: 'bash' }, output);
    expect(output.output.includes(sentinel)).toBe(false);
    expect(output.output.includes('online')).toBe(true);
  });

  it.each(['pm2 jlist', 'printenv', 'pm2 --silent jlist'])(
    'blocks value-dumping diagnostics: %s',
    async (command) => {
      const hooks = await loadHooks();
      await expect(
        hooks['tool.execute.before']({ tool: 'bash' }, { args: { command } }),
      ).rejects.toThrow('metadata');
    },
  );
});
