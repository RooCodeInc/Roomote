import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DOCKER_CAPABILITIES as DOCKER_CAPABILITIES_VALUE } from '@roomote/types';
import type { ComputeProvider } from '@roomote/types';

import { unsupported } from '../errors';
import type {
  CommandOutputEvent,
  ComputeProviderClient,
  CreateInstanceInput,
  CreateSnapshotInput,
  CreateSnapshotResult,
  CreatedInstance,
  DestroyInstanceInput,
  DestroyInstanceResult,
  EnterStandbyInput,
  EnterStandbyResult,
  GetCommandOutputInput,
  GetInstanceStatusInput,
  GetInstanceStatusResult,
  InstanceSummary,
  ListInstancesInput,
  ResumeInstanceInput,
  ResumeFromStandbyInput,
  RunCommandInput,
  RunCommandResult,
  StreamCommandOutputInput,
  WriteFileInput,
} from '../types';

const execFileAsync = promisify(execFile);
const DOCKER_WORKER_CONTAINER_PREFIX = 'roomote-worker-';

function getTaskDaemonContainerName(instanceId: string): string {
  return `${instanceId}-docker`;
}

function getTaskWorkspaceVolumeName(instanceId: string): string {
  return `${instanceId}-workspace`;
}

function formatDockerError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr =
    'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr
      : 'stderr' in error && Buffer.isBuffer(error.stderr)
        ? error.stderr.toString('utf8')
        : '';

  return [error.message, stderr].filter(Boolean).join('\n');
}

/** True when `docker inspect` (or similar) reports the object is gone. */
export function isDockerMissingObjectError(error: unknown): boolean {
  const text = formatDockerError(error);
  return /no such (?:object|container|network|volume|image)/i.test(text);
}

async function docker(
  args: string[],
  options: { signal?: AbortSignal; allowFailure?: boolean } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', args, {
      maxBuffer: 10 * 1024 * 1024,
      signal: options.signal,
    });
    return stdout.trim();
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}

function getSourceRunId(instanceId: string): number | null {
  if (!instanceId.startsWith(DOCKER_WORKER_CONTAINER_PREFIX)) return null;
  const runId = Number(instanceId.slice(DOCKER_WORKER_CONTAINER_PREFIX.length));
  return Number.isInteger(runId) ? runId : null;
}

export class DockerClient implements ComputeProviderClient {
  public readonly vendor: ComputeProvider = 'docker';
  public readonly capabilities = DOCKER_CAPABILITIES_VALUE;

  public listInstances(_input: ListInstancesInput): Promise<InstanceSummary[]> {
    return Promise.resolve([]);
  }

  public async getInstanceStatus(
    input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult> {
    let status: string;
    try {
      status = await docker(
        ['inspect', '--format', '{{.State.Status}}', input.instanceId],
        { signal: input.signal },
      );
    } catch (error) {
      // Missing container is a real lifecycle signal. Daemon/CLI failures
      // (e.g. no DOCKER_HOST) must not look like "instance gone" — callers
      // such as SleepCheck treat non-running as fatal for the task run.
      if (isDockerMissingObjectError(error)) {
        return { status: 'stopped' };
      }
      throw error;
    }

    return {
      status:
        status === 'running'
          ? 'running'
          : status === 'created' || status === 'restarting'
            ? 'pending'
            : status === 'exited' || status === 'dead'
              ? 'stopped'
              : 'unknown',
    };
  }

  public createInstance(_input: CreateInstanceInput): Promise<CreatedInstance> {
    return unsupported(this.vendor, 'createInstance');
  }

  public async destroyInstance(
    input: DestroyInstanceInput,
  ): Promise<DestroyInstanceResult> {
    const sourceRunId = getSourceRunId(input.instanceId);
    await docker(['rm', '-f', `${input.instanceId}-egress-policy`], {
      signal: input.signal,
      allowFailure: true,
    });
    await docker(['rm', '-f', getTaskDaemonContainerName(input.instanceId)], {
      signal: input.signal,
      allowFailure: true,
    });
    await docker(['rm', '-f', input.instanceId], {
      signal: input.signal,
      allowFailure: true,
    });
    if (sourceRunId !== null) {
      await docker(['network', 'rm', `roomote-task-${sourceRunId}`], {
        signal: input.signal,
        allowFailure: true,
      });
    }
    await docker(
      ['volume', 'rm', '-f', getTaskWorkspaceVolumeName(input.instanceId)],
      {
        signal: input.signal,
        allowFailure: true,
      },
    );
    return {};
  }

  public async enterStandby(
    input: EnterStandbyInput,
  ): Promise<EnterStandbyResult> {
    await docker(
      ['stop', '--time', '10', getTaskDaemonContainerName(input.instanceId)],
      {
        signal: input.signal,
        allowFailure: true,
      },
    );
    await docker(['stop', '--time', '10', input.instanceId], {
      signal: input.signal,
    });
    return { resumeHandle: input.instanceId };
  }

  public async resumeFromStandby(
    input: ResumeFromStandbyInput,
  ): Promise<CreatedInstance> {
    await docker(['start', input.resumeHandle], { signal: input.signal });
    await docker(['start', getTaskDaemonContainerName(input.resumeHandle)], {
      signal: input.signal,
      allowFailure: true,
    });
    return {
      instanceId: input.resumeHandle,
      sourceSnapshotId: input.resumeHandle,
      status: 'running',
    };
  }

  public runCommand(_input: RunCommandInput): Promise<RunCommandResult> {
    return unsupported(this.vendor, 'runCommand');
  }

  public streamCommandOutput(
    _input: StreamCommandOutputInput,
  ): AsyncIterable<CommandOutputEvent> {
    return unsupported(this.vendor, 'streamCommandOutput');
  }

  public getCommandOutput(_input: GetCommandOutputInput): Promise<string> {
    return unsupported(this.vendor, 'getCommandOutput');
  }

  public writeFiles(_input: WriteFileInput): Promise<void> {
    return unsupported(this.vendor, 'writeFiles');
  }

  public createSnapshot(
    _input: CreateSnapshotInput,
  ): Promise<CreateSnapshotResult> {
    return unsupported(this.vendor, 'createSnapshot');
  }

  public resumeFromSnapshot(
    _input: ResumeInstanceInput,
  ): Promise<CreatedInstance> {
    return unsupported(this.vendor, 'resumeFromSnapshot');
  }
}
