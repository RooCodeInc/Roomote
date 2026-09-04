import {
  bootstrapGeneratedAuthKeypairs,
  db,
  waitForMigrations,
} from '@roomote/db/server';
import { assertSecureBootBinding, Env } from '@roomote/env';
import {
  buildRoomoteDeployMarker,
  formatRoomoteDeployMarker,
} from '@roomote/types';

import { BaseController } from './BaseController';
import {
  captureControllerException,
  flushControllerSentry,
} from './monitoring/sentry';
import { RoomoteController } from './RoomoteController';

let controller: BaseController | null = null;
let isTerminating = false;

const exitWithSentryFlush = async (
  code: number,
  context: 'graceful_shutdown' | 'startup_failure',
) => {
  try {
    await flushControllerSentry();
  } catch (error) {
    console.error(
      `[${context}] error flushing Sentry: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    process.exit(code);
  }
};

const gracefulShutdown = async (signal: string) => {
  console.log(`[gracefulShutdown] ${signal} received`);

  if (isTerminating) {
    console.log('[gracefulShutdown] already terminating');
    return;
  }

  isTerminating = true;
  console.log('[gracefulShutdown] initiating graceful shutdown...');

  // Wait for controller to finish current iteration.
  if (controller) {
    try {
      await controller.stop();
      console.log('[gracefulShutdown] controller stopped');
    } catch (error) {
      captureControllerException(error, {
        phase: 'graceful_shutdown',
        signal,
      });
      console.error(
        `[gracefulShutdown] error stopping controller: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log('[gracefulShutdown] graceful shutdown complete');
  await exitWithSentryFlush(0, 'graceful_shutdown');
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle unhandled promise rejections (e.g., transient network errors).
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[unhandledRejection] Unhandled promise rejection:', reason);
});

// Handle uncaught exceptions.
process.on('uncaughtException', (error) => {
  console.error('[uncaughtException] Uncaught exception:', error);

  // For fatal errors, initiate graceful shutdown.
  if (error.message?.includes('FATAL') || error.name === 'SystemError') {
    void gracefulShutdown('uncaughtException');
  }
});

async function main() {
  // Migrations run only ahead of the api service while every service rolls
  // at once; wait for the schema rather than crash-loop on a pending column.
  const readiness = await waitForMigrations({
    database: db,
    log: (message) => console.info(message),
  });
  if (readiness.state === 'unmanaged') {
    console.info(
      'Database has no migration bookkeeping; assuming its schema is managed directly.',
    );
  }
  await bootstrapGeneratedAuthKeypairs();
  assertSecureBootBinding();

  const appEnv = Env.APP_ENV;

  if (!appEnv) {
    console.error('APP_ENV is not set');
    process.exit(1);
  }

  console.log('🏖️ Targeting mixed compute providers for workers');
  console.info(
    formatRoomoteDeployMarker(
      buildRoomoteDeployMarker({ service: 'controller' }),
    ),
  );
  controller = new RoomoteController(appEnv);

  await controller.start();
}

main().catch(async (error) => {
  captureControllerException(error, {
    phase: 'startup',
  });
  console.error(
    `Failed to start controller: ${error instanceof Error ? error.message : String(error)}`,
  );

  await exitWithSentryFlush(1, 'startup_failure');
});
