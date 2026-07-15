/**
 * Per-project Docker log files.
 *
 * Each Docker project gets a well-known log file (see
 * `getDockerProjectLogFilePath`) containing Compose startup output, failure
 * diagnostics, and a live `docker compose logs --follow` stream, so the web
 * Logs panel and the agent can follow container output without shelling into
 * the sandbox.
 */

import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';

import { execa } from 'execa';

import {
  DOCKER_PROJECT_LOGS_DIR,
  getDockerProjectLogFilePath,
} from '@roomote/types';

export async function appendDockerProjectLog(
  projectName: string,
  text: string,
): Promise<void> {
  try {
    await fs.mkdir(DOCKER_PROJECT_LOGS_DIR, { recursive: true });
    await fs.appendFile(
      getDockerProjectLogFilePath(projectName),
      `${text}\n`,
      'utf8',
    );
  } catch {
    // The log file is a debugging aid for the Logs panel; failing to write it
    // must never affect Docker project startup.
  }
}

/**
 * Stream container logs into the project's log file. Runs detached for the
 * lifetime of the sandbox; only containers that exist when it starts are
 * followed.
 */
export async function startDockerProjectLogFollower({
  projectName,
  composeArgs,
  cwd,
  env,
}: {
  projectName: string;
  composeArgs: string[];
  cwd: string;
  env: Record<string, string>;
}): Promise<void> {
  const logFilePath = getDockerProjectLogFilePath(projectName);

  try {
    const logStream = createWriteStream(logFilePath, { flags: 'a' });
    await new Promise<void>((resolve, reject) => {
      logStream.once('open', () => resolve());
      logStream.once('error', reject);
    });

    const subprocess = execa(
      'docker',
      [...composeArgs, 'logs', '--follow', '--no-color', '--timestamps'],
      {
        cwd,
        env,
        extendEnv: false,
        detached: true,
        reject: false,
        stdin: 'ignore',
        // The stream has an underlying file descriptor, so execa hands it to
        // the child directly — no pumping through this process.
        stdout: logStream,
        stderr: logStream,
      },
    );
    subprocess.unref();
  } catch (error) {
    await appendDockerProjectLog(
      projectName,
      `[roomote] Failed to start log follower: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
