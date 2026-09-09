import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Env } from '@roomote/env';

/**
 * Fast `browse` tool runtime.
 *
 * A Session gets a private browser without a sandbox: the api process runs
 * the agent-browser CLI with a per-conversation session name, and the CLI
 * talks to a cloud browser (Browser Use) over CDP. The model only ever sees
 * the CLI's JSON output, never the provider key or the host filesystem.
 *
 * The model hands over one agent-browser command line per call. The command
 * is tokenized here (no shell), the subcommand is checked against an
 * allowlist, and flags that would let a command pick a different session,
 * browser binary, profile, provider, or host file are refused.
 */

const FAST_AGENT_BROWSER_COMMAND_TIMEOUT_MS = 90_000;
const FAST_AGENT_BROWSER_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Cloud browsers bill while open; drop an untouched session after this. */
const FAST_AGENT_BROWSER_IDLE_TIMEOUT_MS = 10 * 60_000;
const FAST_AGENT_BROWSER_SESSION_PREFIX = 'roomote-fast-';
const FAST_AGENT_BROWSER_SCREENSHOT_ROOT = join(
  tmpdir(),
  'roomote-fast-browse',
);

/**
 * Subcommands the model may run. Everything that reads or writes host files,
 * attaches to other browsers, or manages the daemon itself is left out.
 */
const FAST_AGENT_BROWSER_ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'open',
  'back',
  'forward',
  'reload',
  'snapshot',
  'read',
  'get',
  'is',
  'find',
  'click',
  'dblclick',
  'hover',
  'focus',
  'fill',
  'type',
  'press',
  'check',
  'uncheck',
  'select',
  'scroll',
  'scrollintoview',
  'wait',
  'screenshot',
  'record',
  'eval',
  'tab',
  'set',
  'cookies',
  'storage',
  'console',
  'errors',
  'close',
]);

/**
 * Global flags refused anywhere on the line. Each one would let a command
 * escape its own session: reach another session's browser, attach to an
 * arbitrary CDP endpoint, launch a host binary, load host files or
 * extensions, or switch cloud providers.
 */
const FAST_AGENT_BROWSER_DENIED_FLAGS: ReadonlySet<string> = new Set([
  '--session',
  '--session-name',
  '--profile',
  '--state',
  '--restore',
  '--save',
  '--cdp',
  '--auto-connect',
  '--executable-path',
  '--extension',
  '--args',
  '--config',
  '--provider',
  '-p',
  '--engine',
  '--headed',
  '--proxy',
  '--proxy-bypass',
  '--download-path',
  '--allow-file-access',
  '--screenshot-dir',
  '--screenshot-format',
]);

type FastAgentBrowserProvider = 'browseruse' | 'local';

function resolveFastAgentBrowserProvider(): FastAgentBrowserProvider | null {
  const provider = Env.R_FAST_BROWSER_PROVIDER;
  if (provider === 'browseruse') {
    return Env.R_BROWSER_USE_API_KEY ? 'browseruse' : null;
  }
  if (provider === 'local') return 'local';
  return null;
}

export function isFastAgentBrowserEnabled(): boolean {
  return resolveFastAgentBrowserProvider() !== null;
}

/** Stable, opaque session name so one conversation never sees another's tabs. */
export function fastAgentBrowserSessionName(conversationId: string): string {
  return `${FAST_AGENT_BROWSER_SESSION_PREFIX}${createHash('sha256')
    .update(conversationId)
    .digest('hex')
    .slice(0, 16)}`;
}

/**
 * POSIX-ish tokenizer: whitespace splits, single and double quotes group,
 * backslash escapes inside double quotes and outside quotes. No expansion of
 * any kind, so nothing here ever reaches a shell.
 */
export function tokenizeBrowseCommand(
  command: string,
): { tokens: string[] } | { error: string } {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && index + 1 < command.length) {
        index += 1;
        current += command[index]!;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      index += 1;
      current += command[index]!;
      inToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += char;
    inToken = true;
  }
  if (quote) return { error: `Unterminated ${quote} quote in command.` };
  if (inToken) tokens.push(current);
  return { tokens };
}

type ValidatedBrowseCommand = {
  subcommand: string;
  tokens: string[];
};

export function validateBrowseCommand(
  command: string,
): ValidatedBrowseCommand | { error: string } {
  const tokenized = tokenizeBrowseCommand(command);
  if ('error' in tokenized) return tokenized;
  const { tokens } = tokenized;
  if (tokens.length === 0) return { error: 'Command is empty.' };
  const subcommand = tokens[0]!;
  if (subcommand.startsWith('-')) {
    return {
      error: `Start with a subcommand, not a flag: got ${subcommand}.`,
    };
  }
  if (subcommand === 'agent-browser') {
    return {
      error:
        'Omit the agent-browser program name; pass only the subcommand and its arguments.',
    };
  }
  if (!FAST_AGENT_BROWSER_ALLOWED_SUBCOMMANDS.has(subcommand)) {
    return {
      error: `Subcommand ${subcommand} is not available here. Allowed: ${[
        ...FAST_AGENT_BROWSER_ALLOWED_SUBCOMMANDS,
      ].join(', ')}.`,
    };
  }
  for (const token of tokens) {
    const flag = token.includes('=')
      ? token.slice(0, token.indexOf('='))
      : token;
    if (FAST_AGENT_BROWSER_DENIED_FLAGS.has(flag)) {
      return {
        error: `${flag} is managed by Roomote and cannot be set from a command.`,
      };
    }
  }
  if (subcommand === 'screenshot') {
    // Only flags may follow `screenshot`; the output path is ours.
    const positional = tokens.slice(1).filter((t) => !t.startsWith('-'));
    if (positional.length > 0) {
      return {
        error:
          'screenshot takes no path here; the capture is described for you through the question argument.',
      };
    }
  }
  if (subcommand === 'record') {
    const action = tokens[1];
    if (action !== 'start' && action !== 'stop') {
      return { error: 'record takes start or stop.' };
    }
    if (action === 'start') {
      // `record start <path> [url]`: the path is ours, so only a URL may follow.
      const positional = tokens.slice(2).filter((t) => !t.startsWith('-'));
      if (
        positional.length > 1 ||
        (positional.length === 1 && !/^https?:\/\//u.test(positional[0]!))
      ) {
        return {
          error:
            'record start takes no path here; pass at most a URL to open first. The recording is saved as an artifact on record stop.',
        };
      }
    }
  }
  if (subcommand === 'close' && tokens.includes('--all')) {
    return { error: 'close --all is not available; close only this session.' };
  }
  return { subcommand, tokens };
}

type BrowseCommandResult = {
  success: boolean;
  data: unknown;
  error: string | null;
};

export type BrowseExec = (
  file: string,
  args: string[],
  options: {
    env: Record<string, string | undefined>;
    timeout: number;
    maxBuffer: number;
  },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

const defaultExec: BrowseExec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        env: options.env as NodeJS.ProcessEnv,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const errorCode = (error as { code?: unknown } | null)?.code;
        const code = error
          ? typeof errorCode === 'number'
            ? errorCode
            : 1
          : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });

function buildBrowserEnv(
  provider: FastAgentBrowserProvider,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    // A minimal environment: the CLI needs PATH to find nothing but itself,
    // HOME for its socket and cache directory. No inherited secrets.
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    AGENT_BROWSER_HEADED: 'false',
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(FAST_AGENT_BROWSER_IDLE_TIMEOUT_MS),
  };
  if (provider === 'browseruse') {
    env.AGENT_BROWSER_PROVIDER = 'browseruse';
    env.BROWSER_USE_API_KEY = Env.R_BROWSER_USE_API_KEY;
  } else if (process.env.AGENT_BROWSER_EXECUTABLE_PATH) {
    env.AGENT_BROWSER_EXECUTABLE_PATH =
      process.env.AGENT_BROWSER_EXECUTABLE_PATH;
  }
  return env;
}

function parseBrowseOutput(
  stdout: string,
  stderr: string,
  code: number | null,
): BrowseCommandResult {
  const trimmed = stdout.trim();
  if (trimmed.length > 0) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<BrowseCommandResult>;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'success' in parsed
      ) {
        return {
          success: Boolean(parsed.success),
          data: stripLifecycle(parsed.data),
          error: typeof parsed.error === 'string' ? parsed.error : null,
        };
      }
    } catch {
      // Fall through: not JSON.
    }
  }
  if (code === 0) return { success: true, data: trimmed || null, error: null };
  const detail = (
    stderr.trim() ||
    trimmed ||
    `exit code ${code ?? 'unknown'}`
  ).slice(0, 2_000);
  return { success: false, data: null, error: detail };
}

/** The CLI's launch bookkeeping is noise to the model; drop it. */
function stripLifecycle(data: unknown): unknown {
  if (typeof data === 'object' && data !== null && 'lifecycle' in data) {
    const { lifecycle: _lifecycle, ...rest } = data as Record<string, unknown>;
    return rest;
  }
  return data;
}

type RunBrowseCommandInput = {
  conversationId: string;
  command: ValidatedBrowseCommand;
  exec?: BrowseExec;
};

type BrowseCapture = {
  kind: 'screenshot' | 'recording';
  contentType: 'image/png' | 'video/webm';
  bytes: Buffer;
};

type RunBrowseCommandOutput = BrowseCommandResult & {
  /** Captured media when the command was `screenshot` or `record stop`. */
  capture?: BrowseCapture;
};

function recordingPath(session: string): string {
  return join(FAST_AGENT_BROWSER_SCREENSHOT_ROOT, `${session}-recording.webm`);
}

export async function runBrowseCommand(
  input: RunBrowseCommandInput,
): Promise<RunBrowseCommandOutput> {
  const provider = resolveFastAgentBrowserProvider();
  if (!provider) {
    return {
      success: false,
      data: null,
      error: 'Browser access is not configured for this deployment.',
    };
  }
  const exec = input.exec ?? defaultExec;
  const session = fastAgentBrowserSessionName(input.conversationId);
  const { subcommand, tokens } = input.command;
  const args = ['--session', session, '--json', ...tokens];
  // Captures land in a control-plane temp file the model never names; the
  // handler turns the bytes into a Session artifact and the file is removed.
  let capturePath: string | null = null;
  let captureKind: BrowseCapture['kind'] | null = null;
  if (subcommand === 'screenshot') {
    await mkdir(FAST_AGENT_BROWSER_SCREENSHOT_ROOT, { recursive: true });
    capturePath = join(
      FAST_AGENT_BROWSER_SCREENSHOT_ROOT,
      `${session}-${Date.now()}.png`,
    );
    captureKind = 'screenshot';
    // `screenshot [path] [flags]`: the path goes right after the subcommand.
    args.splice(4, 0, capturePath);
  } else if (subcommand === 'record' && tokens[1] === 'start') {
    await mkdir(FAST_AGENT_BROWSER_SCREENSHOT_ROOT, { recursive: true });
    await rm(recordingPath(session), { force: true }).catch(() => undefined);
    // `record start <path> [url]`: the path goes right after `start`.
    args.splice(5, 0, recordingPath(session));
  } else if (subcommand === 'record' && tokens[1] === 'stop') {
    capturePath = recordingPath(session);
    captureKind = 'recording';
  }
  const { stdout, stderr, code } = await exec(
    Env.R_AGENT_BROWSER_PATH ?? 'agent-browser',
    args,
    {
      env: buildBrowserEnv(provider),
      timeout: FAST_AGENT_BROWSER_COMMAND_TIMEOUT_MS,
      maxBuffer: FAST_AGENT_BROWSER_MAX_OUTPUT_BYTES,
    },
  );
  const result = parseBrowseOutput(stdout, stderr, code);
  if (!capturePath || !captureKind) return result;
  try {
    if (!result.success) return result;
    const bytes = await readFile(capturePath);
    return {
      ...result,
      data: null,
      capture: {
        kind: captureKind,
        contentType: captureKind === 'screenshot' ? 'image/png' : 'video/webm',
        bytes,
      },
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: `${captureKind === 'screenshot' ? 'Screenshot' : 'Recording'} file could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await rm(capturePath, { force: true }).catch(() => undefined);
  }
}
