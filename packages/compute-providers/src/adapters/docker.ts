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

  public getInstanceStatus(
    input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult> {
    return docker(
      ['inspect', '--format', '{{.State.Status}}', input.instanceId],
      { signal: input.signal, allowFailure: true },
    ).then((status) => ({
      status:
        status === 'running'
          ? 'running'
          : status === 'created' || status === 'restarting'
            ? 'pending'
            : status === 'exited' || status === 'dead'
              ? 'stopped'
              : 'unknown',
    }));
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
    return {};
  }

  public async enterStandby(
    input: EnterStandbyInput,
  ): Promise<EnterStandbyResult> {
    await docker(['stop', '--time', '10', input.instanceId], {
      signal: input.signal,
    });
    return { resumeHandle: input.instanceId };
  }

  public async resumeFromStandby(
    input: ResumeFromStandbyInput,
  ): Promise<CreatedInstance> {
    await docker(['start', input.resumeHandle], { signal: input.signal });
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
