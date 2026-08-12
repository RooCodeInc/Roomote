import {
  DEFAULT_BOX_API_BASE_URL,
  BoxApiError,
  BoxClient,
  deriveBoxMachineName,
} from './box';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BoxClient Public API v1', () => {
  it('creates with exact lifecycle fields, renames, polls idle, and hosts privately with a synchronous command', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ id: 'box-generated', state: 'provisioning' }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'box-generated', state: 'idle' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          stdout: 'Hosted at https://private.box.test/path?token=secret\n',
          stderr: '',
          exitCode: 0,
        }),
      );
    const client = new BoxClient({
      apiKey: 'box-secret',
      boxApiBaseUrl: 'https://box.example.test/v1/',
      timeoutMs: 1_501,
      machineType: 'large',
      pollIntervalMs: 0,
      fetchImpl,
    });

    await expect(
      client.createInstance({
        idempotencyKey: 'task:123',
        ports: [3000],
      }),
    ).resolves.toEqual({
      instanceId: 'box-generated',
      status: 'running',
      domains: {
        '3000': 'https://private.box.test/path?token=secret',
      },
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://box.example.test/v1/boxes',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer box-secret',
        }),
        body: JSON.stringify({
          noEnv: true,
          ttlSeconds: 2,
          type: 'large',
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://box.example.test/v1/boxes/box-generated',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: deriveBoxMachineName('task:123') }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      'https://box.example.test/v1/boxes/box-generated/commands',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          command: `'host' '3000' '--private'`,
        }),
      }),
    );
  });

  it('uses ttlSeconds lifecycle metadata and PUT base64 file writes', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'box-1', state: 'ready' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new BoxClient({
      apiKey: 'key',
      fetchImpl,
    });

    await client.createInstance({
      metadata: {
        'box.ttlSeconds': '200',
        'box.type': 'small',
        'box.env': '{"LIFECYCLE_VALUE":"safe"}',
      },
    });
    await client.writeFiles({
      instanceId: 'box-1',
      files: [{ path: '/tmp/value.bin', content: Buffer.from([0, 1, 2]) }],
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      `${DEFAULT_BOX_API_BASE_URL}/boxes`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          noEnv: true,
          ttlSeconds: 200,
          type: 'small',
          env: { LIFECYCLE_VALUE: 'safe' },
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-1/files`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          path: '/tmp/value.bin',
          content: 'AAEC',
          encoding: 'base64',
        }),
      }),
    );
  });

  it('runs synchronous commands directly and shell-quotes args and launch env', async () => {
    const onOutput = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ stdout: 'ok', stderr: 'warning', exitCode: 7 }),
      );
    const client = new BoxClient({ apiKey: 'key', fetchImpl });

    await expect(
      client.runCommand({
        instanceId: 'box-1',
        cmd: 'echo',
        args: ['hello world'],
        cwd: '/tmp/work',
        env: { TOKEN: "a'b" },
        onOutput,
      }),
    ).resolves.toEqual({ exitCode: 7, stdout: 'ok', stderr: 'warning' });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-1/commands`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          command: `env 'TOKEN=a'"'"'b' 'echo' 'hello world'`,
          cwd: '/tmp/work',
        }),
      }),
    );
    expect(onOutput).toHaveBeenCalledWith({ stream: 'stdout', data: 'ok' });
    expect(onOutput).toHaveBeenCalledWith({
      stream: 'stderr',
      data: 'warning',
    });
  });

  it('uses integer process IDs for detached polling and streams flat status deltas through exited', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ processId: 42 }))
      .mockResolvedValueOnce(
        jsonResponse({
          processId: 42,
          status: 'running',
          stdout: 'one',
          stderr: '',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          processId: 42,
          status: 'exited',
          stdout: 'one-two',
          stderr: 'warning',
          exitCode: 0,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          processId: 42,
          status: 'exited',
          stdout: 'one-two',
          stderr: 'warning',
          exitCode: 0,
        }),
      );
    const client = new BoxClient({
      apiKey: 'key',
      pollIntervalMs: 0,
      fetchImpl,
    });

    await expect(
      client.runCommand({
        instanceId: 'box-1',
        cmd: 'worker',
        args: ['run'],
        detached: true,
      }),
    ).resolves.toEqual({ commandId: '42', exitCode: null });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      command: `'worker' 'run'`,
      detached: true,
    });

    const events = [];
    for await (const event of client.streamCommandOutput({
      instanceId: 'box-1',
      commandId: '42',
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { stream: 'stdout', data: 'one' },
      { stream: 'stdout', data: '-two' },
      { stream: 'stderr', data: 'warning' },
    ]);
    await expect(
      client.getCommandOutput({
        instanceId: 'box-1',
        commandId: '42',
        stream: 'stderr',
      }),
    ).resolves.toBe('warning');
  });

  it('maps machine state and archiveAfter from list and status responses', async () => {
    const archiveAfter = new Date(Date.now() + 60_000).toISOString();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'ready', state: 'ready', archiveAfter },
          { id: 'idle', state: 'idle', archiveAfter },
          { id: 'clone', state: 'cloning', archiveAfter },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 'init', state: 'init', archiveAfter }),
      );
    const client = new BoxClient({ apiKey: 'key', fetchImpl });

    await expect(client.listInstances({})).resolves.toEqual([
      expect.objectContaining({ instanceId: 'ready', status: 'running' }),
      expect.objectContaining({ instanceId: 'idle', status: 'running' }),
      expect.objectContaining({ instanceId: 'clone', status: 'pending' }),
    ]);
    await expect(
      client.getInstanceStatus({ instanceId: 'init' }),
    ).resolves.toEqual({
      status: 'pending',
      timeoutRemainingMs: expect.any(Number),
    });
  });

  it('stops once and polls until archived for standby and destroy', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'box-1', state: 'stopping' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'box-1', state: 'archived' }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'box-2', state: 'archived' }));
    const client = new BoxClient({
      apiKey: 'key',
      pollIntervalMs: 0,
      fetchImpl,
    });

    await expect(
      client.enterStandby?.({ instanceId: 'box-1' }),
    ).resolves.toEqual({ resumeHandle: 'box-1' });
    await client.destroyInstance({ instanceId: 'box-2' });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-1/stop`,
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-1`,
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-1`,
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-2/stop`,
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-2`,
    ]);
    expect(
      fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/archive')),
    ).toBe(false);
  });

  it('treats a 404 while polling archive status as already cleaned up', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ code: 'not_found' }, 404));
    const client = new BoxClient({ apiKey: 'key', fetchImpl });

    await expect(
      client.destroyInstance({ instanceId: 'box-gone' }),
    ).resolves.toEqual({});
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-gone/stop`,
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-gone`,
    ]);
  });

  it('resumes the same ID with refreshed lifecycle fields and polls provisioned to ready', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'box-1', state: 'provisioned' }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'box-1', state: 'ready' }));
    const client = new BoxClient({
      apiKey: 'key',
      timeoutMs: 90_001,
      machineType: 'default',
      pollIntervalMs: 0,
      fetchImpl,
    });

    await expect(
      client.resumeFromStandby?.({
        resumeHandle: 'box-1',
        metadata: { 'box.env': '{"LIFECYCLE":"value"}' },
      }),
    ).resolves.toMatchObject({
      instanceId: 'box-1',
      sourceSnapshotId: 'box-1',
      status: 'running',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-1/resume`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          noEnv: true,
          ttlSeconds: 91,
          type: 'default',
          env: { LIFECYCLE: 'value' },
        }),
      }),
    );
  });

  it('stops a known created ID after post-rename readiness failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ id: 'box-failed', state: 'provisioning' }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'box-failed', state: 'failed' }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'box-failed', state: 'archived' }),
      );
    const client = new BoxClient({
      apiKey: 'key',
      pollIntervalMs: 0,
      fetchImpl,
    });

    await expect(
      client.createInstance({ idempotencyKey: 'task:failed' }),
    ).rejects.toThrow('entered failed while waiting for readiness');
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${DEFAULT_BOX_API_BASE_URL}/boxes`,
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-failed`,
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-failed`,
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-failed/stop`,
      `${DEFAULT_BOX_API_BASE_URL}/boxes/box-failed`,
    ]);
  });

  it('uses error-body requestId when the response header is absent', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          code: 'denied',
          requestId: 'request-from-body',
          message: 'token=server-secret',
        },
        401,
      ),
    );
    const client = new BoxClient({ apiKey: 'client-secret', fetchImpl });

    const error = await client.listInstances({}).catch((value) => value);
    expect(error).toBeInstanceOf(BoxApiError);
    expect(error).toMatchObject({
      metadata: {
        method: 'GET',
        path: '/boxes',
        status: 401,
        errorCode: 'denied',
        requestId: 'request-from-body',
      },
    });
    expect(JSON.stringify(error)).not.toContain('client-secret');
    expect(error.message).not.toContain('server-secret');
  });

  it('rejects snapshot operations', async () => {
    const client = new BoxClient({ apiKey: 'key' });
    await expect(
      client.createSnapshot({ instanceId: 'box-1' }),
    ).rejects.toThrow('does not support operation: createSnapshot');
    await expect(
      client.resumeFromSnapshot({ sourceSnapshotId: 'snap-1' }),
    ).rejects.toThrow('does not support operation: resumeFromSnapshot');
  });
});
