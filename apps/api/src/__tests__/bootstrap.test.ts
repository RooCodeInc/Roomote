import { runApiServer } from '../bootstrap';

function stubAuthKeypairsBootstrap() {
  const bootstrapGeneratedAuthKeypairs = vi.fn().mockResolvedValue(false);

  return {
    bootstrapGeneratedAuthKeypairs,
    loadAuthKeypairsBootstrap: async () => ({
      bootstrapGeneratedAuthKeypairs,
    }),
  };
}

function stubEnsureArtifactsBucket() {
  const ensureArtifactsBucketAtBoot = vi.fn().mockResolvedValue(undefined);

  return {
    ensureArtifactsBucketAtBoot,
    loadEnsureArtifactsBucket: async () => ({
      ensureArtifactsBucketAtBoot,
    }),
  };
}

function stubDeclarativeEnvironmentsBootstrap() {
  const bootstrapDeclarativeEnvironments = vi.fn().mockResolvedValue(null);

  return {
    bootstrapDeclarativeEnvironments,
    loadDeclarativeEnvironmentsBootstrap: async () => ({
      bootstrapDeclarativeEnvironments,
    }),
  };
}

describe('runApiServer', () => {
  it('captures startup failures when loading the server module throws', async () => {
    const captureException = vi.fn();
    const flushSentry = vi.fn().mockResolvedValue(true);
    const logError = vi.fn();
    const exitProcess = vi.fn() as unknown as (code?: number) => never;

    await runApiServer({
      loadStartApiServer: async () => {
        throw new Error('module import failed');
      },
      loadAuthKeypairsBootstrap:
        stubAuthKeypairsBootstrap().loadAuthKeypairsBootstrap,
      loadDeclarativeEnvironmentsBootstrap:
        stubDeclarativeEnvironmentsBootstrap()
          .loadDeclarativeEnvironmentsBootstrap,
      loadEnsureArtifactsBucket:
        stubEnsureArtifactsBucket().loadEnsureArtifactsBucket,
      captureException,
      flushSentry,
      logError,
      exitProcess,
    });

    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'module import failed' }),
      undefined,
      { phase: 'startup' },
    );
    expect(logError).toHaveBeenCalledWith(
      'Failed to start API server',
      expect.objectContaining({ message: 'module import failed' }),
    );
    expect(flushSentry).toHaveBeenCalledTimes(1);
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it('starts the API server when the module loads successfully', async () => {
    const startApiServer = vi.fn().mockResolvedValue(undefined);
    const { bootstrapGeneratedAuthKeypairs, loadAuthKeypairsBootstrap } =
      stubAuthKeypairsBootstrap();
    const { ensureArtifactsBucketAtBoot, loadEnsureArtifactsBucket } =
      stubEnsureArtifactsBucket();
    const {
      bootstrapDeclarativeEnvironments,
      loadDeclarativeEnvironmentsBootstrap,
    } = stubDeclarativeEnvironmentsBootstrap();

    await runApiServer({
      loadStartApiServer: async () => ({ startApiServer }),
      loadAuthKeypairsBootstrap,
      loadDeclarativeEnvironmentsBootstrap,
      loadEnsureArtifactsBucket,
    });

    expect(bootstrapGeneratedAuthKeypairs).toHaveBeenCalledTimes(1);
    expect(ensureArtifactsBucketAtBoot).toHaveBeenCalledTimes(1);
    expect(bootstrapDeclarativeEnvironments).toHaveBeenCalledTimes(1);
    expect(startApiServer).toHaveBeenCalledTimes(1);
    expect(
      bootstrapGeneratedAuthKeypairs.mock.invocationCallOrder[0],
    ).toBeLessThan(ensureArtifactsBucketAtBoot.mock.invocationCallOrder[0]!);
    expect(
      ensureArtifactsBucketAtBoot.mock.invocationCallOrder[0],
    ).toBeLessThan(
      bootstrapDeclarativeEnvironments.mock.invocationCallOrder[0]!,
    );
    expect(
      bootstrapDeclarativeEnvironments.mock.invocationCallOrder[0],
    ).toBeLessThan(startApiServer.mock.invocationCallOrder[0]!);
  });

  it('still starts the API server when declarative environments fail to apply', async () => {
    const captureException = vi.fn();
    const flushSentry = vi.fn().mockResolvedValue(true);
    const logError = vi.fn();
    const exitProcess = vi.fn() as unknown as (code?: number) => never;
    const startApiServer = vi.fn().mockResolvedValue(undefined);

    await runApiServer({
      loadStartApiServer: async () => ({ startApiServer }),
      loadAuthKeypairsBootstrap:
        stubAuthKeypairsBootstrap().loadAuthKeypairsBootstrap,
      loadDeclarativeEnvironmentsBootstrap: async () => ({
        bootstrapDeclarativeEnvironments: vi
          .fn()
          .mockRejectedValue(new Error('bad declarative definitions')),
      }),
      loadEnsureArtifactsBucket:
        stubEnsureArtifactsBucket().loadEnsureArtifactsBucket,
      captureException,
      flushSentry,
      logError,
      exitProcess,
    });

    expect(startApiServer).toHaveBeenCalledTimes(1);
    expect(exitProcess).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'bad declarative definitions' }),
      undefined,
      { phase: 'declarative-environments' },
    );
    expect(logError).toHaveBeenCalledWith(
      'Failed to apply declarative environments',
      expect.objectContaining({ message: 'bad declarative definitions' }),
    );
  });

  it('reports skipped declarative definitions without failing startup', async () => {
    const captureException = vi.fn();
    const startApiServer = vi.fn().mockResolvedValue(undefined);

    await runApiServer({
      loadStartApiServer: async () => ({ startApiServer }),
      loadAuthKeypairsBootstrap:
        stubAuthKeypairsBootstrap().loadAuthKeypairsBootstrap,
      loadDeclarativeEnvironmentsBootstrap: async () => ({
        bootstrapDeclarativeEnvironments: vi.fn().mockResolvedValue({
          skipped: [{ source: 'broken.yaml', reason: 'Invalid configuration' }],
        }),
      }),
      loadEnsureArtifactsBucket:
        stubEnsureArtifactsBucket().loadEnsureArtifactsBucket,
      captureException,
    });

    expect(startApiServer).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('broken.yaml (Invalid configuration)'),
      }),
      undefined,
      { phase: 'declarative-environments' },
    );
  });

  it('captures startup failures when keypair bootstrap fails', async () => {
    const captureException = vi.fn();
    const flushSentry = vi.fn().mockResolvedValue(true);
    const logError = vi.fn();
    const exitProcess = vi.fn() as unknown as (code?: number) => never;
    const startApiServer = vi.fn().mockResolvedValue(undefined);

    await runApiServer({
      loadStartApiServer: async () => ({ startApiServer }),
      loadAuthKeypairsBootstrap: async () => ({
        bootstrapGeneratedAuthKeypairs: vi
          .fn()
          .mockRejectedValue(new Error('keypair bootstrap failed')),
      }),
      loadDeclarativeEnvironmentsBootstrap:
        stubDeclarativeEnvironmentsBootstrap()
          .loadDeclarativeEnvironmentsBootstrap,
      loadEnsureArtifactsBucket:
        stubEnsureArtifactsBucket().loadEnsureArtifactsBucket,
      captureException,
      flushSentry,
      logError,
      exitProcess,
    });

    expect(startApiServer).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'keypair bootstrap failed' }),
      undefined,
      { phase: 'startup' },
    );
    expect(exitProcess).toHaveBeenCalledWith(1);
  });
});
