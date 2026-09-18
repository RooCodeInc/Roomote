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
    expect(instructions).not.toContain('list_repositories');
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
      'The `list_repositories` tool searches those same repositories live by name or description',
    );
    expect(instructions).toContain(
      'Available repositories (check out with `clone_repository` before use):\n- acme/api\n- acme/web',
    );
    expect(instructions).toContain(
      'target `acme/api` as the repository identifier',
    );
  });

  it('distinguishes prepared repositories from optional authorized checkouts', () => {
    const instructions = getWorkspaceInstructions(['acme/api'], undefined, {
      additionalRepositoriesOnDemand: true,
    });

    expect(instructions).toContain(
      '`REPOSITORIES.md` at the workspace root lists the active repositories authorized for this task',
    );
    expect(instructions).toContain('call the `clone_repository` tool');
    expect(instructions).toContain('The `list_repositories` tool searches');
    expect(instructions).toContain(
      "does not run another environment's setup commands or provision its services",
    );
    expect(instructions).toContain('Available repositories:\n- acme/api');
  });

  it('tells Blank slate tasks how to check out repositories when source control is connected', () => {
    const instructions = getWorkspaceInstructions([], undefined, {
      blankSlate: true,
    });

    expect(instructions).toContain(
      'This workspace starts with no repositories checked out (Blank slate)',
    );
    expect(instructions).toContain(
      'If `REPOSITORIES.md` exists at the workspace root',
    );
    expect(instructions).toContain('`clone_repository` tool');
    expect(instructions).toContain(
      'If there is no `REPOSITORIES.md`, the sandbox has no source-control credentials',
    );
    expect(instructions).not.toContain('Available repositories');
  });
});
