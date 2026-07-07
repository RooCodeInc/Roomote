import { assertSecureBootBinding } from '@roomote/env';

import { captureApiException, flushApiSentry } from './monitoring/sentry';

type StartApiServerModule = {
  startApiServer: () => Promise<unknown>;
};

type AuthKeypairsModule = {
  bootstrapGeneratedAuthKeypairs: () => Promise<boolean>;
};

type EnsureArtifactsBucketModule = {
  ensureArtifactsBucketAtBoot: () => Promise<void>;
};

type RunApiServerOptions = {
  loadStartApiServer?: () => Promise<StartApiServerModule>;
  loadAuthKeypairsBootstrap?: () => Promise<AuthKeypairsModule>;
  loadEnsureArtifactsBucket?: () => Promise<EnsureArtifactsBucketModule>;
  captureException?: typeof captureApiException;
  flushSentry?: typeof flushApiSentry;
  logError?: (...args: Parameters<typeof console.error>) => void;
  exitProcess?: (code?: number) => never;
};

export async function runApiServer({
  loadStartApiServer = () => import('./server'),
  loadAuthKeypairsBootstrap = () => import('@roomote/db/server'),
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

    const { startApiServer } = await loadStartApiServer();
    await startApiServer();
  } catch (error) {
    captureException(error, undefined, { phase: 'startup' });
    logError('Failed to start API server', error);
    await flushSentry();
    exitProcess(1);
  }
}
