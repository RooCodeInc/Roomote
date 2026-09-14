import { getWorkspaceInstructions } from '../utils';

describe('getWorkspaceInstructions', () => {
  it('describes prepared repositories for scoped shared-root workspaces', () => {
    const instructions = getWorkspaceInstructions(['acme/api', 'acme/web']);

    expect(instructions).toContain(
      'You have access to every repository prepared in the workspace',
    );
    expect(instructions).toContain(
      'Available repositories:\n- acme/api\n- acme/web',
    );
    expect(instructions).not.toContain('clone_repository');
  });

  it('routes all-repositories workspaces through the manifest and clone_repository tool', () => {
    const instructions = getWorkspaceInstructions(
      ['acme/api', 'acme/web'],
      undefined,
      { repositoriesOnDemand: true },
    );

    expect(instructions).toContain('Repositories are NOT cloned up front');
    expect(instructions).toContain('`REPOSITORIES.md` at the workspace root');
    expect(instructions).toContain(
      'call the `clone_repository` tool with its full name (owner/repo)',
    );
    expect(instructions).toContain(
      'Available repositories (check out with `clone_repository` before use):\n- acme/api\n- acme/web',
    );
    expect(instructions).toContain(
      'target `acme/api` as the repository identifier',
    );
  });
});
