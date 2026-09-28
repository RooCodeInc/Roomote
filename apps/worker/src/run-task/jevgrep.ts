import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import {
  buildInferenceGatewayUrl,
  resolveWorkerRuntimePaths,
} from '@roomote/types';
import { sdk } from '@roomote/sdk/client';
import { resolveNpmInstallCommand } from '../commands/setup/npm-install-command';
import { startJevgrepProxy } from './jevgrep-proxy';

const JEVGREP_VERSION = '0.4.3';

/** Share task-scoped CLI access without exposing the rest of the harness env. */
export function buildJevgrepTerminalEnv(
  userEnv: Record<string, string>,
  runtimeEnv: Record<string, string>,
  homeDir: string,
): Record<string, string> {
  const env = { ...userEnv };
  for (const key of [
    'ROOMOTE_CLOUD_TOKEN',
    'ROOMOTE_AUTH_BYPASS_HEADER_NAME',
    'ROOMOTE_AUTH_BYPASS_VALUE',
  ]) {
    delete env[key];
  }
  delete env.R_JEVGREP_GATEWAY_URL;
  if (!runtimeEnv.R_JEVGREP_GATEWAY_URL) return env;
  env.R_JEVGREP_GATEWAY_URL = runtimeEnv.R_JEVGREP_GATEWAY_URL;
  env.PATH = [path.join(homeDir, '.roomote/jevgrep/bin'), userEnv.PATH]
    .filter(Boolean)
    .join(path.delimiter);
  return env;
}

/** This adapter runs only inside jg, never in the worker or other task tools.
 * Upstream has no endpoint override. Its saved key is a dummy value; only the
 * exact TypeSafe evaluation endpoint is replaced with our run-authenticated
 * gateway. Keep this contract tested against the pinned CLI version.
 */
function buildJevgrepLauncher(binaryPath: string, configHome: string): string {
  // Use the worker's Node runtime even when the repository selects an older
  // Node version through mise. Jevgrep requires Node 22 or newer.
  return `#!${process.execPath}
const upstreamFetch = globalThis.fetch;
const endpoint = process.env.R_JEVGREP_GATEWAY_URL;
if (!endpoint) throw new Error('Jevgrep is not enabled for this task.');
if (['auth', 'skill'].includes(process.argv[2])) {
  console.error('Roomote manages Jevgrep setup through Settings > Models.');
  process.exit(1);
}
process.env.XDG_CONFIG_HOME = ${JSON.stringify(configHome)};
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== 'https://api.typesafe.ai/v1/systemone') return upstreamFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.delete('x-api-key');
  headers.delete('authorization');
  return upstreamFetch(endpoint, { ...init, headers, redirect: 'error' });
};
await import(${JSON.stringify(pathToFileURL(binaryPath).href)});
`;
}

async function installJevgrep(): Promise<string> {
  // A separate prefix prevents npm from pruning the other runtime packages.
  const { sandboxRootDir } = resolveWorkerRuntimePaths({
    existsSync: fs.existsSync,
  });
  const root = path.join(sandboxRootDir, 'jevgrep-cli');
  const packageRoot = path.join(root, 'node_modules', '@dzhng', 'jevgrep');
  const binary = path.join(packageRoot, 'dist', 'bin', 'index.js');
  let installed = false;
  try {
    installed =
      JSON.parse(
        fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
      ).version === JEVGREP_VERSION && fs.existsSync(binary);
  } catch {
    // Missing or incomplete installation.
  }
  if (!installed) {
    const npm = await resolveNpmInstallCommand();
    await execa(
      npm.command,
      [
        ...npm.argsPrefix,
        'install',
        '--prefix',
        root,
        '--no-save',
        '--no-package-lock',
        `@dzhng/jevgrep@${JEVGREP_VERSION}`,
      ],
      { stdin: 'ignore', timeout: 120_000 },
    );
  }
  return binary;
}

export async function setupJevgrep(options: {
  runId: number;
  homeDir: string;
  trpcUrl: string;
  runtimeEnv: Record<string, string>;
  logger: Pick<Console, 'warn'>;
  registerCleanup: (close: () => Promise<void>) => void;
}): Promise<boolean> {
  const { runtimeEnv, homeDir } = options;
  delete runtimeEnv.R_JEVGREP_GATEWAY_URL;
  if (!homeDir) return false;
  const root = path.join(homeDir, '.roomote', 'jevgrep');
  const binDir = path.join(root, 'bin');
  runtimeEnv.PATH = (runtimeEnv.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry !== binDir)
    .join(path.delimiter);
  try {
    // Clear stale snapshot setup even when Jev has since been disabled.
    fs.rmSync(root, { recursive: true, force: true });
    if (!(await sdk.taskRuns.isJevgrepEnabled({ runId: options.runId })))
      return false;
    const binary = await installJevgrep();
    const configHome = path.join(root, 'config');
    const credentialsDir = path.join(configHome, 'jevgrep');
    fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialsDir, 'credentials.json'),
      JSON.stringify({ provider: 'typesafe', apiKey: 'roomote-managed' }),
      { mode: 0o600 },
    );
    // .mjs ensures ESM even when the task repository uses CommonJS.
    const launcher = path.join(root, 'launcher.mjs');
    fs.writeFileSync(launcher, buildJevgrepLauncher(binary, configHome), {
      mode: 0o755,
    });
    fs.symlinkSync(launcher, path.join(binDir, 'jg'));
    if (!runtimeEnv.ROOMOTE_CLOUD_TOKEN) throw new Error('Missing run auth');
    const proxy = await startJevgrepProxy({
      endpoint: `${buildInferenceGatewayUrl(options.trpcUrl)}/jevgrep/v1/systemone`,
      token: runtimeEnv.ROOMOTE_CLOUD_TOKEN,
      bypassHeader: runtimeEnv.ROOMOTE_AUTH_BYPASS_HEADER_NAME,
      bypassValue: runtimeEnv.ROOMOTE_AUTH_BYPASS_VALUE,
    });
    options.registerCleanup(proxy.close);
    runtimeEnv.R_JEVGREP_GATEWAY_URL = proxy.endpoint;
    runtimeEnv.PATH = [binDir, runtimeEnv.PATH]
      .filter(Boolean)
      .join(path.delimiter);
    return true;
  } catch {
    // Optional context collection must not stop a task or leak auth diagnostics.
    options.logger.warn(
      '[runTask] Jevgrep setup unavailable; using ordinary code search.',
    );
    return false;
  }
}
