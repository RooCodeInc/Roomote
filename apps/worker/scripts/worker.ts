#!/usr/bin/env npx tsx
/**
 * Unified worker CLI entry point.
 *
 * Usage:
 *   worker run <cloud-job-id>
 *   worker run-direct <cloud-job-id>
 *   worker resume <cloud-job-id>
 *   worker snapshot --cloud-job-id 123 --environment-id abc --sandbox-id xyz
 *   worker reset-repo [path]
 *   worker service <name> [--port <port>]
 *   worker repo <owner/repo> [--branch <branch>]
 */

import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

import { Command } from 'commander';

import {
  type ServiceName,
  TaskPayloadKind,
  serviceNames,
  PRODUCT_NAME,
} from '@roomote/types';
import { sdk } from '@roomote/sdk/client';

import { WorkerEnv } from '../src/env';
import { createStartupLogger } from '../src/logging';
import {
  captureWorkerException,
  flushWorkerSentry,
  initWorkerSentry,
} from '../src/monitoring/sentry';
import { setup, run, resume, snapshot } from '../src/commands';
import { ServiceManager } from '../src/services';

const program = new Command();
const execFileAsync = promisify(execFile);
void initWorkerSentry();

program
  .name('worker')
  .description(`${PRODUCT_NAME} worker CLI`)
  .version('1.0.0');

program
  .command('run')
  .description('Run a specific cloud job')
  .argument(
    '<cloud-job-id>',
    'The ID of the cloud job to process',
    parseCloudJobId,
  )
  .action(async (cloudJobId: number) => {
    if (!process.env.AUTH_TOKEN) {
      console.error('Unauthorized');
      await flushAndExit(1);
    }

    const success = await run({ cloudJobId, setupMode: 'full' });
    await flushAndExit(success ? 0 : 1);
  });

program
  .command('run-direct')
  .description('Run a direct cloud job inside the current local runtime')
  .argument(
    '<cloud-job-id>',
    'The ID of the cloud job to process',
    parseCloudJobId,
  )
  .option(
    '--keepalive-ms <ms>',
    'Override the post-turn keepalive window in milliseconds',
    parseNonNegativeInteger,
  )
  .action(async (cloudJobId: number, options: { keepaliveMs?: number }) => {
    if (!process.env.AUTH_TOKEN) {
      console.error('Unauthorized');
      await flushAndExit(1);
    }

    const success = await run({
      cloudJobId,
      setupMode: 'directDispatch',
      preserveGitState: false,
      keepaliveMsOverride: options.keepaliveMs,
    });
    await flushAndExit(success ? 0 : 1);
  });

program
  .command('resume')
  .description('Resume a cloud job from snapshot')
  .argument(
    '<cloud-job-id>',
    'The ID of the cloud job to resume',
    parseCloudJobId,
  )
  .action(async (cloudJobId: number) => {
    if (!process.env.AUTH_TOKEN) {
      console.error('Unauthorized');
      await flushAndExit(1);
    }

    const success = await resume(cloudJobId);
    await flushAndExit(success ? 0 : 1);
  });

program
  .command('snapshot')
  .description('Create an environment snapshot')
  .requiredOption(
    '--cloud-job-id <id>',
    'The ID of the cloud job to process',
    parseCloudJobId,
  )
  .requiredOption(
    '--environment-id <id>',
    'The environment ID to prepare for snapshotting',
  )
  .requiredOption('--sandbox-id <id>', 'The current sandbox ID')
  .action(
    async (options: {
      cloudJobId: number;
      environmentId: string;
      sandboxId: string;
    }) => {
      if (!process.env.AUTH_TOKEN) {
        console.error('Not authorized to run snapshot task');
        await flushAndExit(1);
      }

      const success = await snapshot(options);
      await flushAndExit(success ? 0 : 1);
    },
  );

program
  .command('service')
  .description(
    `Install and start a service. Available: ${serviceNames.join(', ')}`,
  )
  .argument('<name>', 'Service name', (value: string): ServiceName => {
    if (!serviceNames.includes(value as ServiceName)) {
      throw new Error(
        `Unknown service: ${value}. Available: ${serviceNames.join(', ')}`,
      );
    }

    return value as ServiceName;
  })
  .option(
    '--port <port>',
    'Custom port (uses default if not specified)',
    parseInt,
  )
  .action(async (name: ServiceName, options: { port?: number }) => {
    const cwd = process.cwd();
    const manager = new ServiceManager(cwd, process.env);

    const logger = createStartupLogger();
    const config = options.port ? { name, port: options.port } : name;
    const services = await manager.startServices(logger, [config]);
    const svc = services[0];

    if (svc) {
      console.log(`\nService ${svc.name} ready:`);
      console.log(`  Host: ${svc.host}:${svc.port}`);
      console.log(`  Connection: ${svc.connectionString}`);

      if (Object.keys(svc.envVars).length > 0) {
        console.log(`  Env vars:`);

        for (const [key, val] of Object.entries(svc.envVars)) {
          console.log(`    ${key}=${val}`);
        }
      }
    } else {
      console.error('Failed to start service');
    }
  });

program
  .command('services')
  .description('List available services')
  .action(() => {
    console.log(`Available services (${serviceNames.length}):\n`);

    for (const name of serviceNames) {
      console.log(`  ${name}`);
    }
  });

program
  .command('repos')
  .description('List available repositories')
  .action(async () => {
    const repos = await sdk.repositories.listRepositories();

    if (repos.length === 0) {
      console.log('No repositories found.');
      return;
    }

    console.log(`Available repositories (${repos.length}):\n`);

    for (const repo of repos) {
      console.log(`  ${repo.fullName}`);

      if (repo.defaultBranch) {
        console.log(`    Default branch: ${repo.defaultBranch}`);
      }
    }
  });

program
  .command('repo')
  .description('Clone and prepare a repository')
  .argument('<name>', 'Repository name (owner/repo format)')
  .option(
    '--branch <branch>',
    'Branch to checkout (defaults to repo default branch)',
  )
  .option(
    '--preserve-git',
    'Preserve git state (skip fetch/reset/checkout)',
    false,
  )
  .action(
    async (
      name: string,
      options: { branch?: string; preserveGit: boolean },
    ) => {
      const { preparedWorkspace } = await setup({
        mode: 'full',
        workspace: {
          workspace: {
            type: 'repository',
            repository: name,
            branch: options.branch,
          },
          envVars: {},
          cloudJobType: TaskPayloadKind.LinearAgentSession,
          preserveGitState: options.preserveGit,
        },
        logger: createStartupLogger(),
        workerEnv: WorkerEnv.fromProcessEnv(process.env),
      });

      const workspacePath = preparedWorkspace?.workspacePath;

      if (!workspacePath) {
        throw new Error('Setup did not return a workspace path');
      }

      console.log(`\nRepository ready: ${workspacePath}`);
    },
  );

program
  .command('reset-repo')
  .description('Reset tracked git changes in a prepared repository')
  .argument('[path]', 'Repository path to reset', process.cwd())
  .option('--clean', 'Remove untracked, non-ignored files after reset', false)
  .action(async (repoPath: string, options: { clean: boolean }) => {
    const resolvedPath = await realpath(repoPath);

    const reset = await execFileAsync('git', ['reset', '--hard', 'HEAD'], {
      cwd: resolvedPath,
    });
    process.stdout.write(reset.stdout);
    process.stderr.write(reset.stderr);

    if (options.clean) {
      const clean = await execFileAsync('git', ['clean', '-fd'], {
        cwd: resolvedPath,
      });
      process.stdout.write(clean.stdout);
      process.stderr.write(clean.stderr);
    }
  });

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

function isIgnorableReadableStreamClosure(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException).code === 'ERR_INVALID_STATE' &&
    error instanceof Error &&
    error.message.includes('Controller is already closed')
  );
}

// Safety net: catch ReadableStream errors that slip through when a tRPC SSE
// subscription stream is closed by the client while the server-side callback
// still tries to push data. Without this, the entire worker process crashes
// and the sandbox becomes unreachable. See CLO-957.
process.on('uncaughtException', (err) => {
  if (isIgnorableReadableStreamClosure(err)) {
    console.warn(
      '[uncaughtException] ReadableStream already closed, ignoring:',
      err.message,
    );

    return;
  }

  console.error('[uncaughtException] Fatal:', err);
  captureWorkerException(err, { stage: 'uncaughtException' });
  void flushAndExit(1);
});

program.parseAsync(process.argv).catch((error) => {
  console.error(
    `Caught error: ${error instanceof Error ? `${error.message}: ${error.stack}` : String(error)}`,
  );

  captureWorkerException(error, { stage: 'program.parseAsync' });
  void flushAndExit(1);
});

process.on('unhandledRejection', (reason) => {
  if (isIgnorableReadableStreamClosure(reason)) {
    console.warn(
      '[unhandledRejection] ReadableStream already closed, ignoring:',
      reason instanceof Error ? reason.message : String(reason),
    );

    return;
  }

  console.error('[unhandledRejection] Fatal:', reason);
  captureWorkerException(reason, { stage: 'unhandledRejection' });
  void flushAndExit(1);
});

function parseCloudJobId(value: string): number {
  const parsed = parseInt(value, 10);

  if (isNaN(parsed) || parsed <= 0) {
    throw new Error('cloud-job-id must be a positive integer');
  }

  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('value must be a non-negative integer');
  }

  return parsed;
}

async function flushAndExit(code: number): Promise<never> {
  try {
    await flushWorkerSentry();
  } finally {
    process.exit(code);
  }
}
