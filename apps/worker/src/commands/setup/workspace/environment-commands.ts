import { TASK_TIMEOUT_MS, type NamedPort } from '@roomote/types';

import type { EnvironmentWorkspace } from '../../../workspace';
import { ExecutionError } from '../../../command-executor';
import type { StartupLogger } from '../../../logging';
import { resolveLoopback } from '../../../services/auth-proxy';
import type { PhaseRecorder } from '../logging';
import type { EnvironmentSetupWarning, PrepareWorkspaceResult } from './types';
import type { EnvironmentSetupStatusWriter } from './setup-status';
import { createWorkspaceManager } from './shared';

interface SetupOrganizationEnvironmentOptions {
  environment: EnvironmentWorkspace;
  envVars: Record<string, string | undefined>;
  userEnvVars?: Record<string, string>;
  preparedWorkspace?: PrepareWorkspaceResult;
  continueRepositoryCommandFailures?: boolean;
  /** Mirrors per-command progress to `<workspace>/.roomote/setup-status.json`. */
  setupStatusWriter?: EnvironmentSetupStatusWriter;
  /** Records one durable task-run phase event per repository command. */
  recordPhase?: PhaseRecorder;
}

const PREVIEW_READINESS_POLL_INTERVAL_MS = 1_000;
const PREVIEW_READINESS_PROBE_TIMEOUT_MS = 5_000;
const PREVIEW_READINESS_PROGRESS_INTERVAL_MS = 60_000;

interface PreviewProbeResult {
  ready: boolean;
  diagnostic: string;
}

interface PreviewReadinessProgress {
  port: NamedPort;
  elapsedMs: number;
  diagnostic: string;
}

export function getPreviewReadinessTimeoutMs(timeoutSeconds: number): number {
  return Math.min(timeoutSeconds * 1_000, TASK_TIMEOUT_MS);
}

function previewUrl(port: NamedPort, host = '127.0.0.1'): string {
  const url = new URL(`http://${host}:${port.port}`);
  const initialPath = port.initial_path ?? '/';
  const suffixIndex = initialPath.search(/[?#]/);

  url.pathname =
    suffixIndex === -1 ? initialPath : initialPath.slice(0, suffixIndex);

  return `${url.origin}${url.pathname}${suffixIndex === -1 ? '' : initialPath.slice(suffixIndex)}`;
}

async function probePreview(
  port: NamedPort,
  deadline: number,
): Promise<PreviewProbeResult> {
  const loopbackTimeoutMs = deadline - Date.now();
  if (loopbackTimeoutMs <= 0) {
    return { ready: false, diagnostic: 'readiness deadline elapsed' };
  }

  let loopbackTimeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const host = await Promise.race([
      resolveLoopback(port.port),
      new Promise<never>((_, reject) => {
        loopbackTimeout = setTimeout(
          () => reject(new Error('Loopback resolution timed out')),
          loopbackTimeoutMs,
        );
      }),
    ]);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { ready: false, diagnostic: 'readiness deadline elapsed' };
    }

    const url = previewUrl(port, host);
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(
        Math.min(PREVIEW_READINESS_PROBE_TIMEOUT_MS, remainingMs),
      ),
    });
    await response.body?.cancel().catch(() => {});
    return {
      ready: response.status < 500,
      diagnostic: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ready: false,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(loopbackTimeout);
  }
}

export async function waitForPreviewPorts(
  ports: NamedPort[],
  options: {
    timeoutMs: number;
    onProgress?: (progress: PreviewReadinessProgress) => void;
  },
): Promise<EnvironmentSetupWarning[]> {
  return (
    await Promise.all(
      ports.map(async (port) => {
        const url = previewUrl(port);
        const startedAt = Date.now();
        const deadline = startedAt + options.timeoutMs;
        let nextProgressAt = startedAt + PREVIEW_READINESS_PROGRESS_INTERVAL_MS;
        let lastDiagnostic = 'not yet probed';

        while (Date.now() < deadline) {
          const result = await probePreview(port, deadline);
          if (result.ready) {
            return undefined;
          }
          lastDiagnostic = result.diagnostic;

          if (options.onProgress && Date.now() >= nextProgressAt) {
            options.onProgress({
              port,
              elapsedMs: Date.now() - startedAt,
              diagnostic: lastDiagnostic,
            });
            nextProgressAt += PREVIEW_READINESS_PROGRESS_INTERVAL_MS;
          }

          const remainingMs = deadline - Date.now();
          if (remainingMs > 0) {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.min(PREVIEW_READINESS_POLL_INTERVAL_MS, remainingMs),
              ),
            );
          }
        }

        return {
          message: `Preview "${port.name}" at ${url} did not become ready within ${options.timeoutMs / 1_000} seconds after its detached startup command launched. Last probe: ${lastDiagnostic}. Inspect the detached command logs listed in .roomote/setup-status.json.`,
        };
      }),
    )
  ).filter((warning) => warning !== undefined);
}

function getEnvironmentRepoPaths(
  preparedWorkspace?: PrepareWorkspaceResult,
): Record<string, string> | undefined {
  return preparedWorkspace?.environment?.repoPaths;
}

export async function installOrganizationEnvironmentSkills(
  logger: StartupLogger,
  {
    environment,
    envVars,
    preparedWorkspace,
  }: SetupOrganizationEnvironmentOptions,
): Promise<void> {
  const repoPaths = getEnvironmentRepoPaths(preparedWorkspace);

  if (!repoPaths) {
    return;
  }

  const { workspaceManager } = createWorkspaceManager(envVars);

  logger.userLog.log('Setting up your environment');

  if (
    environment.environmentConfig.skills &&
    Object.keys(environment.environmentConfig.skills).length > 0
  ) {
    await workspaceManager.installEnvironmentSkills(
      environment.environmentConfig.skills,
    );
  }

  if (
    environment.environmentConfig.manualSkills &&
    environment.environmentConfig.manualSkills.length > 0
  ) {
    await workspaceManager.installManualEnvironmentSkills(
      environment.environmentConfig.manualSkills,
    );
  }
}

export async function executeOrganizationEnvironmentRepositoryCommands(
  logger: StartupLogger,
  {
    environment,
    envVars,
    userEnvVars,
    preparedWorkspace,
    continueRepositoryCommandFailures:
      _continueRepositoryCommandFailures = false,
    setupStatusWriter,
    recordPhase,
  }: SetupOrganizationEnvironmentOptions,
): Promise<EnvironmentSetupWarning[]> {
  const repoPaths = getEnvironmentRepoPaths(preparedWorkspace);
  const warnings: EnvironmentSetupWarning[] = [];
  let previewReadinessTimeoutMs = 0;

  if (!repoPaths) {
    // Nothing to execute, but the status file must still reach a terminal
    // state — a reader should never see `running` forever.
    setupStatusWriter?.finalize();
    return warnings;
  }

  const { workspaceManager } = createWorkspaceManager(envVars);

  try {
    await workspaceManager.executeEnvironmentRepositoryCommands(
      environment.environmentConfig.repositories,
      repoPaths,
      userEnvVars,
      {
        continueOnError: true,
        onCommandStart: ({ repository, commandName }) => {
          setupStatusWriter?.markCommandRunning(repository, commandName);
        },
        onCommandResult: ({ repository, result }) => {
          setupStatusWriter?.markCommandResult(repository, result);

          if (result.success && result.command.detached) {
            previewReadinessTimeoutMs = Math.max(
              previewReadinessTimeoutMs,
              getPreviewReadinessTimeoutMs(result.command.timeout),
            );
          }

          if (recordPhase) {
            const endedAtMs = Date.now();

            // Best-effort durable audit trail; must not affect setup outcome.
            void Promise.resolve(
              recordPhase({
                label: `environmentRepositoryCommand: ${repository} ${result.command.name}`,
                startedAtMs: endedAtMs - result.duration,
                endedAtMs,
                durationMs: result.duration,
                outcome: result.success ? 'ok' : 'error',
              }),
            ).catch(() => {});
          }
        },
        onCommandFailure: ({ repository, result }) => {
          const warningMessage = `Optional environment command "${result.command.name}" failed for ${repository}: ${
            result.error ?? 'Command failed.'
          }`;
          const warning: EnvironmentSetupWarning = {
            message: warningMessage,
          };
          warnings.push(warning);

          logger.userLog.warn(
            `${warningMessage} Continuing without a fully configured environment.`,
          );
          logger.debug.warn(
            `[${repository}] Environment command "${result.command.name}" failed during environment setup:\n${new ExecutionError(
              result.error ?? 'Unknown execution error',
              result,
            ).formatDetails()}`,
          );
        },
      },
    );

    if (previewReadinessTimeoutMs > 0) {
      if ((environment.environmentConfig.ports?.length ?? 0) > 0) {
        logger.userLog.log('Waiting for configured previews to become ready');
      }

      const previewWarnings = await waitForPreviewPorts(
        environment.environmentConfig.ports ?? [],
        {
          timeoutMs: previewReadinessTimeoutMs,
          onProgress: ({ port, elapsedMs, diagnostic }) => {
            logger.userLog.log(
              `Preview "${port.name}" is still starting after ${Math.round(elapsedMs / 1_000)} seconds. Last probe: ${diagnostic}.`,
            );
          },
        },
      );
      warnings.push(...previewWarnings);

      for (const warning of previewWarnings) {
        logger.userLog.warn(warning.message);
      }
    }
  } catch (error) {
    setupStatusWriter?.finalize({
      warnings: warnings.map((warning) => warning.message),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  setupStatusWriter?.finalize({
    warnings: warnings.map((warning) => warning.message),
  });

  return warnings;
}

export async function setupOrganizationEnvironment(
  logger: StartupLogger,
  options: SetupOrganizationEnvironmentOptions,
): Promise<EnvironmentSetupWarning[]> {
  await installOrganizationEnvironmentSkills(logger, options);

  return executeOrganizationEnvironmentRepositoryCommands(logger, options);
}
