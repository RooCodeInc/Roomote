import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  discoverRepoLocalSkills,
  getRepoLocalSkillInvocations,
  getRepoLocalSkillRootPaths,
} from '../repo-local-skills';

function writeSkill(options: {
  repoPath: string;
  skillName: string;
  skillRoot?: '.agents' | '.claude';
  body?: string;
}) {
  const skillDir = path.join(
    options.repoPath,
    options.skillRoot ?? '.agents',
    'skills',
    options.skillName,
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    options.body ?? '# Skill guidance\n',
    'utf8',
  );
}

describe('discoverRepoLocalSkills', () => {
  let testRootDir: string;

  beforeEach(() => {
    testRootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-repo-local-skills-test-'),
    );
  });

  afterEach(() => {
    fs.rmSync(testRootDir, { recursive: true, force: true });
  });

  it('discovers repo-local skills from supported checked-in skill roots', async () => {
    const repoPath = path.join(testRootDir, 'Roomote');
    fs.mkdirSync(repoPath, { recursive: true });
    writeSkill({
      repoPath,
      skillName: 'api-patterns',
    });
    writeSkill({
      repoPath,
      skillRoot: '.claude',
      skillName: 'docs-maintenance',
    });

    const skills = await discoverRepoLocalSkills({
      repoPaths: { 'Roomote/example-app': repoPath },
      repoFullNamesByDir: {
        'Roomote/example-app': 'Roomote/example-app',
      },
    });

    expect(skills).toEqual([
      {
        repoName: 'Roomote/example-app',
        repoFullName: 'Roomote/example-app',
        skillName: 'api-patterns',
        skillPath: path.join(
          repoPath,
          '.agents',
          'skills',
          'api-patterns',
          'SKILL.md',
        ),
        skillDirPath: path.join(repoPath, '.agents', 'skills', 'api-patterns'),
        skillRootPath: path.join(repoPath, '.agents', 'skills'),
      },
      {
        repoName: 'Roomote/example-app',
        repoFullName: 'Roomote/example-app',
        skillName: 'docs-maintenance',
        skillPath: path.join(
          repoPath,
          '.claude',
          'skills',
          'docs-maintenance',
          'SKILL.md',
        ),
        skillDirPath: path.join(
          repoPath,
          '.claude',
          'skills',
          'docs-maintenance',
        ),
        skillRootPath: path.join(repoPath, '.claude', 'skills'),
      },
    ]);
  });

  it('returns unique repo-local skill roots in sorted order', async () => {
    const repoPath = path.join(testRootDir, 'Roomote');
    fs.mkdirSync(repoPath, { recursive: true });
    writeSkill({ repoPath, skillName: 'alpha' });
    writeSkill({ repoPath, skillName: 'beta' });
    writeSkill({
      repoPath,
      skillRoot: '.claude',
      skillName: 'docs-maintenance',
    });

    const skills = await discoverRepoLocalSkills({
      repoPaths: { 'Roomote/example-app': repoPath },
    });

    expect(getRepoLocalSkillRootPaths(skills)).toEqual([
      path.join(repoPath, '.agents', 'skills'),
      path.join(repoPath, '.claude', 'skills'),
    ]);
  });

  it('keeps unique bare invocation names and repo-qualifies duplicate names', async () => {
    const roomoteRepoPath = path.join(testRootDir, 'Roomote');
    const docsRepoPath = path.join(testRootDir, 'Docs');
    fs.mkdirSync(roomoteRepoPath, { recursive: true });
    fs.mkdirSync(docsRepoPath, { recursive: true });

    writeSkill({
      repoPath: roomoteRepoPath,
      skillName: 'prepare-release-candidate',
    });
    writeSkill({
      repoPath: docsRepoPath,
      skillName: 'prepare-release-candidate',
    });
    writeSkill({
      repoPath: roomoteRepoPath,
      skillName: 'docs-maintenance',
    });

    const skills = await discoverRepoLocalSkills({
      repoPaths: {
        'Roomote/docs': docsRepoPath,
        'Roomote/example-app': roomoteRepoPath,
      },
    });

    expect(getRepoLocalSkillInvocations(skills)).toEqual([
      {
        invocationName: 'Roomote-docs.prepare-release-candidate',
        repoLocalSkill: {
          repoName: 'Roomote/docs',
          repoFullName: undefined,
          skillName: 'prepare-release-candidate',
          skillPath: path.join(
            docsRepoPath,
            '.agents',
            'skills',
            'prepare-release-candidate',
            'SKILL.md',
          ),
          skillDirPath: path.join(
            docsRepoPath,
            '.agents',
            'skills',
            'prepare-release-candidate',
          ),
          skillRootPath: path.join(docsRepoPath, '.agents', 'skills'),
        },
      },
      {
        invocationName: 'docs-maintenance',
        repoLocalSkill: {
          repoName: 'Roomote/example-app',
          repoFullName: undefined,
          skillName: 'docs-maintenance',
          skillPath: path.join(
            roomoteRepoPath,
            '.agents',
            'skills',
            'docs-maintenance',
            'SKILL.md',
          ),
          skillDirPath: path.join(
            roomoteRepoPath,
            '.agents',
            'skills',
            'docs-maintenance',
          ),
          skillRootPath: path.join(roomoteRepoPath, '.agents', 'skills'),
        },
      },
      {
        invocationName: 'Roomote-example-app.prepare-release-candidate',
        repoLocalSkill: {
          repoName: 'Roomote/example-app',
          repoFullName: undefined,
          skillName: 'prepare-release-candidate',
          skillPath: path.join(
            roomoteRepoPath,
            '.agents',
            'skills',
            'prepare-release-candidate',
            'SKILL.md',
          ),
          skillDirPath: path.join(
            roomoteRepoPath,
            '.agents',
            'skills',
            'prepare-release-candidate',
          ),
          skillRootPath: path.join(roomoteRepoPath, '.agents', 'skills'),
        },
      },
    ]);
  });

  it('keeps bare invocation names when mirrored roots exist only inside one repo', async () => {
    const roomoteRepoPath = path.join(testRootDir, 'Roomote');
    fs.mkdirSync(roomoteRepoPath, { recursive: true });

    writeSkill({
      repoPath: roomoteRepoPath,
      skillName: 'prepare-release-candidate',
      skillRoot: '.agents',
    });
    writeSkill({
      repoPath: roomoteRepoPath,
      skillName: 'prepare-release-candidate',
      skillRoot: '.claude',
      body: '# Mirrored claude copy\n',
    });

    const skills = await discoverRepoLocalSkills({
      repoPaths: {
        'Roomote/example-app': roomoteRepoPath,
      },
      repoFullNamesByDir: {
        'Roomote/example-app': 'Roomote/example-app',
      },
    });

    expect(getRepoLocalSkillInvocations(skills)).toEqual([
      {
        invocationName: 'prepare-release-candidate',
        repoLocalSkill: {
          repoName: 'Roomote/example-app',
          repoFullName: 'Roomote/example-app',
          skillName: 'prepare-release-candidate',
          skillPath: path.join(
            roomoteRepoPath,
            '.agents',
            'skills',
            'prepare-release-candidate',
            'SKILL.md',
          ),
          skillDirPath: path.join(
            roomoteRepoPath,
            '.agents',
            'skills',
            'prepare-release-candidate',
          ),
          skillRootPath: path.join(roomoteRepoPath, '.agents', 'skills'),
        },
      },
    ]);
  });
});
