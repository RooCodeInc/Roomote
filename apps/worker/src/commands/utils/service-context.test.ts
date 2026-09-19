import {
  buildServiceContextForPreviewProxy,
  buildWorkspacePortMappings,
} from './service-context';

describe('buildWorkspacePortMappings', () => {
  it('does not infer callback surfaces for repository workspaces from loopback urls', () => {
    const workspace = {
      type: 'repository',
      repository: 'Roomote/example-app',
    };

    expect(
      buildWorkspacePortMappings(workspace as never).appPorts,
    ).toBeUndefined();
  });

  it('does not infer callback surfaces for environment workspaces from loopback urls', () => {
    const workspace = {
      type: 'environment',
      environmentConfig: {
        name: 'App',
        repositories: [{ repository: 'Roomote/example-app' }],
      },
    };

    expect(buildWorkspacePortMappings(workspace as never).appPorts).toEqual({});
  });

  it('maps configured environment ports for environment workspaces', () => {
    const workspace = {
      type: 'environment',
      environmentConfig: {
        name: 'App',
        repositories: [{ repository: 'Roomote/example-app' }],
        ports: [
          { name: 'web', port: 3000, primary: true },
          { name: 'api', port: 3001 },
        ],
      },
    };

    expect(buildWorkspacePortMappings(workspace as never).appPorts).toEqual({
      WEB: 3000,
      API: 3001,
    });
  });
});

describe('buildServiceContextForPreviewProxy', () => {
  it('includes the task run ID and environment app ports for preview auth', () => {
    const workspace = {
      type: 'environment',
      environmentConfig: {
        name: 'App',
        repositories: [{ repository: 'Roomote/example-app' }],
        auth_bypass_header: false,
      },
    };

    const taskRun = {
      id: 123,
      taskId: 'task_123',
      authBypassValue: 'task-run-bypass',
    };

    const workerEnv = {
      previewAuthPublicKey: 'preview-public-key',
      previewAuthCookieName: 'preview_auth',
      roomoteAppUrl: 'https://app.roomote.dev',
      trpcUrl: 'https://api.roomote.dev',
    };

    expect(
      buildServiceContextForPreviewProxy(
        taskRun as never,
        workspace as never,
        workerEnv as never,
      ),
    ).toEqual(
      expect.objectContaining({
        runId: 123,
        taskId: 'task_123',
        authBypassHeaderValue: 'task-run-bypass',
        appPorts: {},
      }),
    );
  });

  it('registers the reserved Shared Desktop port only when the run reserved it', () => {
    const workspace = {
      type: 'environment',
      environmentConfig: {
        name: 'App',
        repositories: [{ repository: 'Roomote/example-app' }],
        ports: [{ name: 'web', port: 3000, primary: true }],
      },
    };
    const workerEnv = {
      previewAuthPublicKey: 'preview-public-key',
      previewAuthCookieName: 'preview_auth',
      roomoteAppUrl: 'https://app.roomote.dev/some/path',
      trpcUrl: 'https://api.roomote.dev',
    };

    const reserved = buildServiceContextForPreviewProxy(
      {
        id: 1,
        taskId: 'task_1',
        proxyPorts: { SHARED_DESKTOP: 50001, WEB: 50001 },
      } as never,
      workspace as never,
      workerEnv as never,
    );
    expect(reserved?.appPorts).toEqual({ WEB: 3000, SHARED_DESKTOP: 6080 });
    expect(reserved?.appOrigin).toBe('https://app.roomote.dev');

    const notReserved = buildServiceContextForPreviewProxy(
      { id: 2, taskId: 'task_2', proxyPorts: { WEB: 50001 } } as never,
      workspace as never,
      workerEnv as never,
    );
    expect(notReserved?.appPorts).toEqual({ WEB: 3000 });
  });

  it.each([6080, 19222])(
    'refuses an environment that publishes reserved port %i',
    (port) => {
      expect(() =>
        buildServiceContextForPreviewProxy(
          { id: 1, taskId: 'task_1', proxyPorts: { DEBUG: 50001 } } as never,
          {
            type: 'environment',
            environmentConfig: {
              name: 'App',
              repositories: [{ repository: 'Roomote/example-app' }],
              ports: [{ name: 'debug', port }],
            },
          } as never,
          {
            previewAuthPublicKey: 'preview-public-key',
            previewAuthCookieName: 'preview_auth',
            roomoteAppUrl: 'https://app.roomote.dev',
            trpcUrl: 'https://api.roomote.dev',
          } as never,
        ),
      ).toThrow(`Port number '${port}' is reserved`);
    },
  );
});
