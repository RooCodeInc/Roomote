import * as fs from 'node:fs';

import { ModalRpcError } from '../errors';
import { MODAL_GH_CLI_VERSION, ModalClient } from './modal';

const DEFAULT_OPENCODE_CLI_VERSION = '1.17.8';
const ROOMOTE_BAKED_OPENCODE_CLI_VERSION_ENV =
  'ROOMOTE_BAKED_OPENCODE_CLI_VERSION';

const {
  sandboxFromIdMock,
  sandboxCreateMock,
  appFromNameMock,
  imageFromRegistryMock,
  imageFromAwsEcrMock,
  imageFromIdMock,
  secretFromObjectMock,
} = vi.hoisted(() => ({
  sandboxFromIdMock: vi.fn(),
  sandboxCreateMock: vi.fn(),
  appFromNameMock: vi.fn(),
  imageFromRegistryMock: vi.fn(),
  imageFromAwsEcrMock: vi.fn(),
  imageFromIdMock: vi.fn(),
  secretFromObjectMock: vi.fn(),
}));

vi.mock('modal', () => {
  class MockSdkModalClient {
    public readonly sandboxes = {
      fromId: sandboxFromIdMock,
      list: async function* () {},
      create: sandboxCreateMock,
    };

    public readonly apps = {
      fromName: appFromNameMock,
    };

    public readonly secrets = {
      fromObject: secretFromObjectMock,
    };

    public readonly images = {
      fromRegistry: imageFromRegistryMock,
      fromAwsEcr: imageFromAwsEcrMock,
    };

    public constructor(_config: unknown) {}
  }

  return {
    ModalClient: MockSdkModalClient,
    Image: {
      fromId: imageFromIdMock,
    },
  };
});

describe('ModalClient', () => {
  const MODAL_IMAGE_REF = 'ghcr.io/roomote/modal-worker:test';

  beforeEach(() => {
    vi.clearAllMocks();
    imageFromRegistryMock.mockReturnValue({ imageId: 'img-123' });
    imageFromAwsEcrMock.mockReturnValue({ imageId: 'img-ecr-123' });
    imageFromIdMock.mockResolvedValue({ imageId: 'img-snap-123' });
    appFromNameMock.mockResolvedValue({ appId: 'app-123' });
    secretFromObjectMock.mockResolvedValue({ secretId: 'sec-123' });
  });

  afterEach(() => {
    (
      ModalClient as unknown as {
        sandboxCache: { clear: () => void };
      }
    ).sandboxCache.clear();
  });

  it('does not mutate the caller config object', () => {
    const config = {
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
      cpu: 0.125,
      memoryMiB: 128,
    };

    new ModalClient(config);

    expect(config).toEqual({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
      cpu: 0.125,
      memoryMiB: 128,
    });
  });

  it('requires an explicit baked Modal base image ref', () => {
    expect(
      () =>
        new ModalClient({
          tokenId: 'token-id',
          tokenSecret: 'token-secret',
        } as never),
    ).toThrow(
      'Modal requires an explicit baseImageRef for the baked worker image',
    );
  });

  it('requires complete private registry credentials', () => {
    expect(
      () =>
        new ModalClient({
          tokenId: 'token-id',
          tokenSecret: 'token-secret',
          baseImageRef: MODAL_IMAGE_REF,
          registryUsername: 'ghcr-user',
        }),
    ).toThrow(
      'Modal registry auth requires both registryUsername and registryPassword',
    );
  });

  it('rejects private registry credentials with ECR OIDC config', () => {
    expect(
      () =>
        new ModalClient({
          tokenId: 'token-id',
          tokenSecret: 'token-secret',
          baseImageRef: MODAL_IMAGE_REF,
          registryUsername: 'ghcr-user',
          registryPassword: 'ghcr-token',
          ecrOidcRoleArn: 'arn:aws:iam::123456789012:role/modal',
          ecrRegion: 'us-east-1',
        }),
    ).toThrow(
      'Modal registry auth and ECR OIDC auth cannot be configured together',
    );
  });

  it('retries app resolution after an initial failure', async () => {
    appFromNameMock
      .mockRejectedValueOnce(new Error('temporary lookup failure'))
      .mockResolvedValueOnce({ appId: 'app-123' });
    sandboxCreateMock.mockResolvedValue({
      sandboxId: 'modal-123',
      tunnels: vi.fn().mockResolvedValue({}),
    });

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
    });

    await expect(client.createInstance({})).rejects.toThrow(
      'temporary lookup failure',
    );
    await expect(client.createInstance({})).resolves.toMatchObject({
      instanceId: 'modal-123',
    });
    expect(appFromNameMock).toHaveBeenCalledTimes(2);
    expect(sandboxCreateMock).toHaveBeenCalledWith(
      { appId: 'app-123' },
      { imageId: 'img-123' },
      expect.objectContaining({ workdir: '/sandbox' }),
    );
  });

  it('normalizes Modal app resolution failures into structured errors', async () => {
    appFromNameMock.mockRejectedValue(
      new Error(
        '/modal.client.ModalClient/AppGetOrCreate UNAVAILABLE: Authorization check failed for app roomote-production; status = StatusCode.DEADLINE_EXCEEDED',
      ),
    );

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
    });

    const error = await client.createInstance({}).catch((err) => err);

    expect(error).toBeInstanceOf(ModalRpcError);
    expect(error).toMatchObject({
      metadata: {
        grpcStatus: 'DEADLINE_EXCEEDED',
        operation: 'app_resolve',
        rpcMethod: 'AppGetOrCreate',
        rpcPath: '/modal.client.ModalClient/AppGetOrCreate',
        rpcService: 'modal.client.ModalClient',
      },
    });
  });

  it('normalizes Modal secret resolution failures into structured errors', async () => {
    secretFromObjectMock.mockRejectedValue(
      new Error(
        '/modal.client.ModalClient/SecretGetOrCreate RESOURCE_EXHAUSTED: memory usage is too high',
      ),
    );

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
      ecrOidcRoleArn: 'arn:aws:iam::123456789012:role/modal',
      ecrRegion: 'us-east-1',
    });

    await expect(client.createInstance({})).rejects.toMatchObject({
      name: 'ModalRpcError',
      metadata: {
        grpcStatus: 'RESOURCE_EXHAUSTED',
        operation: 'secret_resolve',
        rpcMethod: 'SecretGetOrCreate',
        rpcPath: '/modal.client.ModalClient/SecretGetOrCreate',
        rpcService: 'modal.client.ModalClient',
      },
    });
  });

  it('passes private registry credentials as a Modal registry secret', async () => {
    const registrySecret = { secretId: 'sec-registry-123' };
    secretFromObjectMock.mockResolvedValue(registrySecret);
    sandboxCreateMock.mockResolvedValue({
      sandboxId: 'modal-123',
      tunnels: vi.fn().mockResolvedValue({}),
    });

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
      registryUsername: 'ghcr-user',
      registryPassword: 'ghcr-token',
    });

    await expect(client.createInstance({})).resolves.toMatchObject({
      instanceId: 'modal-123',
    });

    expect(secretFromObjectMock).toHaveBeenCalledWith({
      REGISTRY_USERNAME: 'ghcr-user',
      REGISTRY_PASSWORD: 'ghcr-token',
    });
    expect(imageFromRegistryMock).toHaveBeenCalledWith(
      MODAL_IMAGE_REF,
      registrySecret,
    );
  });

  it('applies sandbox tags after creating a Modal instance', async () => {
    const setTagsMock = vi.fn().mockResolvedValue(undefined);

    sandboxCreateMock.mockResolvedValue({
      sandboxId: 'modal-123',
      setTags: setTagsMock,
      tunnels: vi.fn().mockResolvedValue({}),
    });

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
    });

    await expect(
      client.createInstance({
        tags: {
          app_environment: 'preview',
          organization_name: 'Acme Corp',
        },
      }),
    ).resolves.toMatchObject({
      instanceId: 'modal-123',
    });

    expect(setTagsMock).toHaveBeenCalledWith({
      app_environment: 'preview',
      organization_name: 'Acme Corp',
    });
  });

  it('keeps fresh Modal launches running when setting sandbox tags fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setTagsMock = vi
      .fn()
      .mockRejectedValue(new Error('tagging api blip'));

    sandboxCreateMock.mockResolvedValue({
      sandboxId: 'modal-123',
      setTags: setTagsMock,
      tunnels: vi.fn().mockResolvedValue({}),
    });

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
    });

    await expect(
      client.createInstance({
        tags: {
          app_environment: 'preview',
        },
      }),
    ).resolves.toMatchObject({
      instanceId: 'modal-123',
      status: 'running',
    });

    expect(setTagsMock).toHaveBeenCalledWith({
      app_environment: 'preview',
    });
    const warnMessage = warnSpy.mock.calls.at(0)?.[0];
    expect(warnMessage).toContain('[ModalClient] Failed to set sandbox tags');
    expect(warnMessage).toContain('"sandboxId":"modal-123"');

    warnSpy.mockRestore();
  });

  it('keeps Modal snapshot resumes running when setting sandbox tags fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setTagsMock = vi
      .fn()
      .mockRejectedValue(new Error('tagging api blip'));

    sandboxCreateMock.mockResolvedValue({
      sandboxId: 'modal-123',
      setTags: setTagsMock,
      tunnels: vi.fn().mockResolvedValue({}),
    });

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
    });

    await expect(
      client.resumeFromSnapshot({
        sourceSnapshotId: 'snap-123',
        tags: {
          app_environment: 'preview',
        },
      }),
    ).resolves.toMatchObject({
      instanceId: 'modal-123',
      status: 'running',
      sourceSnapshotId: 'snap-123',
    });

    expect(imageFromIdMock).toHaveBeenCalledWith('snap-123');
    expect(setTagsMock).toHaveBeenCalledWith({
      app_environment: 'preview',
    });
    const warnMessage = warnSpy.mock.calls.at(0)?.[0];
    expect(warnMessage).toContain('[ModalClient] Failed to set sandbox tags');
    expect(warnMessage).toContain('"sandboxId":"modal-123"');

    warnSpy.mockRestore();
  });

  it('forwards separate resource requests and hard limits to Modal sandbox creation', async () => {
    sandboxCreateMock.mockResolvedValue({
      sandboxId: 'modal-123',
      tunnels: vi.fn().mockResolvedValue({}),
    });

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
      cpu: 0.125,
      cpuLimit: 8,
      memoryMiB: 128,
      memoryLimitMiB: 32_768,
    });

    await client.createInstance({ ports: [3000] });

    expect(sandboxCreateMock).toHaveBeenCalledWith(
      { appId: 'app-123' },
      { imageId: 'img-123' },
      expect.objectContaining({
        encryptedPorts: [3000],
        cpu: 0.125,
        cpuLimit: 8,
        memoryMiB: 128,
        memoryLimitMiB: 32_768,
        workdir: '/sandbox',
      }),
    );
  });

  it('uses the longer snapshot deadline and normalizes Modal snapshot RPC failures', async () => {
    const snapshotFilesystemMock = vi
      .fn()
      .mockRejectedValue(
        new Error(
          '/modal.task_command_router.TaskCommandRouter/TaskSnapshotFilesystem DEADLINE_EXCEEDED: Timed out waiting for image to be created',
        ),
      );

    sandboxFromIdMock.mockResolvedValue({
      sandboxId: 'modal-123',
      snapshotFilesystem: snapshotFilesystemMock,
    });

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
    });

    await expect(
      client.createSnapshot({ instanceId: 'modal-123' }),
    ).rejects.toMatchObject({
      name: 'ModalRpcError',
      message:
        '/modal.task_command_router.TaskCommandRouter/TaskSnapshotFilesystem DEADLINE_EXCEEDED: Timed out waiting for image to be created',
      metadata: {
        grpcStatus: 'DEADLINE_EXCEEDED',
        operation: 'create_snapshot',
        rpcMethod: 'TaskSnapshotFilesystem',
        rpcPath:
          '/modal.task_command_router.TaskCommandRouter/TaskSnapshotFilesystem',
        rpcService: 'modal.task_command_router.TaskCommandRouter',
      },
    });
    expect(snapshotFilesystemMock).toHaveBeenCalledWith(20 * 60_000);
  });

  it('splits large file writes into multiple handle.write calls', async () => {
    const writeMock = vi.fn().mockResolvedValue(undefined);
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const openMock = vi.fn().mockResolvedValue({
      write: writeMock,
      close: closeMock,
    });
    const execWaitMock = vi.fn().mockResolvedValue(0);
    const execMock = vi.fn().mockResolvedValue({
      wait: execWaitMock,
    });

    sandboxFromIdMock.mockResolvedValue({
      sandboxId: 'modal-123',
      exec: execMock,
      open: openMock,
    });

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
    });

    const content = Buffer.alloc(20 * 1024 * 1024 + 321, 7);

    await client.writeFiles({
      instanceId: 'modal-123',
      files: [{ path: '/sandbox/worker.tar.gz', content }],
    });

    expect(execMock).toHaveBeenCalledWith(['mkdir', '-p', '/sandbox']);
    expect(openMock).toHaveBeenCalledWith('/sandbox/worker.tar.gz', 'w');
    expect(writeMock.mock.calls.length).toBeGreaterThan(1);

    const chunks = writeMock.mock.calls.map((call) =>
      Buffer.from(call[0] as Uint8Array),
    );

    expect(Buffer.compare(Buffer.concat(chunks), content)).toBe(0);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces immediate detached-process exits so callers can clean up', async () => {
    const execMock = vi.fn().mockResolvedValue({
      stdout: { readText: vi.fn().mockResolvedValue('boot stdout') },
      stderr: { readText: vi.fn().mockResolvedValue('boot stderr') },
      wait: vi.fn().mockResolvedValue(17),
    });

    sandboxFromIdMock.mockResolvedValue({
      sandboxId: 'modal-123',
      exec: execMock,
    });

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
    });

    const result = await client.runCommand({
      instanceId: 'modal-123',
      cmd: 'worker',
      args: ['run', '123'],
      detached: true,
    });

    expect(result).toEqual({
      commandId: undefined,
      exitCode: 17,
      stdout: 'boot stdout',
      stderr: 'boot stderr',
    });
    expect(execMock).toHaveBeenCalledWith(
      ['worker', 'run', '123'],
      expect.objectContaining({
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          HOME: '/home/roomote',
          USER: 'roomote',
          LOGNAME: 'roomote',
          PATH: '/home/roomote/.local/bin:/opt/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        },
      }),
    );
  });

  it('normalizes Modal exec failures into structured errors', async () => {
    const execMock = vi
      .fn()
      .mockRejectedValue(
        new Error(
          '/modal.task_command_router.TaskCommandRouter/TaskExecStart NOT_FOUND: Modal Sandbox with container ID ta-01KT20Z4JR98XWKQNBNVSXWWNH not found. This means this Sandbox has already shut down. (Error code: 7KJF5ETD)',
        ),
      );

    sandboxFromIdMock.mockResolvedValue({
      sandboxId: 'modal-123',
      exec: execMock,
    });

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
    });

    await expect(
      client.runCommand({
        instanceId: 'modal-123',
        cmd: 'worker',
        args: ['run', '123'],
      }),
    ).rejects.toMatchObject({
      name: 'ModalRpcError',
      metadata: {
        grpcStatus: 'NOT_FOUND',
        modalErrorCode: '7KJF5ETD',
        operation: 'command_exec',
        rpcMethod: 'TaskExecStart',
        rpcPath: '/modal.task_command_router.TaskCommandRouter/TaskExecStart',
        rpcService: 'modal.task_command_router.TaskCommandRouter',
      },
    });
  });

  it('preserves explicit env values when injecting roomote env', async () => {
    const execMock = vi.fn().mockResolvedValue({
      stdout: { readText: vi.fn().mockResolvedValue('') },
      stderr: { readText: vi.fn().mockResolvedValue('') },
      wait: vi.fn().mockResolvedValue(0),
    });

    sandboxFromIdMock.mockResolvedValue({
      sandboxId: 'modal-123',
      exec: execMock,
    });

    const client = new ModalClient({
      tokenId: 'token-id',
      tokenSecret: 'token-secret',
      baseImageRef: MODAL_IMAGE_REF,
    });

    await client.runCommand({
      instanceId: 'modal-123',
      cmd: 'bash',
      args: ['-lc', 'echo $HOME $TOKEN'],
      cwd: '/sandbox',
      env: {
        TOKEN: 'secret-token',
        HOME: '/tmp/custom-home',
      },
    });

    expect(execMock).toHaveBeenCalledWith(
      ['bash', '-lc', 'echo $HOME $TOKEN'],
      expect.objectContaining({
        workdir: '/sandbox',
        env: {
          HOME: '/tmp/custom-home',
          USER: 'roomote',
          LOGNAME: 'roomote',
          PATH: '/home/roomote/.local/bin:/opt/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          TOKEN: 'secret-token',
        },
      }),
    );
  });

  it('keeps the gh CLI version in sync with the worker Dockerfile', () => {
    const dockerfile = fs.readFileSync(
      new URL('../../../../apps/worker/Dockerfile', import.meta.url),
      'utf8',
    );
    const match = dockerfile.match(/^ARG GH_VERSION=(.+)$/m);

    expect(match?.[1]).toBe(MODAL_GH_CLI_VERSION);
  });

  it('keeps the worker agent-browser bootstrap in sync with the shared installer', () => {
    const dockerfile = fs.readFileSync(
      new URL('../../../../apps/worker/Dockerfile', import.meta.url),
      'utf8',
    );
    const installBrowserAgentScript = fs.readFileSync(
      new URL(
        '../../../../.docker/sandbox/install-browser-agent.sh',
        import.meta.url,
      ),
      'utf8',
    );

    const dockerfileVersion = dockerfile.match(
      /^ARG AGENT_BROWSER_VERSION=(.+)$/m,
    )?.[1];

    expect(dockerfile).toContain(
      'ENV AGENT_BROWSER_EXECUTABLE_PATH="/opt/agent-browser/chrome"',
    );
    expect(dockerfile).toContain('libatk1.0-0t64');
    expect(dockerfile).toContain('libatspi2.0-0t64');
    expect(dockerfile).toContain('libcups2t64');
    expect(dockerfile).toContain('libdbus-1-3');
    expect(dockerfile).toContain(
      'COPY .docker/sandbox/install-browser-agent.sh /tmp/install-browser-agent.sh',
    );
    expect(dockerfile).toContain('RUN bash /tmp/install-browser-agent.sh');
    expect(installBrowserAgentScript).toContain(
      'agent-browser@${AGENT_BROWSER_VERSION}',
    );
    expect(installBrowserAgentScript).toContain('collect_cli_browser_args()');
    expect(installBrowserAgentScript).toContain(
      'AGENT_BROWSER_FORWARD_ARGS=()',
    );
    expect(installBrowserAgentScript).toContain(
      'export AGENT_BROWSER_HEADED=false',
    );
    expect(installBrowserAgentScript).toContain(
      'exec "$AGENT_BROWSER_BIN" "${AGENT_BROWSER_FORWARD_ARGS[@]}"',
    );
    expect(dockerfile).not.toContain(
      '--window-size=${DEFAULT_BROWSER_WIDTH},${DEFAULT_BROWSER_HEIGHT}',
    );
    expect(dockerfileVersion).toBeDefined();
  });

  it('expects ffmpeg and ffprobe to be available in the worker runtime', () => {
    const dockerfile = fs.readFileSync(
      new URL('../../../../apps/worker/Dockerfile', import.meta.url),
      'utf8',
    );

    expect(dockerfile).toContain(
      'ENV FFMPEG_EXECUTABLE_PATH="/opt/ffmpeg/bin/ffmpeg"',
    );
    expect(dockerfile).toContain(
      'ENV FFPROBE_EXECUTABLE_PATH="/opt/ffmpeg/bin/ffprobe"',
    );
    expect(dockerfile).toContain(
      '"@ffmpeg-installer/ffmpeg@${FFMPEG_INSTALLER_VERSION}"',
    );
    expect(dockerfile).toContain(
      '"@ffprobe-installer/ffprobe@${FFPROBE_INSTALLER_VERSION}"',
    );
    expect(dockerfile).toContain(
      'sudo ln -sf "${FFPROBE_EXECUTABLE_PATH}" /usr/local/bin/ffprobe',
    );
  });

  it('expects PM2 to be available in the worker runtime', () => {
    const dockerfile = fs.readFileSync(
      new URL('../../../../apps/worker/Dockerfile', import.meta.url),
      'utf8',
    );

    expect(dockerfile).toContain('ARG PM2_VERSION=');
    expect(dockerfile).toContain('"pm2@${PM2_VERSION}"');
    expect(dockerfile).toContain('sudo ln -sf "$PM2_BIN" /usr/local/bin/pm2');
    expect(dockerfile).toContain('ln -sf "$PM2_BIN" "$HOME/.local/bin/pm2"');
  });

  it('does not bake the legacy Sentry binary into the worker image', () => {
    const dockerfile = fs.readFileSync(
      new URL('../../../../apps/worker/Dockerfile', import.meta.url),
      'utf8',
    );

    expect(dockerfile).not.toContain('ARG SENTRY_CLI_VERSION=');
    expect(dockerfile).not.toContain('ROOMOTE_BAKED_SENTRY_CLI_VERSION');
    expect(dockerfile).not.toContain('sentry-linux-${SENTRY_ARCH}.gz');
    expect(dockerfile).not.toContain('/usr/local/bin/sentry');
    expect(dockerfile).not.toContain('/usr/local/bin/sentry-cli');
  });

  it('expects python to be available in the worker runtime across providers', () => {
    const dockerfile = fs.readFileSync(
      new URL('../../../../apps/worker/Dockerfile', import.meta.url),
      'utf8',
    );

    expect(dockerfile).toContain('    python3 \\');
    expect(dockerfile).toContain(
      '&& ln -sf "$(command -v python3)" /usr/local/bin/python \\',
    );
  });

  it('does not install the legacy desktop runtime into the worker image', () => {
    const dockerfile = fs.readFileSync(
      new URL('../../../../apps/worker/Dockerfile', import.meta.url),
      'utf8',
    );

    expect(dockerfile).not.toContain('ARG KASMVNC_VERSION');
    expect(dockerfile).not.toContain('dbus-user-session \\');
    expect(dockerfile).not.toContain('xfce4-session \\');
    expect(dockerfile).not.toContain('thunar \\');
    expect(dockerfile).not.toContain('sudo dpkg -i "/tmp/${KASM_DEB}"');
  });

  it('bakes shared runtime tooling and the OpenCode entrypoint into the worker image', () => {
    const dockerfile = fs.readFileSync(
      new URL('../../../../apps/worker/Dockerfile', import.meta.url),
      'utf8',
    );
    const workerPackageJson = JSON.parse(
      fs.readFileSync(
        new URL('../../../../apps/worker/package.json', import.meta.url),
        'utf8',
      ),
    ) as {
      dependencies?: Record<string, string>;
    };
    const expectedNodePtyVersion = workerPackageJson.dependencies?.[
      'node-pty'
    ]?.replace(/^[^0-9]*/, '');
    const dockerfileNodePtyVersion = dockerfile.match(
      /^ARG NODE_PTY_VERSION=(.+)$/m,
    )?.[1];

    expect(dockerfile).not.toContain('ARG NODE_VERSION=');
    expect(dockerfile).not.toContain('ARG PNPM_VERSION=');
    expect(dockerfile).not.toContain('ARG RUST_VERSION=');
    expect(dockerfile).not.toContain('ARG RIPGREP_VERSION=');
    expect(dockerfile).not.toContain('ARG UV_VERSION=');
    expect(dockerfile).toContain("node = '22.17.1'");
    expect(dockerfile).toContain("pnpm = '10.29.3'");
    expect(dockerfile).toContain("rust = '1.92.0'");
    expect(dockerfile).toContain("ripgrep = '15.1.0'");
    expect(dockerfile).toContain("uv = '0.11.8'");
    expect(dockerfile).toContain('ENV RUSTUP_HOME=/home/roomote/.rustup');
    expect(dockerfile).toContain('ENV CARGO_HOME=/home/roomote/.cargo');
    expect(dockerfile).toContain('ENV RUST_MIN_STACK=16777216');
    expect(dockerfile).toContain(
      'mise install -y node@22.17.1 pnpm@10.29.3 ripgrep@15.1.0 uv@0.11.8',
    );
    expect(dockerfile).toContain('--default-toolchain 1.92.0');
    expect(dockerfile).toContain(
      'ln -sfn "$CARGO_HOME/bin" "$MISE_DATA_DIR/installs/rust/1.92.0"',
    );
    expect(dockerfile).toContain('test "$(node --version)" = "v22.17.1"');
    expect(dockerfile).toContain('test "$(pnpm --version)" = "10.29.3"');
    expect(dockerfile).toContain('test -x "$CARGO_HOME/bin/rustc"');
    expect(dockerfile).toContain(
      'test -L "$MISE_DATA_DIR/installs/rust/1.92.0"',
    );
    expect(dockerfile).toContain(
      'test "$(rg --version | awk \'NR == 1 { print $2 }\')" = "15.1.0"',
    );
    expect(dockerfile).toContain(
      'test "$(uv --version | awk \'NR == 1 { print $2 }\')" = "0.11.8"',
    );
    expect(dockerfile).toContain('    bubblewrap \\');
    expect(expectedNodePtyVersion).toBeDefined();
    expect(dockerfileNodePtyVersion).toBe(expectedNodePtyVersion);
    expect(dockerfile).toContain(
      `ARG OPENCODE_CLI_VERSION=${DEFAULT_OPENCODE_CLI_VERSION}`,
    );
    expect(dockerfile).toContain(
      `ENV ${ROOMOTE_BAKED_OPENCODE_CLI_VERSION_ENV}=\${OPENCODE_CLI_VERSION}`,
    );
    expect(dockerfile).toContain(
      'npm install --prefix /sandbox --no-save --no-package-lock \\',
    );
    expect(dockerfile).toContain('"node-pty@${NODE_PTY_VERSION}"');
    expect(dockerfile).toContain('"opencode-ai@${OPENCODE_CLI_VERSION}"');
    expect(dockerfile).toContain(
      'test "$(/sandbox/node_modules/.bin/opencode --version)" = "${OPENCODE_CLI_VERSION}"',
    );
    expect(dockerfile).toContain(
      'exec /sandbox/node_modules/.bin/opencode "$@"',
    );
  });

  it('keeps the shared install script focused on archive installation plus launcher compatibility', () => {
    const installScript = fs.readFileSync(
      new URL('../../../../.docker/sandbox/install-worker.sh', import.meta.url),
      'utf8',
    );

    expect(installScript).toContain('Installing worker from release archive');
    expect(installScript).toContain('exec node $WORKER_DIR/dist/worker.js');
    expect(installScript).toContain('install_worker');
    expect(installScript).toContain('install_worker_cli');
    expect(installScript).toContain('ensure_node_pty');
    expect(installScript).toContain(
      'npm install --prefix "$DATA_DIR" --no-save --no-package-lock "$package_spec"',
    );
    expect(installScript).toContain(
      'run_phase "node_pty_install" ensure_node_pty',
    );
    expect(installScript).not.toContain('bubblewrap');
    expect(installScript).not.toContain('copy_agents_home_dir');
    expect(installScript).not.toContain('install_python');
    expect(installScript).not.toContain('install_media_binaries');
    expect(installScript).not.toContain('removed_harness_cleanup');
    expect(installScript).not.toContain('find_real_agent_browser_cli_path');
  });

  it('records the shipped node-pty version in worker releases for bootstrap repair', () => {
    const buildScript = fs.readFileSync(
      new URL('../../../../scripts/build-worker-release.sh', import.meta.url),
      'utf8',
    );

    expect(buildScript).toContain('NODE_PTY_VERSION="$(');
    expect(buildScript).toContain(
      'echo "$NODE_PTY_VERSION" > "$TAG/NODE_PTY_VERSION"',
    );
  });
});
