import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { guardCuaDriverRequest, readHumanControlState } from './guard';

const binary = process.env.ROOMOTE_CUA_DRIVER_BINARY;
const manifestPath = process.env.ROOMOTE_CUA_DRIVER_MANIFEST_PATH;
const humanControlUrl = process.env.ROOMOTE_CUA_DRIVER_HUMAN_CONTROL_URL;

if (!binary || !manifestPath || !humanControlUrl) {
  console.error('cua-driver proxy: missing required runtime configuration');
  process.exit(1);
}

const childEnv: Record<string, string> = {
  ...Object.fromEntries(
    [
      'AT_SPI_BUS_ADDRESS',
      'DBUS_SESSION_BUS_ADDRESS',
      'DISPLAY',
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'XAUTHORITY',
      'XDG_RUNTIME_DIR',
    ].flatMap((name) =>
      process.env[name] ? [[name, process.env[name]!]] : [],
    ),
  ),
  CUA_DRIVER_PERMISSION_MODE: 'bounded',
  CUA_DRIVER_CAPABILITY_MANIFEST_FILE: manifestPath,
  CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: '1',
};

const driver = spawn(binary, ['mcp'], {
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
});

driver.stdout.pipe(process.stdout);
driver.stderr.pipe(process.stderr);

let inputQueue = Promise.resolve();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  inputQueue = inputQueue
    .then(async () => {
      const guarded = await guardCuaDriverRequest(line, () =>
        readHumanControlState(humanControlUrl),
      );
      if (guarded.forward) {
        driver.stdin.write(`${line}\n`);
      } else {
        process.stdout.write(`${guarded.response}\n`);
      }
    })
    .catch((error) => {
      console.error(
        `cua-driver proxy: failed to process request: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
});

input.on('close', () => {
  void inputQueue.finally(() => driver.stdin.end());
});

let stopping = false;
function stopDriver(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  driver.kill(signal);
  const forceKill = setTimeout(() => driver.kill('SIGKILL'), 2_000);
  forceKill.unref();
}

process.once('SIGINT', () => stopDriver('SIGINT'));
process.once('SIGTERM', () => stopDriver('SIGTERM'));

driver.once('error', (error) => {
  console.error(`cua-driver proxy: failed to start Driver: ${error.message}`);
  process.exitCode = 1;
});

driver.once('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
