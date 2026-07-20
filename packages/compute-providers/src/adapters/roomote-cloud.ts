import {
  ROOMOTE_CLOUD_CAPABILITIES,
  type ComputeProvider,
} from '@roomote/types';

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
  RoomoteCloudConfig,
  RunCommandInput,
  RunCommandResult,
  StreamCommandOutputInput,
  WriteFileInput,
} from '../types';

type CloudLeaseStatus = {
  id: string;
  status: 'running' | 'stopping' | 'stopped' | 'cleanup_failed';
  timeoutRemainingMs?: number;
};

export class RoomoteCloudClient implements ComputeProviderClient {
  public readonly vendor: ComputeProvider = 'roomote';
  public readonly capabilities = ROOMOTE_CLOUD_CAPABILITIES;

  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  public constructor(private readonly config: RoomoteCloudConfig) {
    if (!config.baseUrl.trim())
      throw new Error('Roomote Cloud requires a baseUrl');
    if (!config.deploymentToken.trim())
      throw new Error('Roomote Cloud requires a deploymentToken');
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '');
    this.fetchFn = config.fetchFn ?? fetch;
  }

  public listInstances(_input: ListInstancesInput): Promise<InstanceSummary[]> {
    return Promise.resolve([]);
  }

  public async getInstanceStatus(
    input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult> {
    const response = await this.request(
      `/runtime/v1/compute/leases/${encodeURIComponent(input.instanceId)}`,
      { signal: input.signal },
    );
    if (response.status === 404) return { status: 'stopped' };
    if (!response.ok)
      throw new Error(
        `Roomote Cloud lease status failed (${response.status}): ${(
          await response.text()
        ).slice(0, 500)}`,
      );
    const lease = (await response.json()) as CloudLeaseStatus;
    return {
      status:
        lease.status === 'running'
          ? 'running'
          : lease.status === 'stopping'
            ? 'stopping'
            : lease.status === 'cleanup_failed'
              ? 'failed'
              : 'stopped',
      ...(Number.isFinite(lease.timeoutRemainingMs)
        ? { timeoutRemainingMs: Math.max(0, lease.timeoutRemainingMs!) }
        : {}),
    };
  }

  public createInstance(_input: CreateInstanceInput): Promise<CreatedInstance> {
    return unsupported(this.vendor, 'createInstance');
  }

  public async destroyInstance(
    input: DestroyInstanceInput,
  ): Promise<DestroyInstanceResult> {
    const response = await this.request(
      `/runtime/v1/compute/leases/${encodeURIComponent(input.instanceId)}/stop`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: input.signal,
      },
    );
    if (response.status === 404) return {};
    if (!response.ok)
      throw new Error(
        `Roomote Cloud lease stop failed (${response.status}): ${(
          await response.text()
        ).slice(0, 500)}`,
      );
    return {};
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

  private request(path: string, init: RequestInit = {}) {
    return this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.deploymentToken}`,
        ...init.headers,
      },
    });
  }
}
