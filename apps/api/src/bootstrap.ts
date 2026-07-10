import { assertSecureBootBinding } from '@roomote/env';

import { captureApiException, flushApiSentry } from './monitoring/sentry';

type StartApiServerModule = {
  startApiServer: () => Promise<unknown>;
};

type AuthKeypairsModule = {
  bootstrapGeneratedAuthKeypairs: () => Promise<boolean>;
};

type DeclarativeEnvironmentsModule = {
  bootstrapDeclarativeEnvironments: () => Promise<{
    skipped: Array<{ source: string; reason: string }>;
  } | null>;
};

type EnsureArtifactsBucketModule = {
  ensureArtifactsBucketAtBoot: () => Promise<void>;
};

type RunApiServerOptions = {
  loadStartApiServer?: () => Promise<StartApiServerModule>;
  loadAuthKeypairsBootstrap?: () => Promise<AuthKeypairsModule>;
  loadDeclarativeEnvironmentsBootstrap?: () => Promise<DeclarativeEnvironmentsModule>;
  loadEnsureArtifactsBucket?: () => Promise<EnsureArtifactsBucketModule>;
  captureException?: typeof captureApiException;
  flushSentry?: typeof flushApiSentry;
  logError?: (...args: Parameters<typeof console.error>) => void;
  exitProcess?: (code?: number) => never;
};

export async function runApiServer({
  loadStartApiServer = () => import('./server'),
  loadAuthKeypairsBootstrap = () => import('@roomote/db/server'),
  loadDeclarativeEnvironmentsBootstrap = () => import('@roomote/db/server'),
  loadEnsureArtifactsBucket = () =>
    import('./handlers/artifacts/ensure-bucket'),
  captureException = captureApiException,
  flushSentry = flushApiSentry,
  logError = (...args) => console.error(...args),
  exitProcess = process.exit,
}: RunApiServerOptions = {}): Promise<void> {
  try {
    const { bootstrapGeneratedAuthKeypairs } =
      await loadAuthKeypairsBootstrap();
    await bootstrapGeneratedAuthKeypairs();
    assertSecureBootBinding();

    const { ensureArtifactsBucketAtBoot } = await loadEnsureArtifactsBucket();
    await ensureArtifactsBucketAtBoot();

    // Declarative environment provisioning is deliberately non-fatal: a bad
    // definition set must not take the API (and with it task execution for
    // every other environment) down.
    try {
      const { bootstrapDeclarativeEnvironments } =
        await loadDeclarativeEnvironmentsBootstrap();
      const summary = await bootstrapDeclarativeEnvironments();

      if (summary && summary.skipped.length > 0) {
        // Skipped definitions already logged individually by the loader;
        // surface them to Sentry so operators notice broken declarative
        // config without watching boot logs.
        captureException(
          new Error(
            'Skipped declarative environment definitions: ' +
              summary.skipped
                .map((skip) => `${skip.source} (${skip.reason})`)
                .join('; '),
          ),
          undefined,
          { phase: 'declarative-environments' },
        );
      }
    } catch (error) {
      captureException(error, undefined, {
        phase: 'declarative-environments',
      });
      logError('Failed to apply declarative environments', error);
    }

    const { startApiServer } = await loadStartApiServer();
    await startApiServer();
  } catch (error) {
    captureException(error, undefined, { phase: 'startup' });
    logError('Failed to start API server', error);
    await flushSentry();
    exitProcess(1);
  }
}
