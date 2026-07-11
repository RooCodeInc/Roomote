import { createComputeProviderClient } from '../factory';

const { daytonaCreateMock, daytonaGetMock, daytonaListMock } = vi.hoisted(
  () => ({
    daytonaCreateMock: vi.fn(),
    daytonaGetMock: vi.fn(),
    daytonaListMock: vi.fn(),
  }),
);

vi.mock('@daytonaio/sdk', () => ({
  Daytona: class {
    public create = daytonaCreateMock;
    public get = daytonaGetMock;
    public list = daytonaListMock;
  },
}));

const {
  e2bCreateMock,
  e2bConnectMock,
  e2bListMock,
  e2bGetInfoMock,
  e2bKillMock,
  e2bCreateSnapshotMock,
  E2bNotFoundError,
  E2bCommandExitError,
} = vi.hoisted(() => {
  class E2bNotFoundError extends Error {}

  class E2bCommandExitError extends Error {
    public constructor(
      public readonly exitCode: number,
      public readonly stdout: string,
      public readonly stderr: string,
    ) {
      super(`exit status ${exitCode}`);
    }
  }

  return {
    e2bCreateMock: vi.fn(),
    e2bConnectMock: vi.fn(),
    e2bListMock: vi.fn(),
    e2bGetInfoMock: vi.fn(),
    e2bKillMock: vi.fn(),
    e2bCreateSnapshotMock: vi.fn(),
    E2bNotFoundError,
    E2bCommandExitError,
  };
});

vi.mock('e2b', () => ({
  Sandbox: {
    create: e2bCreateMock,
    connect: e2bConnectMock,
    list: e2bListMock,
    getInfo: e2bGetInfoMock,
    kill: e2bKillMock,
    createSnapshot: e2bCreateSnapshotMock,
  },
  NotFoundError: E2bNotFoundError,
  CommandExitError: E2bCommandExitError,
}));

const {
  blaxelCreateMock,
  blaxelGetMock,
  blaxelListMock,
  blaxelDeleteMock,
  blaxelUpdateTtlMock,
  blaxelSettingsMock,
} = vi.hoisted(() => ({
  blaxelCreateMock: vi.fn(),
  blaxelGetMock: vi.fn(),
  blaxelListMock: vi.fn(),
  blaxelDeleteMock: vi.fn(),
  blaxelUpdateTtlMock: vi.fn(),
  blaxelSettingsMock: vi.fn(),
}));

vi.mock('@blaxel/core', () => ({
  settings: { setConfig: blaxelSettingsMock },
  SandboxInstance: {
    create: blaxelCreateMock,
    get: blaxelGetMock,
    list: blaxelListMock,
    delete: blaxelDeleteMock,
    updateTtl: blaxelUpdateTtlMock,
  },
}));

async function collectLogs<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const entries: T[] = [];

  for await (const item of iterable) {
    entries.push(item);
  }

  return entries;
}

describe('compute provider adapter contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blaxel adapter satisfies hosted sandbox contract without snapshots', async () => {
    const sandbox = {
      metadata: {
        name: 'roomote-blaxel-1',
        createdAt: new Date().toISOString(),
      },
      status: 'DEPLOYED',
      expiresIn: 120,
      wait: vi.fn().mockResolvedValue(undefined),
      previews: {
        createIfNotExists: vi.fn().mockImplementation(async (preview) => ({
          spec: { url: `https://${preview.spec.port}.blaxel.test` },
        })),
        create: vi.fn().mockImplementation(async (preview) => ({
          spec: { url: `https://${preview.spec.port}.blaxel.test` },
        })),
      },
      process: {
        exec: vi.fn().mockResolvedValue({
          name: 'cmd-1',
          status: 'completed',
          exitCode: 0,
          stdout: 'hello',
          stderr: '',
        }),
        get: vi.fn().mockResolvedValue({
          status: 'completed',
          stdout: 'hello',
          stderr: '',
        }),
        logs: vi.fn().mockResolvedValue('hello'),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      fs: { writeBinary: vi.fn().mockResolvedValue(undefined) },
    };
    blaxelCreateMock.mockResolvedValue(sandbox);
    blaxelGetMock.mockResolvedValue(sandbox);
    blaxelListMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield sandbox;
      },
    });
    blaxelDeleteMock.mockResolvedValue(undefined);
    blaxelUpdateTtlMock.mockResolvedValue(sandbox);

    const client = createComputeProviderClient({
      provider: 'blaxel',
      config: {
        apiKey: 'key',
        workspace: 'workspace',
        image: 'ghcr.io/roomote/worker:test',
        timeoutMs: 120_000,
      },
    });
    expect(blaxelSettingsMock).toHaveBeenCalledWith({
      apiKey: 'key',
      workspace: 'workspace',
    });
    expect(client.capabilities.supportsSnapshots).toBe(false);
    expect(client.capabilities.supportsStandbyResume).toBe(true);
    expect(client.capabilities.supportsResume).toBe(true);

    const created = await client.createInstance({ ports: [3000] });
    expect(created.domains).toEqual({
      '3000': 'https://3000.blaxel.test',
    });
    expect(blaxelCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'ghcr.io/roomote/worker:test',
        ttl: '120s',
        ports: [{ target: 3000, protocol: 'HTTP' }],
      }),
    );

    await expect(
      client.runCommand({
        instanceId: created.instanceId,
        cmd: 'echo',
        args: ["it's safe"],
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'hello' });
    expect(sandbox.process.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: `'echo' 'it'"'"'s safe'`,
        timeout: 0,
      }),
    );

    await client.writeFiles({
      instanceId: created.instanceId,
      files: [{ path: '/sandbox/test', content: Buffer.from('test') }],
    });
    expect(sandbox.fs.writeBinary).toHaveBeenCalledWith(
      '/sandbox/test',
      expect.any(Buffer),
    );
    await expect(
      client.getCommandOutput({
        instanceId: created.instanceId,
        commandId: 'cmd-1',
      }),
    ).resolves.toBe('hello');
    await expect(client.listInstances({})).resolves.toHaveLength(1);
    await expect(
      client.getInstanceStatus({ instanceId: created.instanceId }),
    ).resolves.toEqual({ status: 'running', timeoutRemainingMs: 120_000 });
    await expect(
      client.createSnapshot({ instanceId: created.instanceId }),
    ).rejects.toThrow('does not support Roomote snapshots');
    await expect(
      client.enterStandby?.({
        instanceId: created.instanceId,
        commandId: 'cmd-1',
      }),
    ).resolves.toEqual({ resumeHandle: created.instanceId });
    expect(blaxelUpdateTtlMock).toHaveBeenCalledWith(created.instanceId, '7d');
    expect(sandbox.process.stop).toHaveBeenCalledWith('cmd-1');

    await expect(
      client.resumeFromStandby?.({
        resumeHandle: created.instanceId,
        ports: [3000],
      }),
    ).resolves.toMatchObject({
      instanceId: created.instanceId,
      sourceSnapshotId: created.instanceId,
      status: 'running',
      domains: { '3000': 'https://3000.blaxel.test' },
    });
    expect(blaxelUpdateTtlMock).toHaveBeenLastCalledWith(
      created.instanceId,
      '120s',
    );
    expect(sandbox.previews.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { name: 'port-3000' } }),
      true,
    );
    await client.destroyInstance({ instanceId: created.instanceId });
    expect(blaxelDeleteMock).toHaveBeenCalledWith(created.instanceId);
  });

  it('cleans up a Blaxel sandbox when readiness fails after creation', async () => {
    const sandbox = {
      metadata: { name: 'roomote-blaxel-failed' },
      wait: vi.fn().mockRejectedValue(new Error('deployment failed')),
    };
    blaxelCreateMock.mockResolvedValue(sandbox);
    blaxelDeleteMock.mockResolvedValue(undefined);

    const client = createComputeProviderClient({
      provider: 'blaxel',
      config: {
        apiKey: 'key',
        workspace: 'workspace',
        image: 'sandbox/roomote-worker:version',
      },
    });

    await expect(client.createInstance({})).rejects.toThrow(
      'deployment failed',
    );
    const createdName = blaxelCreateMock.mock.calls[0]?.[0]?.name;
    expect(createdName).toEqual(expect.any(String));
    expect(blaxelDeleteMock).toHaveBeenCalledWith(createdName);
  });

  it('cleans up a Blaxel sandbox that resolves after create is aborted', async () => {
    let resolveCreate!: (sandbox: { metadata: { name: string } }) => void;
    blaxelCreateMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    blaxelDeleteMock.mockResolvedValue(undefined);

    const client = createComputeProviderClient({
      provider: 'blaxel',
      config: {
        apiKey: 'key',
        workspace: 'workspace',
        image: 'sandbox/roomote-worker:version',
      },
    });
    const controller = new AbortController();
    const createPromise = client.createInstance({ signal: controller.signal });

    controller.abort();
    await expect(createPromise).rejects.toMatchObject({ name: 'AbortError' });

    resolveCreate({ metadata: { name: 'roomote-blaxel-late' } });
    await vi.waitFor(() => {
      expect(blaxelDeleteMock).toHaveBeenCalledWith('roomote-blaxel-late');
    });
  });

  it('retries Blaxel file writes while the workload data plane is starting', async () => {
    vi.useFakeTimers();
    try {
      const writeBinary = vi
        .fn()
        .mockRejectedValueOnce(
          new Error('404 {"error":{"code":"WORKLOAD_UNAVAILABLE"}}'),
        )
        .mockResolvedValue(undefined);
      blaxelGetMock.mockResolvedValue({ fs: { writeBinary } });
      const client = createComputeProviderClient({
        provider: 'blaxel',
        config: {
          apiKey: 'key',
          workspace: 'workspace',
          image: 'ghcr.io/roomote/worker:test',
        },
      });

      const writePromise = client.writeFiles({
        instanceId: 'sandbox-1',
        files: [{ path: '/sandbox/test', content: Buffer.from('test') }],
      });
      await vi.advanceTimersByTimeAsync(500);

      await expect(writePromise).resolves.toBeUndefined();
      expect(writeBinary).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('daytona adapter satisfies create/run/stream/status/destroy contract', async () => {
    const daytonaSandbox = {
      id: 'dtn-1',
      state: 'started',
      createdAt: new Date().toISOString(),
      getPreviewLink: vi.fn().mockImplementation(async (port: number) => {
        if (port === 4040) {
          throw new Error('No preview link for port 4040');
        }

        return { sandboxId: 'dtn-1', url: `https://${port}-dtn-1.proxy.test` };
      }),
      process: {
        executeCommand: vi.fn().mockResolvedValue({
          exitCode: 0,
          result: 'hello',
        }),
        createSession: vi.fn().mockResolvedValue(undefined),
        executeSessionCommand: vi.fn().mockResolvedValue({ cmdId: 'cmd-9' }),
        getSessionCommand: vi.fn().mockResolvedValue({
          id: 'cmd-9',
          command: 'worker run 123',
          exitCode: undefined,
        }),
        getSessionCommandLogs: vi
          .fn()
          .mockImplementation(
            async (
              _sessionId: string,
              _cmdId: string,
              onStdout?: (chunk: string) => void,
              onStderr?: (chunk: string) => void,
            ) => {
              if (onStdout && onStderr) {
                onStdout('line1');
                onStderr('line2');
                return undefined;
              }

              return { output: 'line1line2', stdout: 'line1', stderr: 'line2' };
            },
          ),
      },
      fs: {
        uploadFiles: vi.fn().mockResolvedValue(undefined),
      },
      delete: vi.fn().mockResolvedValue(undefined),
      _experimental_createSnapshot: vi.fn().mockResolvedValue(undefined),
    };

    daytonaCreateMock.mockResolvedValue(daytonaSandbox);
    daytonaGetMock.mockResolvedValue(daytonaSandbox);
    daytonaListMock.mockReturnValue(
      (async function* () {
        yield daytonaSandbox;
      })(),
    );

    const client = createComputeProviderClient({
      provider: 'daytona',
      config: {
        apiKey: 'daytona-key',
        snapshotName: 'roomote-worker',
        timeoutMs: 30 * 60_000,
      },
    });

    expect(client.capabilities.supportsSnapshots).toBe(true);
    expect(client.capabilities.supportsResume).toBe(true);
    expect(client.capabilities.supportsCommandOutputStreaming).toBe(true);
    expect(client.capabilities.supportsCommandOutputLookup).toBe(true);

    const instances = await client.listInstances({});
    expect(instances.map((instance) => instance.instanceId)).toEqual(['dtn-1']);

    const created = await client.createInstance({
      ports: [3000],
      tags: { app_environment: 'development' },
    });
    expect(created.instanceId).toBe('dtn-1');
    expect(created.domains).toEqual({
      '3000': 'https://3000-dtn-1.proxy.test',
    });
    expect(daytonaCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: 'roomote-worker',
        public: true,
        autoStopInterval: 30,
        labels: { app_environment: 'development' },
      }),
    );

    const runResult = await client.runCommand({
      instanceId: 'dtn-1',
      cmd: 'echo',
      args: ['hello'],
    });
    expect(runResult).toEqual({
      commandId: undefined,
      exitCode: 0,
      stdout: 'hello',
    });
    expect(daytonaSandbox.process.executeCommand).toHaveBeenCalledWith(
      'echo hello',
      undefined,
      expect.objectContaining({ HOME: '/home/roomote' }),
    );

    const detached = await client.runCommand({
      instanceId: 'dtn-1',
      cmd: 'worker',
      args: ['run', '123'],
      detached: true,
    });
    expect(detached.exitCode).toBeNull();
    expect(detached.commandId).toMatch(/^roomote-.+::cmd-9$/);
    expect(daytonaSandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      expect.stringMatching(/^roomote-/),
      expect.objectContaining({
        runAsync: true,
        command: expect.stringContaining('worker run 123'),
      }),
    );

    const logs = await collectLogs(
      client.streamCommandOutput({
        instanceId: 'dtn-1',
        commandId: detached.commandId!,
      }),
    );
    expect(logs).toEqual([
      { stream: 'stdout', data: 'line1' },
      { stream: 'stderr', data: 'line2' },
    ]);

    await expect(
      client.getCommandOutput({
        instanceId: 'dtn-1',
        commandId: detached.commandId!,
        stream: 'stdout',
      }),
    ).resolves.toBe('line1');

    await client.writeFiles({
      instanceId: 'dtn-1',
      files: [{ path: '/sandbox/worker.tar.gz', content: Buffer.from('x') }],
    });
    expect(daytonaSandbox.fs.uploadFiles).toHaveBeenCalledWith([
      {
        source: expect.any(Buffer),
        destination: '/sandbox/worker.tar.gz',
      },
    ]);

    const status = await client.getInstanceStatus({ instanceId: 'dtn-1' });
    expect(status.status).toBe('running');

    const snapshot = await client.createSnapshot({ instanceId: 'dtn-1' });
    expect(snapshot.snapshotId).toMatch(/^roomote-run-snap-dtn-1-/);
    expect(daytonaSandbox._experimental_createSnapshot).toHaveBeenCalledWith(
      snapshot.snapshotId,
      20 * 60,
    );
    // Snapshot path destroys the source sandbox after capture.
    expect(daytonaSandbox.delete).toHaveBeenCalledTimes(1);

    const resumeSandbox = {
      ...daytonaSandbox,
      id: 'dtn-resume',
      delete: vi.fn().mockResolvedValue(undefined),
      getPreviewLink: vi.fn().mockResolvedValue({
        sandboxId: 'dtn-resume',
        url: 'https://3000-dtn-resume.proxy.test',
      }),
    };
    daytonaCreateMock.mockResolvedValueOnce(resumeSandbox);

    const resumed = await client.resumeFromSnapshot({
      sourceSnapshotId: snapshot.snapshotId,
      ports: [3000],
    });
    expect(resumed).toEqual({
      instanceId: 'dtn-resume',
      status: 'running',
      sourceSnapshotId: snapshot.snapshotId,
      domains: { '3000': 'https://3000-dtn-resume.proxy.test' },
    });
    expect(daytonaCreateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshot: snapshot.snapshotId,
        public: true,
      }),
    );

    await client.destroyInstance({ instanceId: 'dtn-resume' });
    expect(resumeSandbox.delete).toHaveBeenCalledTimes(1);
  });

  it('e2b adapter satisfies create/run/stream/status/destroy contract', async () => {
    const now = Date.now();

    // Fake per-sandbox filesystem backing detached command log lookups.
    const sandboxFs = new Map<string, string>();

    const runCommandMock = vi
      .fn()
      .mockImplementation(
        async (command: string, opts?: { background?: boolean }) => {
          if (opts?.background) {
            return {
              pid: 42,
              disconnect: vi.fn().mockResolvedValue(undefined),
            };
          }

          const tailMatch = command.match(/^tail -c \+(\d+) (\S+)/);

          if (tailMatch) {
            const content = sandboxFs.get(tailMatch[2]!) ?? '';
            return {
              exitCode: 0,
              stdout: content.slice(Number(tailMatch[1]) - 1),
              stderr: '',
            };
          }

          if (command.includes('echo hello')) {
            return { exitCode: 0, stdout: 'hello', stderr: '' };
          }

          return { exitCode: 0, stdout: '', stderr: '' };
        },
      );

    const e2bSandbox = {
      sandboxId: 'e2b-1',
      getHost: (port: number) => `${port}-e2b-1.e2b.test`,
      commands: { run: runCommandMock },
      files: {
        read: vi.fn().mockImplementation(async (path: string) => {
          const content = sandboxFs.get(path);

          if (content === undefined) {
            throw new E2bNotFoundError(`file not found: ${path}`);
          }

          return content;
        }),
        write: vi.fn().mockResolvedValue(undefined),
      },
      kill: vi.fn().mockResolvedValue(undefined),
    };

    e2bCreateMock.mockResolvedValue(e2bSandbox);
    e2bConnectMock.mockResolvedValue(e2bSandbox);
    e2bKillMock.mockResolvedValue(true);
    e2bGetInfoMock.mockResolvedValue({
      sandboxId: 'e2b-1',
      state: 'running',
      startedAt: new Date(now - 5_000),
      endAt: new Date(now + 60_000),
    });

    let listExhausted = false;
    e2bListMock.mockReturnValue({
      get hasNext() {
        return !listExhausted;
      },
      nextItems: async () => {
        listExhausted = true;
        return [
          {
            sandboxId: 'e2b-1',
            state: 'running',
            startedAt: new Date(now - 5_000),
            endAt: new Date(now + 60_000),
          },
        ];
      },
    });

    const client = createComputeProviderClient({
      provider: 'e2b',
      config: {
        apiKey: 'e2b-key',
        templateId: 'roomote-worker',
        timeoutMs: 30 * 60_000,
      },
    });

    expect(client.capabilities.supportsSnapshots).toBe(true);
    expect(client.capabilities.supportsResume).toBe(true);
    expect(client.capabilities.supportsCommandOutputStreaming).toBe(true);
    expect(client.capabilities.supportsCommandOutputLookup).toBe(true);

    const instances = await client.listInstances({});
    expect(instances.map((instance) => instance.instanceId)).toEqual(['e2b-1']);

    const created = await client.createInstance({
      ports: [3000],
      tags: { app_environment: 'development' },
    });
    expect(created.instanceId).toBe('e2b-1');
    expect(created.domains).toEqual({
      '3000': 'https://3000-e2b-1.e2b.test',
    });
    expect(e2bCreateMock).toHaveBeenCalledWith(
      'roomote-worker',
      expect.objectContaining({
        apiKey: 'e2b-key',
        timeoutMs: 30 * 60_000,
        metadata: { app_environment: 'development' },
      }),
    );

    const runResult = await client.runCommand({
      instanceId: 'e2b-1',
      cmd: 'echo',
      args: ['hello'],
    });
    expect(runResult).toEqual({
      commandId: undefined,
      exitCode: 0,
      stdout: 'hello',
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      expect.stringMatching(/^env .*HOME=\/home\/roomote.* echo hello$/),
      expect.objectContaining({ timeoutMs: 0, user: 'root' }),
    );

    const detached = await client.runCommand({
      instanceId: 'e2b-1',
      cmd: 'worker',
      args: ['run', '123'],
      detached: true,
    });
    expect(detached.exitCode).toBeNull();
    expect(detached.commandId).toMatch(/^42::roomote-.+$/);
    expect(runCommandMock).toHaveBeenCalledWith(
      expect.stringContaining('worker run 123'),
      expect.objectContaining({ background: true, user: 'root' }),
    );

    const logId = detached.commandId!.split('::')[1]!;
    sandboxFs.set(`/tmp/roomote-commands/${logId}.exit`, '0\n');
    sandboxFs.set(`/tmp/roomote-commands/${logId}.out`, 'line1');
    sandboxFs.set(`/tmp/roomote-commands/${logId}.err`, 'line2');

    const logs = await collectLogs(
      client.streamCommandOutput({
        instanceId: 'e2b-1',
        commandId: detached.commandId!,
      }),
    );
    expect(logs).toEqual([
      { stream: 'stdout', data: 'line1' },
      { stream: 'stderr', data: 'line2' },
    ]);

    await expect(
      client.getCommandOutput({
        instanceId: 'e2b-1',
        commandId: detached.commandId!,
        stream: 'stdout',
      }),
    ).resolves.toBe('line1');

    await client.writeFiles({
      instanceId: 'e2b-1',
      files: [{ path: '/sandbox/worker.tar.gz', content: Buffer.from('x') }],
    });
    expect(e2bSandbox.files.write).toHaveBeenCalledWith(
      '/sandbox/worker.tar.gz',
      expect.any(Blob),
      { user: 'root' },
    );

    const status = await client.getInstanceStatus({ instanceId: 'e2b-1' });
    expect(status.status).toBe('running');
    expect(status.timeoutRemainingMs).toBeGreaterThan(0);

    e2bCreateSnapshotMock.mockResolvedValue({
      snapshotId: 'snap-e2b-1:latest',
      names: ['team/snap-e2b-1:latest'],
    });

    const snapshot = await client.createSnapshot({ instanceId: 'e2b-1' });
    expect(snapshot).toEqual({ snapshotId: 'snap-e2b-1:latest' });
    expect(e2bCreateSnapshotMock).toHaveBeenCalledWith(
      'e2b-1',
      expect.objectContaining({ apiKey: 'e2b-key' }),
    );
    // Snapshot creation kills the source sandbox to match the shared
    // snapshot-destroys-sandbox contract.
    expect(e2bKillMock).toHaveBeenCalledWith(
      'e2b-1',
      expect.objectContaining({ apiKey: 'e2b-key' }),
    );

    const resumed = await client.resumeFromSnapshot({
      sourceSnapshotId: 'snap-e2b-1:latest',
      ports: [3000],
    });
    expect(resumed.instanceId).toBe('e2b-1');
    expect(resumed.sourceSnapshotId).toBe('snap-e2b-1:latest');
    expect(resumed.domains).toEqual({
      '3000': 'https://3000-e2b-1.e2b.test',
    });
    expect(e2bCreateMock).toHaveBeenLastCalledWith(
      'snap-e2b-1:latest',
      expect.objectContaining({ apiKey: 'e2b-key' }),
    );

    e2bKillMock.mockClear();
    await client.destroyInstance({ instanceId: 'e2b-1' });
    expect(e2bKillMock).toHaveBeenCalledWith(
      'e2b-1',
      expect.objectContaining({ apiKey: 'e2b-key' }),
    );
  });
});
