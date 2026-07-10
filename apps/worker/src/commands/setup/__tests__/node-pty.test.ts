import {
  DEFAULT_OPENCODE_CLI_VERSION,
  DEFAULT_ZERO_CLI_VERSION,
} from '../agent-clis';
import {
  getNodePtyInstallPackageSpecs,
  resolveNodePtyInstallRoot,
} from '../node-pty';

describe('resolveNodePtyInstallRoot', () => {
  it('uses the sandbox root outside local runtime', () => {
    expect(
      resolveNodePtyInstallRoot({
        moduleUrl: 'file:///repo/apps/worker/src/commands/setup/node-pty.ts',
        runtimePaths: {
          runtime: 'modal',
          sandboxRootDir: '/sandbox',
          workspaceReposDir: '/sandbox/repos',
          vscodeUserDataDir: '/sandbox/.vscode',
        },
      }),
    ).toBe('/sandbox');
  });

  it('uses the worker package root in local runtime', () => {
    expect(
      resolveNodePtyInstallRoot({
        moduleUrl: 'file:///repo/apps/worker/src/commands/setup/node-pty.ts',
        runtimePaths: {
          runtime: 'local',
          sandboxRootDir: '/tmp/roomote-worker',
          workspaceReposDir: '/tmp/roomote-worker/repos',
          vscodeUserDataDir: '/tmp/roomote-worker/.vscode',
        },
      }),
    ).toBe('/repo/apps/worker');
  });

  it('installs the shared sandbox runtime package set outside local runtime', () => {
    expect(
      getNodePtyInstallPackageSpecs({
        runtime: 'modal',
        sandboxRootDir: '/sandbox',
        workspaceReposDir: '/sandbox/repos',
        vscodeUserDataDir: '/sandbox/.vscode',
      }),
    ).toEqual([
      `opencode-ai@${DEFAULT_OPENCODE_CLI_VERSION}`,
      'node-pty',
      `@zeroxyz/cli@${DEFAULT_ZERO_CLI_VERSION}`,
    ]);
  });

  it('installs only node-pty in local runtime', () => {
    expect(
      getNodePtyInstallPackageSpecs({
        runtime: 'local',
        sandboxRootDir: '/tmp/roomote-worker',
        workspaceReposDir: '/tmp/roomote-worker/repos',
        vscodeUserDataDir: '/tmp/roomote-worker/.vscode',
      }),
    ).toEqual(['node-pty']);
  });
});
