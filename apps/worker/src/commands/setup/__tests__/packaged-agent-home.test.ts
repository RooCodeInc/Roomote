import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { syncPackagedAgentHome } from '../system';

function writeSkill(
  homeDir: string,
  skillFolder: string,
  skillName: string,
): void {
  const skillDir = path.join(
    homeDir,
    '.packaged-skills',
    skillFolder,
    skillName,
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${skillName}\n`);
}

function writeInstalledSkill(
  homeDir: string,
  skillName: string,
  skillContent = `# ${skillName}\n`,
): void {
  const skillDir = path.join(homeDir, '.agents', 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);
  fs.writeFileSync(
    path.join(skillDir, 'metadata.json'),
    JSON.stringify({ name: skillName }),
  );
}

describe('syncPackagedAgentHome', () => {
  let testRootDir: string;
  let homeDir: string;
  let workerDir: string;

  beforeEach(() => {
    testRootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-agent-home-sync-test-'),
    );
    homeDir = path.join(testRootDir, 'home');
    workerDir = path.join(testRootDir, 'worker');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(workerDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testRootDir, { recursive: true, force: true });
  });

  it('copies packaged home files into HOME and replaces stale directories', () => {
    fs.mkdirSync(path.join(workerDir, '.agents', 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, '.agents', 'mcp', 'settings.json'),
      '{"ok":true}\n',
    );
    writeSkill(workerDir, 'standard', 'bar');

    fs.mkdirSync(path.join(homeDir, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.agents', 'stale.txt'), 'stale\n');
    fs.mkdirSync(path.join(homeDir, '.packaged-skills', 'old'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(testRootDir, 'claude-target'), { recursive: true });
    fs.symlinkSync(
      path.join(testRootDir, 'claude-target'),
      path.join(homeDir, '.claude'),
    );

    syncPackagedAgentHome({ homeDir, workerDir });

    expect(
      fs.existsSync(path.join(homeDir, '.agents', 'mcp', 'settings.json')),
    ).toBe(true);
    expect(fs.existsSync(path.join(homeDir, '.agents', 'stale.txt'))).toBe(
      false,
    );
    expect(
      fs.existsSync(
        path.join(homeDir, '.packaged-skills', 'standard', 'bar', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(fs.lstatSync(path.join(homeDir, '.claude')).isDirectory()).toBe(
      true,
    );
  });

  it('preserves installed .agents/skills while refreshing the rest of .agents', () => {
    fs.mkdirSync(path.join(workerDir, '.agents', 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, '.agents', 'mcp', 'settings.json'),
      '{"ok":true}\n',
    );

    writeInstalledSkill(homeDir, 'custom-skill');
    fs.writeFileSync(path.join(homeDir, '.agents', 'stale.txt'), 'stale\n');

    syncPackagedAgentHome({ homeDir, workerDir });

    expect(
      fs.existsSync(path.join(homeDir, '.agents', 'mcp', 'settings.json')),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(homeDir, '.agents', 'skills', 'custom-skill', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          homeDir,
          '.agents',
          'skills',
          'custom-skill',
          'metadata.json',
        ),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(homeDir, '.agents', 'stale.txt'))).toBe(
      false,
    );
  });

  it('creates a real .claude directory even when the worker archive has no home assets', () => {
    syncPackagedAgentHome({ homeDir, workerDir });

    expect(fs.existsSync(path.join(homeDir, '.claude'))).toBe(true);
    expect(fs.lstatSync(path.join(homeDir, '.claude')).isDirectory()).toBe(
      true,
    );
  });
});
