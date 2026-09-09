import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    R_FAST_BROWSER_PROVIDER: undefined as string | undefined,
    R_BROWSER_USE_API_KEY: undefined as string | undefined,
    R_AGENT_BROWSER_PATH: undefined as string | undefined,
  },
}));

vi.mock('@roomote/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/env')>()),
  Env: mocks.env,
}));

import {
  type BrowseExec,
  fastAgentBrowserSessionName,
  isFastAgentBrowserEnabled,
  runBrowseCommand,
  tokenizeBrowseCommand,
  validateBrowseCommand,
} from '../fast-agent-browser';

function ok(data: unknown) {
  return {
    stdout: JSON.stringify({ success: true, data, error: null }),
    stderr: '',
    code: 0,
  };
}

function validated(command: string) {
  const result = validateBrowseCommand(command);
  if ('error' in result) throw new Error(result.error);
  return result;
}

beforeEach(() => {
  mocks.env.R_FAST_BROWSER_PROVIDER = 'browseruse';
  mocks.env.R_BROWSER_USE_API_KEY = 'bu-secret';
  mocks.env.R_AGENT_BROWSER_PATH = undefined;
});

describe('tokenizeBrowseCommand', () => {
  it.each([
    ['open https://example.com', ['open', 'https://example.com']],
    ['fill @e2 "hello world"', ['fill', '@e2', 'hello world']],
    ['type @e1 "it\'s"', ['type', '@e1', "it's"]],
    ['press Control+a', ['press', 'Control+a']],
    ['eval "document.title + \\"!\\""', ['eval', 'document.title + "!"']],
    ['  snapshot   -i  -c ', ['snapshot', '-i', '-c']],
  ])('splits %j', (input, expected) => {
    expect(tokenizeBrowseCommand(input)).toEqual({ tokens: expected });
  });

  it('rejects unterminated quotes', () => {
    expect(tokenizeBrowseCommand('fill @e2 "oops')).toEqual({
      error: 'Unterminated " quote in command.',
    });
  });
});

describe('validateBrowseCommand', () => {
  it('accepts allowlisted subcommands with their arguments', () => {
    expect(validateBrowseCommand('snapshot -i')).toEqual({
      subcommand: 'snapshot',
      tokens: ['snapshot', '-i'],
    });
    expect(validateBrowseCommand('record start https://example.com')).toEqual({
      subcommand: 'record',
      tokens: ['record', 'start', 'https://example.com'],
    });
  });

  it.each([
    ['', 'Command is empty.'],
    ['--json open x', 'Start with a subcommand'],
    ['agent-browser open x', 'Omit the agent-browser program name'],
    ['install', 'Subcommand install is not available'],
    ['connect 9222', 'Subcommand connect is not available'],
    ['upload @e1 /etc/passwd', 'Subcommand upload is not available'],
    ['open x --session other', '--session is managed by Roomote'],
    ['open x --session=other', '--session is managed by Roomote'],
    ['open x -p browserbase', '-p is managed by Roomote'],
    ['open x --executable-path /bin/sh', '--executable-path is managed'],
    ['open x --profile ~/.chrome', '--profile is managed by Roomote'],
    ['open x --cdp 9222', '--cdp is managed by Roomote'],
    ['screenshot /tmp/out.png', 'screenshot takes no path here'],
    ['record start /tmp/x.webm', 'record start takes no path here'],
    ['record pause', 'record takes start or stop.'],
    ['close --all', 'close --all is not available'],
  ])('refuses %j', (input, message) => {
    const result = validateBrowseCommand(input);
    expect('error' in result && result.error).toContain(message);
  });
});

describe('runBrowseCommand', () => {
  it('refuses to run without a configured provider', async () => {
    mocks.env.R_FAST_BROWSER_PROVIDER = undefined;
    expect(isFastAgentBrowserEnabled()).toBe(false);
    const exec = vi.fn<BrowseExec>();
    await expect(
      runBrowseCommand({
        conversationId: 'conv-1',
        command: validated('open https://example.com'),
        exec,
      }),
    ).resolves.toEqual({
      success: false,
      data: null,
      error: 'Browser access is not configured for this deployment.',
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('treats browseruse without a key as disabled', () => {
    mocks.env.R_BROWSER_USE_API_KEY = undefined;
    expect(isFastAgentBrowserEnabled()).toBe(false);
  });

  it('runs the CLI with a per-conversation session and only the provider key in its environment', async () => {
    const exec = vi.fn<BrowseExec>(async () =>
      ok({ lifecycle: { launched: true }, url: 'https://example.com/' }),
    );
    const result = await runBrowseCommand({
      conversationId: 'conv-1',
      command: validated('open https://example.com'),
      exec,
    });
    expect(result).toEqual({
      success: true,
      data: { url: 'https://example.com/' },
      error: null,
    });
    const session = fastAgentBrowserSessionName('conv-1');
    expect(session).toMatch(/^roomote-fast-[0-9a-f]{16}$/u);
    expect(session).not.toContain('conv-1');
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      'agent-browser',
      ['--session', session, '--json', 'open', 'https://example.com'],
      expect.objectContaining({
        env: expect.objectContaining({
          AGENT_BROWSER_PROVIDER: 'browseruse',
          BROWSER_USE_API_KEY: 'bu-secret',
          AGENT_BROWSER_HEADED: 'false',
        }),
        timeout: 90_000,
      }),
    );
    const env = exec.mock.calls[0]![2].env;
    expect(Object.keys(env)).not.toContain('DATABASE_URL');
    expect(Object.keys(env)).not.toContain('R_BROWSER_USE_API_KEY');
  });

  it('honours an explicit CLI path', async () => {
    mocks.env.R_AGENT_BROWSER_PATH = '/opt/agent-browser/bin/agent-browser';
    const exec = vi.fn<BrowseExec>(async () => ok({}));
    await runBrowseCommand({
      conversationId: 'conv-1',
      command: validated('get url'),
      exec,
    });
    expect(exec.mock.calls[0]![0]).toBe('/opt/agent-browser/bin/agent-browser');
  });

  it('surfaces CLI failures from JSON or stderr', async () => {
    const exec = vi
      .fn<BrowseExec>()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          success: false,
          data: null,
          error: 'Unknown ref: e99',
        }),
        stderr: '',
        code: 1,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: 'boom', code: 2 });
    await expect(
      runBrowseCommand({
        conversationId: 'c',
        command: validated('click @e99'),
        exec,
      }),
    ).resolves.toEqual({
      success: false,
      data: null,
      error: 'Unknown ref: e99',
    });
    await expect(
      runBrowseCommand({
        conversationId: 'c',
        command: validated('click @e99'),
        exec,
      }),
    ).resolves.toEqual({ success: false, data: null, error: 'boom' });
  });

  it('captures screenshots into a control-plane temp file and returns the bytes', async () => {
    const png = Buffer.from('png-bytes');
    const exec = vi.fn<BrowseExec>(async (_file, args) => {
      const path = args[4]!;
      expect(args.slice(0, 4)).toEqual([
        '--session',
        fastAgentBrowserSessionName('conv-2'),
        '--json',
        'screenshot',
      ]);
      expect(path).toContain(join(tmpdir(), 'roomote-fast-browse'));
      expect(args.slice(5)).toEqual(['--full']);
      await mkdir(join(tmpdir(), 'roomote-fast-browse'), { recursive: true });
      await writeFile(path, png);
      return ok({ path });
    });
    const result = await runBrowseCommand({
      conversationId: 'conv-2',
      command: validated('screenshot --full'),
      exec,
    });
    expect(result).toEqual({
      success: true,
      data: null,
      error: null,
      capture: { kind: 'screenshot', contentType: 'image/png', bytes: png },
    });
  });

  it('records into a per-session file and returns it on stop', async () => {
    const webm = Buffer.from('webm-bytes');
    let recordingPath: string | undefined;
    const exec = vi.fn<BrowseExec>(async (_file, args) => {
      if (args[4] === 'start') {
        recordingPath = args[5];
        expect(recordingPath).toMatch(/-recording\.webm$/u);
        expect(args.slice(6)).toEqual(['https://example.com']);
        return ok({ recording: true });
      }
      expect(args.slice(3)).toEqual(['record', 'stop']);
      await writeFile(recordingPath!, webm);
      return ok({ saved: true });
    });
    await runBrowseCommand({
      conversationId: 'conv-3',
      command: validated('record start https://example.com'),
      exec,
    });
    const result = await runBrowseCommand({
      conversationId: 'conv-3',
      command: validated('record stop'),
      exec,
    });
    expect(result).toEqual({
      success: true,
      data: null,
      error: null,
      capture: { kind: 'recording', contentType: 'video/webm', bytes: webm },
    });
  });
});
