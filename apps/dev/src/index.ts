import { Command } from 'commander';
import { execa } from 'execa';
import ora from 'ora';

import { PRODUCT_NAME } from '@roomote/types';

import type { ScriptOptions } from './types';

import {
  DatabaseService,
  DockerService,
  EnvService,
  NgrokService,
  PM2Service,
  PortService,
  WorkerReleaseService,
  WatchmanService,
} from './services';

// Host port of the local Caddy edge (the `caddy-dev` compose service). The
// public tunnel targets this port so one origin serves the web app and, under
// the reserved /_roomote-api/* prefix, the API — mirroring the production
// routing in deploy/caddy/Caddyfile.
const CADDY_DEV_PORT = 18080;

const DEVELOPMENT_WORKER_IMAGE_REPOSITORY = 'ghcr.io/roocodeinc/roomote-worker';

async function configureHostedDevelopmentWorkerImage(): Promise<void> {
  if (process.env.ROOMOTE_DEVELOPMENT_WORKER_IMAGE_REF) {
    return;
  }

  try {
    const { stdout } = await execa(
      'git',
      ['rev-parse', '--short=8', 'origin/develop'],
      { cwd: process.cwd() },
    );
    const imageRef = `${DEVELOPMENT_WORKER_IMAGE_REPOSITORY}:develop-${stdout.trim()}`;

    process.env.ROOMOTE_DEVELOPMENT_WORKER_IMAGE_REF = imageRef;
    // Modal consumes its base image directly instead of provisioning a named
    // artifact. Preserve an operator override, otherwise pin it to the same
    // immutable development image as E2B, Daytona, and Blaxel.
    process.env.MODAL_BASE_IMAGE_REF ||= imageRef;
  } catch {
    // Source archives and shallow checkouts may not have origin/develop. The
    // shared resolver retains the mutable :develop fallback for those cases.
  }
}

class LocalDevStarter {
  static async run(options: ScriptOptions): Promise<void> {
    try {
      console.info(`🚀 Starting ${PRODUCT_NAME} dev environment`);

      console.info(
        `⚙️ Options -> ${Object.entries(options)
          .map(([key, value]) => `${key}: ${value}`)
          .join(', ')}\n`,
      );

      await EnvService.checkEnvVars();

      await configureHostedDevelopmentWorkerImage();

      await WatchmanService.checkInstalled();
      await PM2Service.checkInstalled();
      await PM2Service.stopServices({
        preserveAutoWebNgrok: true,
      });
      await DockerService.stopSelfHostAppContainers(options.verbose);

      // The tunnel targets the local Caddy edge, which serves the web app
      // and proxies /_roomote-api/* to the API — the same routing deployed
      // environments get from deploy/caddy/Caddyfile.
      const publicUrlResolution = await NgrokService.resolvePublicUrl({
        port: CADDY_DEV_PORT,
        verbose: options.verbose,
      });

      options.autoNgrok = publicUrlResolution.autoNgrok;
      options.publicUrl = publicUrlResolution.publicUrl;
      process.env.R_PUBLIC_URL = publicUrlResolution.publicUrl;
      process.env.R_APP_URL = publicUrlResolution.publicUrl;
      // Match the deployed TRPC_URL contract so hosted compute workers
      // (Vercel Sandbox, Modal, Daytona, E2B) can reach the API through the
      // public app URL instead of an unreachable localhost address.
      process.env.TRPC_URL = `${publicUrlResolution.publicUrl}/_roomote-api`;

      console.info(
        `🌐 Public URL: ${publicUrlResolution.publicUrl}${
          publicUrlResolution.autoNgrok ? ' (auto-started ngrok)' : ''
        } (Caddy edge)\n`,
      );

      await PM2Service.prepareServicesForDev();

      await PortService.checkPorts();

      await DockerService.checkContainers(options.verbose);

      if (options.reset) {
        await DatabaseService.reset(options.verbose);
      } else {
        await DatabaseService.migrate(options.verbose);
      }

      // Build the local worker release archive unless sandbox mode should
      // use the GitHub worker release instead.
      if (!options.useRelease) {
        await WorkerReleaseService.build(options);
      }

      if ((process.env.DEFAULT_COMPUTE_PROVIDER ?? 'docker') === 'docker') {
        await DockerService.ensureWorkerImage(options.verbose);
      }

      await PM2Service.startServices(options);
      await PM2Service.validateServices(options);

      console.info(
        '\n✅ All services validated and running successfully!\n\n' +
          'Use the following commands to manage services:\n' +
          '  • pm2 status                 - Check service statuses\n' +
          '  • pm2 dashboard              - View service dashboard\n' +
          '  • pm2 logs                   - View all service logs\n' +
          '  • pm2 logs roomote-web   - View web logs\n' +
          '  • pm2 restart roomote-web - Restart the web service\n' +
          '  • pm2 delete roomote-api roomote-web roomote-preview-proxy roomote-bullmq roomote-controller roomote-worker-release-watcher - Stop Roomote services\n',
      );

      process.exit(0);
    } catch (error) {
      console.error('\nFailed to start local development environment.\n');
      console.error(error instanceof Error ? error.message : String(error));
      console.error('\nPlease check the error messages above and try again.');
      process.exit(1);
    }
  }
}

process.on('SIGINT', async () => {
  const stopServices = ora('Stopping services').start();
  await PM2Service.stopServices();
  stopServices.succeed();
  process.exit(0);
});

function parseArguments(): ScriptOptions {
  const program = new Command();

  program
    .name('dev')
    .description('Start Roomote local development environment')
    .version('1.0.0')
    .option('--reset', 'Reset the database before starting services', false)
    .option('--verbose', 'Enable verbose output with stdio logging', false)
    .option(
      '--skip-worker-release-build',
      'Skip building the worker release archive (reuse existing)',
      false,
    )
    .option(
      '--use-release',
      'Use GitHub release artifacts where supported',
      false,
    )
    .option(
      '--worker-release-channel <channel>',
      'GitHub worker release channel to use with --use-release (stable or preview)',
      'stable',
    )
    .option(
      '--worker-release-version <version>',
      'Pin a specific GitHub worker release version when --use-release is enabled',
    )
    .allowExcessArguments()
    .addHelpText(
      'after',
      `
Usage:
  pnpm dev [--reset] [--verbose] [--skip-worker-release-build] [--use-release] [--worker-release-channel stable|preview] [--worker-release-version X.Y.Z]`,
    );

  program.parse(process.argv);

  const rawOptions = program.opts<ScriptOptions>();
  const workerReleaseChannel = rawOptions.workerReleaseChannel?.trim();
  const workerReleaseVersion = rawOptions.workerReleaseVersion?.trim();

  if (
    workerReleaseChannel &&
    workerReleaseChannel !== 'stable' &&
    workerReleaseChannel !== 'preview'
  ) {
    program.error(
      `Unsupported --worker-release-channel value: ${workerReleaseChannel}. Expected "stable" or "preview".`,
    );
  }

  if (workerReleaseVersion && !rawOptions.useRelease) {
    program.error('--worker-release-version requires --use-release.');
  }

  if (workerReleaseChannel === 'preview' && !rawOptions.useRelease) {
    program.error('--worker-release-channel preview requires --use-release.');
  }

  const options: ScriptOptions = {
    reset: rawOptions.reset,
    verbose: rawOptions.verbose,
    autoNgrok: false,
    skipWorkerReleaseBuild: rawOptions.skipWorkerReleaseBuild,
    useRelease: rawOptions.useRelease,
    workerReleaseChannel:
      workerReleaseChannel === 'preview' ? 'preview' : 'stable',
    ...(workerReleaseVersion ? { workerReleaseVersion } : {}),
  };

  return options;
}

LocalDevStarter.run(parseArguments());
