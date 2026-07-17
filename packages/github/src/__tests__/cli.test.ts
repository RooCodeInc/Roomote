const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
}));

vi.mock('execa', () => ({
  execa: execaMock,
}));

import { fetchFileContent, fetchRepositoryTree } from '../cli';

describe('github cli repository content helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null without logging when file content returns 404', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    execaMock.mockRejectedValueOnce({
      stderr: 'gh: Not Found (HTTP 404)',
      message: 'Command failed with exit code 1',
    });

    await expect(
      fetchFileContent({
        gitHubToken: 'ghp_test',
        repo: 'owner/repo',
        path: 'agents.md',
        ref: 'main',
      }),
    ).resolves.toBeNull();

    expect(execaMock).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/owner/repo/contents/agents.md?ref=main'],
      expect.objectContaining({
        env: { GH_TOKEN: 'ghp_test' },
      }),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('logs unexpected file content failures', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    execaMock.mockRejectedValueOnce({
      stderr: 'gh: Internal Server Error (HTTP 500)',
      message: 'Command failed with exit code 1',
    });

    await expect(
      fetchFileContent({
        gitHubToken: 'ghp_test',
        repo: 'owner/repo',
        path: 'agents.md',
        ref: 'main',
      }),
    ).resolves.toBeNull();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[fetchFileContent] failed to fetch agents.md: gh: Internal Server Error (HTTP 500)',
      ),
    );
  });

  it('falls back to recursively listing .roomote/rules when the root tree is truncated', async () => {
    execaMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          truncated: true,
          tree: [
            { path: 'src/app.ts', type: 'blob' },
            { path: '.roomote/rules', type: 'tree' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { path: '.roomote/rules/rules.md', type: 'file' },
          { path: '.roomote/rules/nested', type: 'dir' },
        ]),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { path: '.roomote/rules/nested/extra.md', type: 'file' },
        ]),
      });

    await expect(
      fetchRepositoryTree({
        gitHubToken: 'ghp_test',
        repo: 'owner/repo',
        ref: 'main',
      }),
    ).resolves.toEqual([
      'src/app.ts',
      '.roomote/rules/rules.md',
      '.roomote/rules/nested/extra.md',
    ]);

    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['api', 'repos/owner/repo/git/trees/main?recursive=1'],
      expect.objectContaining({
        env: { GH_TOKEN: 'ghp_test' },
      }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['api', 'repos/owner/repo/contents/.roomote/rules?ref=main'],
      expect.objectContaining({
        env: { GH_TOKEN: 'ghp_test' },
      }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      3,
      'gh',
      ['api', 'repos/owner/repo/contents/.roomote/rules/nested?ref=main'],
      expect.objectContaining({
        env: { GH_TOKEN: 'ghp_test' },
      }),
    );
  });

  it('keeps the existing tree paths when truncated fallback directory is missing', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    execaMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          truncated: true,
          tree: [{ path: 'src/app.ts', type: 'blob' }],
        }),
      })
      .mockRejectedValueOnce({
        stderr: 'gh: Not Found (HTTP 404)',
        message: 'Command failed with exit code 1',
      });

    await expect(
      fetchRepositoryTree({
        gitHubToken: 'ghp_test',
        repo: 'owner/repo',
        ref: 'main',
      }),
    ).resolves.toEqual(['src/app.ts']);

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('keeps the existing tree paths when truncated fallback directory returns a non-404 error', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    execaMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          truncated: true,
          tree: [{ path: 'src/app.ts', type: 'blob' }],
        }),
      })
      .mockRejectedValueOnce({
        stderr: 'gh: Internal Server Error (HTTP 500)',
        message: 'Command failed with exit code 1',
      });

    await expect(
      fetchRepositoryTree({
        gitHubToken: 'ghp_test',
        repo: 'owner/repo',
        ref: 'main',
      }),
    ).resolves.toEqual(['src/app.ts']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[fetchRepositoryTree] failed to fetch tree for owner/repo@main: gh: Internal Server Error (HTTP 500)',
      ),
    );
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});
