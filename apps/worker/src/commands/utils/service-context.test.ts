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
});
