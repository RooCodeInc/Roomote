#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const separatorIndex = args.indexOf('--');

if (separatorIndex === -1) {
  console.error(
    '[run-with-app-env] Expected "--" before the command to execute.',
  );

  process.exit(1);
}

const options = args.slice(0, separatorIndex);
const command = args.slice(separatorIndex + 1);

if (command.length === 0) {
  console.error('[run-with-app-env] No command provided.');
  process.exit(1);
}

const defaultEnvIndex = options.indexOf('--default-env');

const defaultEnv =
  defaultEnvIndex >= 0 && options[defaultEnvIndex + 1]
    ? options[defaultEnvIndex + 1]
    : 'production';

const resolveAppEnv = () => {
  for (const value of [process.env.APP_ENV, process.env.ROOMOTE_APP_ENV]) {
    switch ((value ?? '').trim().toLowerCase()) {
      case 'development':
        return 'development';
      case 'preview':
        return 'preview';
      case 'production':
        return 'production';
      default:
        break;
    }
  }

  return defaultEnv;
};

const appEnv = resolveAppEnv();

const envFiles = [`.env.${appEnv}`, `../../.env.${appEnv}`].filter((path) =>
  existsSync(new URL(path, `file://${process.cwd()}/`)),
);

const dotenvxPackageJsonPath = require.resolve('@dotenvx/dotenvx/package.json');

const { bin: dotenvxBin } = require(dotenvxPackageJsonPath);

const dotenvxCliPath = resolve(
  dirname(dotenvxPackageJsonPath),
  typeof dotenvxBin === 'string' ? dotenvxBin : dotenvxBin.dotenvx,
);

const result = spawnSync(
  process.execPath,
  [
    dotenvxCliPath,
    'run',
    ...envFiles.flatMap((path) => ['-f', path]),
    '--',
    ...command,
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, APP_ENV: appEnv },
  },
);

if (result.error) {
  console.error('[run-with-app-env] Failed to launch command:', result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
