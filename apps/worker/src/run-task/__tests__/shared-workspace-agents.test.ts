import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildSharedWorkspaceAgentsContent,
  writeSharedWorkspaceAgentsFile,
} from '../shared-workspace-agents';

describe('buildSharedWorkspaceAgentsContent', () => {
  it('covers shared-root guidance for investigation, planning, review, and edits', () => {
    const content = buildSharedWorkspaceAgentsContent({
      repoPaths: {
        'Roomote/example-app': '/repos/Roomote/example-app',
      },
    });

    expect(content).toContain(
      'Child repo `AGENTS.md` files may not have been auto-loaded.',
    );
    expect(content).toContain(
      "git -C <repo-dir> ls-files -- AGENTS.md '**/AGENTS.md'",
    );
    expect(content).toContain(
      'Before investigation, planning, review, or edits in a repo path:',
    );
    expect(content).toContain(
      'Read the applicable files from the repo root `AGENTS.md` down to the nearest ancestor of the path you are working in.',
    );
    expect(content).toContain(
      'Re-check when switching repos or moving into a different subtree.',
    );
  });
});

describe('writeSharedWorkspaceAgentsFile', () => {
  it('writes /repos/AGENTS.md for a single-repo shared-root workspace without touching the child repo copy', () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'shared-workspace-agents-single-'),
    );
    const repoPath = path.join(workspaceRoot, 'Roomote', 'Roomote');
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, 'AGENTS.md'),
      '# Roomote repo\n',
      'utf8',
    );

    const wroteFile = writeSharedWorkspaceAgentsFile({
      workspacePath: workspaceRoot,
      usesSharedWorkspaceRoot: true,
      repoPaths: {
        'Roomote/example-app': repoPath,
      },
    });

    expect(wroteFile).toBe(true);
    expect(
      fs.readFileSync(path.join(workspaceRoot, 'AGENTS.md'), 'utf8'),
    ).toContain('- `Roomote/example-app` ->');
    expect(fs.readFileSync(path.join(repoPath, 'AGENTS.md'), 'utf8')).toBe(
      '# Roomote repo\n',
    );
  });

  it('writes /repos/AGENTS.md for a multi-repo shared-root workspace and does not create child repo files', () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'shared-workspace-agents-multi-'),
    );
    const docsRepoPath = path.join(workspaceRoot, 'Roomote', 'Docs');
    const roomoteRepoPath = path.join(workspaceRoot, 'Roomote', 'Roomote');
    fs.mkdirSync(docsRepoPath, { recursive: true });
    fs.mkdirSync(roomoteRepoPath, { recursive: true });

    const wroteFile = writeSharedWorkspaceAgentsFile({
      workspacePath: workspaceRoot,
      usesSharedWorkspaceRoot: true,
      repoPaths: {
        'Roomote/example-app': roomoteRepoPath,
        'Roomote/docs': docsRepoPath,
      },
    });

    expect(wroteFile).toBe(true);
    const content = fs.readFileSync(
      path.join(workspaceRoot, 'AGENTS.md'),
      'utf8',
    );
    expect(content).toContain('- `Roomote/docs` ->');
    expect(content).toContain('- `Roomote/example-app` ->');
    expect(fs.existsSync(path.join(docsRepoPath, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(roomoteRepoPath, 'AGENTS.md'))).toBe(false);
  });
});
