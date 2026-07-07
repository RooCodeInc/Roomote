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
  it('includes the cloud job ID and environment app ports for preview auth', () => {
    const workspace = {
      type: 'environment',
      environmentConfig: {
        name: 'App',
        repositories: [{ repository: 'Roomote/example-app' }],
        auth_bypass_header: false,
      },
    };

    const cloudJob = {
      id: 123,
      taskId: 'task_123',
      authBypassValue: 'cloud-job-bypass',
    };

    const workerEnv = {
      previewAuthPublicKey: 'preview-public-key',
      previewAuthCookieName: 'preview_auth',
      openRoomoteAppUrl: 'https://app.roomote.dev',
      trpcUrl: 'https://api.roomote.dev',
    };

    expect(
      buildServiceContextForPreviewProxy(
        cloudJob as never,
        workspace as never,
        workerEnv as never,
      ),
    ).toEqual(
      expect.objectContaining({
        cloudJobId: 123,
        taskId: 'task_123',
        authBypassHeaderValue: 'cloud-job-bypass',
        appPorts: {},
      }),
    );
  });
});
