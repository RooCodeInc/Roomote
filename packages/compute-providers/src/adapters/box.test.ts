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

    // Standby preserves the snapshot; destroy discards with force.
    const stopBodies = fetchImpl.mock.calls
      .filter(([url]) => String(url).endsWith('/stop'))
      .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : null));
    expect(stopBodies).toEqual([null, { force: true }]);
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
          message: 'insufficient permission',
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
  });

  it('surfaces the error-body code and message in the thrown message', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          type: 'box.error',
          status: 400,
          code: 'trial_auto_stop_required',
          message:
            'Free-trial Boxes can auto-stop after at most 2 hours. Choose 2 hours or less.',
        },
        400,
      ),
    );
    const client = new BoxClient({ apiKey: 'client-secret', fetchImpl });

    const error = await client.listInstances({}).catch((value) => value);
    expect(error).toBeInstanceOf(BoxApiError);
    expect(error.message).toBe(
      'Box API GET /boxes failed with status 400 (trial_auto_stop_required): ' +
        'Free-trial Boxes can auto-stop after at most 2 hours. Choose 2 hours or less.',
    );
  });

  it('falls back to the nested error object and redacts the API key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          error: {
            code: 'unauthorized',
            message: `bad bearer token client-secret; try again with ${'x'.repeat(400)}`,
          },
        },
        401,
      ),
    );
    const client = new BoxClient({ apiKey: 'client-secret', fetchImpl });

    const error = await client.listInstances({}).catch((value) => value);
    expect(error).toBeInstanceOf(BoxApiError);
    expect(error.metadata.errorCode).toBe('unauthorized');
    expect(error.message).toContain('(unauthorized): bad bearer token');
    expect(error.message).not.toContain('client-secret');
    expect(error.message).toContain('[redacted]');
    expect(error.metadata.errorMessage.length).toBeLessThanOrEqual(301);
  });

  it('retries provisioning 409s on mutations until the box comes up', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 'machine_not_running' }, 409))
      .mockResolvedValueOnce(jsonResponse({ code: 'box_starting' }, 409))
      .mockResolvedValueOnce(
        jsonResponse({ processId: 42, status: 'running' }),
      );
    const client = new BoxClient({
      apiKey: 'key',
      pollIntervalMs: 0,
      fetchImpl,
    });

    const result = await client.runCommand({
      instanceId: 'box-1',
      cmd: 'echo',
      args: ['hi'],
      detached: true,
    });
    expect(result.commandId).toBe('42');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      fetchImpl.mock.calls.every(
        ([url]) => url === `${DEFAULT_BOX_API_BASE_URL}/boxes/box-1/commands`,
      ),
    ).toBe(true);
  });

  it('does not retry non-provisioning 409s', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ code: 'conflict' }, 409));
    const client = new BoxClient({
      apiKey: 'key',
      pollIntervalMs: 0,
      fetchImpl,
    });

    await expect(
      client.runCommand({ instanceId: 'box-1', cmd: 'echo' }),
    ).rejects.toThrow('failed with status 409 (conflict)');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps provisioning-phase states to pending', async () => {
    for (const state of ['box_starting', 'machine_not_running']) {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ id: 'box-1', state }));
      const client = new BoxClient({ apiKey: 'key', fetchImpl });
      await expect(
        client.getInstanceStatus({ instanceId: 'box-1' }),
      ).resolves.toMatchObject({ status: 'pending' });
    }
  });

  it('hosts the sandbox server publicly with a bare-origin URL and app ports privately', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          stdout: 'Hosted at https://box-4200.on.test/\n',
          stderr: '',
          exitCode: 0,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          stdout: 'Hosted at https://box-3000.on.test/?_token=secret\n',
          stderr: '',
          exitCode: 0,
        }),
      );
    const client = new BoxClient({ apiKey: 'key', fetchImpl });

    await expect(
      client.getInstanceDomains({ instanceId: 'box-1', ports: [4200, 3000] }),
    ).resolves.toEqual({
      domains: {
        '4200': 'https://box-4200.on.test',
        '3000': 'https://box-3000.on.test?_token=secret',
      },
    });
    expect(
      fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual([
      { command: `'host' '4200' '--public'` },
      { command: `'host' '3000' '--private'` },
    ]);
  });

  it('creates a named snapshot, persists the id, then force-stops the box', async () => {
    // The generated name is random; make the list response echo it back.
    let capturedName = '';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        const path = String(url);
        if (path.endsWith('/named-snapshots') && init?.method === 'POST') {
          capturedName = (JSON.parse(String(init.body)) as { name: string })
            .name;
          return new Response(null, { status: 202 });
        }
        if (path.endsWith('/named-snapshots')) {
          return jsonResponse({
            snapshots: [{ name: capturedName, status: 'ready' }],
          });
        }
        if (path.endsWith('/stop')) return new Response(null, { status: 202 });
        return jsonResponse({ id: 'box-1', state: 'archived' });
      });
    const client = new BoxClient({
      apiKey: 'key',
      pollIntervalMs: 0,
      fetchImpl,
    });

    const events: string[] = [];
    const result = await client.createSnapshot({
      instanceId: 'box-1',
      onSnapshotCreated: async (id) => {
        events.push(`persisted:${id}`);
      },
    });

    expect(result.snapshotId).toBe(capturedName);
    expect(result.snapshotId.startsWith('roomote-snap-')).toBe(true);
    expect(events).toEqual([`persisted:${capturedName}`]);

    const createCall = fetchImpl.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/named-snapshots') && init?.method === 'POST',
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      boxId: 'box-1',
      name: capturedName,
    });
    const stopCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith('/stop'),
    );
    expect(JSON.parse(String(stopCall?.[1]?.body))).toEqual({ force: true });
  });

  it('fails createSnapshot when the named snapshot reports failure', async () => {
    let capturedName = '';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        if (init?.method === 'POST') {
          capturedName = (JSON.parse(String(init.body)) as { name: string })
            .name;
          return new Response(null, { status: 202 });
        }
        return jsonResponse({
          snapshots: [{ name: capturedName, status: 'failed' }],
        });
      });
    const client = new BoxClient({
      apiKey: 'key',
      pollIntervalMs: 0,
      fetchImpl,
    });

    await expect(
      client.createSnapshot({ instanceId: 'box-1' }),
    ).rejects.toThrow('entered failed while waiting for completion');
  });

  it('forks a template via POST /boxes with from and keeps lifecycle fields', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'box-fork', state: 'ready' }));
    const client = new BoxClient({
      apiKey: 'key',
      timeoutMs: 60_000,
      machineType: 'small',
      fetchImpl,
    });

    const created = await client.resumeFromSnapshot({
      sourceSnapshotId: 'roomote-snap-abc123',
    });

    expect(created).toMatchObject({
      instanceId: 'box-fork',
      sourceSnapshotId: 'roomote-snap-abc123',
      status: 'running',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${DEFAULT_BOX_API_BASE_URL}/boxes`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          noEnv: true,
          ttlSeconds: 60,
          type: 'small',
          from: 'roomote-snap-abc123',
        }),
      }),
    );
  });
});
