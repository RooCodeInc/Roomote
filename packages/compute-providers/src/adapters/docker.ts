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
  GetCommandOutputInput,
  GetInstanceStatusInput,
  GetInstanceStatusResult,
  InstanceSummary,
  ListInstancesInput,
  ResumeInstanceInput,
  RunCommandInput,
  RunCommandResult,
  StreamCommandOutputInput,
  WriteFileInput,
} from '../types';

export class DockerClient implements ComputeProviderClient {
  public readonly vendor: ComputeProvider = 'docker';
  public readonly capabilities = DOCKER_CAPABILITIES_VALUE;

  public listInstances(_input: ListInstancesInput): Promise<InstanceSummary[]> {
    return Promise.resolve([]);
  }

  public getInstanceStatus(
    _input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult> {
    return Promise.resolve({ status: 'unknown' });
  }

  public createInstance(_input: CreateInstanceInput): Promise<CreatedInstance> {
    return unsupported(this.vendor, 'createInstance');
  }

  public destroyInstance(
    _input: DestroyInstanceInput,
  ): Promise<DestroyInstanceResult> {
    return unsupported(this.vendor, 'destroyInstance');
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
