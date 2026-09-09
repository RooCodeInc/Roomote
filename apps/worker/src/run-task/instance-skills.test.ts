import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  renderManualSkillMarkdown,
  type EnvironmentManualSkill,
} from '@roomote/types';

import type { RepoLocalSkill } from '../workspace/repo-local-skills';
import { activateSkillsFolder } from './agent-home';

describe('activateSkillsFolder instance skills', () => {
  let root: string;
  let homeDir: string;
  let sourceHomeDir: string;
  let skillsDir: string;
  let claudeSkillsDir: string;
  let packagedDir: string;
  let manifestPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roomote-instance-skills-'));
    homeDir = join(root, 'home');
    sourceHomeDir = join(root, 'worker-home');
    skillsDir = join(homeDir, '.agents', 'skills');
    claudeSkillsDir = join(homeDir, '.claude', 'skills');
    packagedDir = join(sourceHomeDir, '.packaged-skills', 'standard');
    manifestPath = join(homeDir, '.agents', '.instance-skills.json');
    mkdirSync(homeDir);
    mkdirSync(packagedDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function skill(
    name: string,
    content = 'Instance instructions',
  ): EnvironmentManualSkill {
    return { name, description: 'When this skill applies', content };
  }

  function writeDocument(directory: string, content: string): string {
    mkdirSync(directory, { recursive: true });
    const documentPath = join(directory, 'SKILL.md');
    writeFileSync(documentPath, content, 'utf8');
    return documentPath;
  }

  function activate(
    options: Partial<Parameters<typeof activateSkillsFolder>[0]> = {},
  ): boolean {
    return activateSkillsFolder({
      homeDir,
      sourceHomeDir,
      skillsFolderName: 'standard',
      ...options,
    });
  }

  function ownership(name: string, document: string) {
    return {
      name,
      sha256: createHash('sha256').update(document).digest('hex'),
    };
  }

  function writeManifest(entries: ReturnType<typeof ownership>[]): void {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(entries));
  }

  function expectMirrored(name: string, document: string): void {
    expect(readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8')).toBe(
      document,
    );
    expect(readFileSync(join(claudeSkillsDir, name, 'SKILL.md'), 'utf8')).toBe(
      document,
    );
    expect(readlinkSync(join(claudeSkillsDir, name))).toBe(
      join(skillsDir, name),
    );
  }

  it('materializes packaged > instance > legacy > repository precedence in both homes', () => {
    writeDocument(join(packagedDir, 'packaged'), 'Packaged instructions');
    const names = ['packaged', 'instance', 'legacy', 'repository'];
    const skillRootPath = join(root, 'repo', '.agents', 'skills');
    const repoLocalSkills: RepoLocalSkill[] = names.map((skillName) => {
      const skillDirPath = join(skillRootPath, skillName);
      return {
        repoName: 'repo',
        repoFullName: 'example/repo',
        skillName,
        skillRootPath,
        skillDirPath,
        skillPath: writeDocument(skillDirPath, `Repository ${skillName}`),
      };
    });
    const instanceSkills = ['packaged', 'instance'].map((name) => skill(name));
    const manualSkills = ['packaged', 'instance', 'legacy'].map((name) =>
      skill(name, 'Legacy instructions'),
    );

    expect(activate({ instanceSkills, manualSkills, repoLocalSkills })).toBe(
      true,
    );

    expectMirrored('packaged', 'Packaged instructions');
    expectMirrored('instance', renderManualSkillMarkdown(skill('instance')));
    expectMirrored(
      'legacy',
      renderManualSkillMarkdown(skill('legacy', 'Legacy instructions')),
    );
    expectMirrored('repository', 'Repository repository');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual([
      ownership('instance', renderManualSkillMarkdown(skill('instance'))),
    ]);
    expect(
      readFileSync(join(skillRootPath, 'instance', 'SKILL.md'), 'utf8'),
    ).toBe('Repository instance');
  });

  it('refreshes edits, renames, and deletions on resume, including the Claude mirror', () => {
    activate({
      instanceSkills: [skill('old-name'), skill('edited'), skill('deleted')],
    });
    expectMirrored('old-name', renderManualSkillMarkdown(skill('old-name')));
    const edited = skill('edited', 'Updated instructions');
    const renamed = skill('new-name');

    activate({ instanceSkills: [renamed, edited] });

    expectMirrored('new-name', renderManualSkillMarkdown(renamed));
    expectMirrored('edited', renderManualSkillMarkdown(edited));
    for (const directory of [skillsDir, claudeSkillsDir]) {
      expect(readdirSync(directory).sort()).toEqual(['edited', 'new-name']);
    }
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual([
      ownership(renamed.name, renderManualSkillMarkdown(renamed)),
      ownership(edited.name, renderManualSkillMarkdown(edited)),
    ]);

    activate();
    expect(readdirSync(skillsDir)).toEqual([]);
    expect(readdirSync(claudeSkillsDir)).toEqual([]);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual([]);
  });

  it('materializes marketplace supporting files and executable modes in both homes', () => {
    const definition = {
      ...skill('marketplace-skill'),
      document:
        '---\nname: marketplace-skill\ndescription: Exact marketplace document\nallowed-tools: Read\n---\n\n# Exact body',
      resources: [
        {
          path: 'guides/setup.md',
          contentBase64: Buffer.from('# Setup').toString('base64'),
          executable: false,
        },
        {
          path: 'scripts/check.sh',
          contentBase64: Buffer.from('#!/bin/sh\necho ok\n').toString('base64'),
          executable: true,
        },
      ],
    };

    expect(activate({ instanceSkills: [definition] })).toBe(true);
    expectMirrored(definition.name, definition.document);

    for (const root of [skillsDir, claudeSkillsDir]) {
      expect(
        readFileSync(join(root, definition.name, 'guides', 'setup.md'), 'utf8'),
      ).toBe('# Setup');
      expect(
        readFileSync(
          join(root, definition.name, 'scripts', 'check.sh'),
          'utf8',
        ),
      ).toBe('#!/bin/sh\necho ok\n');
    }
    expect(
      lstatSync(join(skillsDir, definition.name, 'scripts', 'check.sh')).mode &
        0o111,
    ).not.toBe(0);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual([
      expect.objectContaining({ name: definition.name, version: 2 }),
    ]);
  });

  it('keeps packaged skills authoritative despite forged manifest ownership', () => {
    writeDocument(join(packagedDir, 'protected'), 'Packaged instructions');
    writeDocument(join(skillsDir, 'protected'), 'Forged instance instructions');
    writeManifest([ownership('protected', 'Forged instance instructions')]);

    activate({ instanceSkills: [skill('protected')] });
    expectMirrored('protected', 'Packaged instructions');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual([]);
    activate();
    expectMirrored('protected', 'Packaged instructions');
    expect(
      readFileSync(join(packagedDir, 'protected', 'SKILL.md'), 'utf8'),
    ).toBe('Packaged instructions');
  });

  it('preserves unrelated, locally replaced, and locally extended entries during cleanup', () => {
    activate({
      instanceSkills: [skill('replaced'), skill('extended'), skill('removed')],
    });
    writeDocument(join(skillsDir, 'unrelated'), 'Unrelated instructions');
    writeDocument(join(skillsDir, 'replaced'), 'Local replacement');
    writeFileSync(join(skillsDir, 'extended', 'notes.txt'), 'Local notes');

    activate({ instanceSkills: [] });

    expectMirrored('unrelated', 'Unrelated instructions');
    expectMirrored('replaced', 'Local replacement');
    expectMirrored('extended', renderManualSkillMarkdown(skill('extended')));
    expect(readFileSync(join(skillsDir, 'extended', 'notes.txt'), 'utf8')).toBe(
      'Local notes',
    );
    expect(readdirSync(skillsDir).sort()).toEqual([
      'extended',
      'replaced',
      'unrelated',
    ]);
  });

  const unsafeNames = [
    '.',
    '..',
    '../escape',
    'nested/skill',
    '/absolute',
    'nested\\skill',
    '..\\escape',
  ];

  it.each(unsafeNames)(
    'rejects instance name %j before changing HOME',
    (name) => {
      activate({ instanceSkills: [skill('existing')] });
      const manifest = readFileSync(manifestPath, 'utf8');

      expect(() =>
        activate({ instanceSkills: [skill('valid'), skill(name)] }),
      ).toThrow();

      expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
      expect(readdirSync(skillsDir)).toEqual(['existing']);
      expectMirrored('existing', renderManualSkillMarkdown(skill('existing')));
    },
  );

  it.each(unsafeNames)(
    'skips unsafe legacy name %j without affecting outside files',
    (name) => {
      const sentinel = writeDocument(
        join(root, 'outside'),
        'Outside instructions',
      );
      expect(
        activate({ manualSkills: [skill(name), skill('safe-legacy')] }),
      ).toBe(true);
      expect(readdirSync(skillsDir)).toEqual(['safe-legacy']);
      expectMirrored(
        'safe-legacy',
        renderManualSkillMarkdown(skill('safe-legacy')),
      );
      expect(readFileSync(sentinel, 'utf8')).toBe('Outside instructions');
      expect(existsSync(join(homeDir, '.agents', 'SKILL.md'))).toBe(false);
      expect(existsSync(join(homeDir, 'SKILL.md'))).toBe(false);
    },
  );

  it('accepts exactly 64 KiB of rendered UTF-8 and rejects one byte more before cleanup', () => {
    const definition = skill('bounded', 'x');
    const overhead =
      Buffer.byteLength(renderManualSkillMarkdown(definition), 'utf8') - 1;
    const bodyBytes = 64 * 1024 - overhead;
    definition.content =
      '\u00e9'.repeat(Math.floor(bodyBytes / 2)) + 'x'.repeat(bodyBytes % 2);
    const document = renderManualSkillMarkdown(definition);
    expect(Buffer.byteLength(document, 'utf8')).toBe(64 * 1024);
    expect(activate({ instanceSkills: [definition] })).toBe(true);
    expectMirrored('bounded', document);
    const manifest = readFileSync(manifestPath, 'utf8');
    const oversized = { ...definition, content: `${definition.content}x` };
    expect(Buffer.byteLength(oversized.content, 'utf8')).toBeLessThan(
      64 * 1024,
    );

    expect(() => activate({ instanceSkills: [oversized] })).toThrow(
      'document size limit',
    );
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
    expectMirrored('bounded', document);
  });

  it('accepts 128 instance skills and rejects 129 without changing the previous catalog', () => {
    const instanceSkills = Array.from({ length: 128 }, (_, index) =>
      skill(`skill-${index}`),
    );
    expect(activate({ instanceSkills })).toBe(true);
    expect(readdirSync(skillsDir)).toHaveLength(128);
    expect(readdirSync(claudeSkillsDir)).toHaveLength(128);
    const manifest = readFileSync(manifestPath, 'utf8');
    expect(JSON.parse(manifest)).toHaveLength(128);

    expect(() =>
      activate({ instanceSkills: [...instanceSkills, skill('overflow')] }),
    ).toThrow('Too many instance skills');
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
    expect(readdirSync(skillsDir)).toHaveLength(128);
    expectMirrored('skill-127', renderManualSkillMarkdown(skill('skill-127')));
    expect(existsSync(join(skillsDir, 'overflow'))).toBe(false);
  });

  it('rejects a symlink manifest without reading or truncating its target', () => {
    const outside = join(root, 'outside-manifest.json');
    writeFileSync(outside, 'not JSON: must not be read');
    mkdirSync(dirname(manifestPath), { recursive: true });
    symlinkSync(outside, manifestPath);

    expect(() => activate({ instanceSkills: [skill('new-skill')] })).toThrow(
      'Unsafe instance skills manifest',
    );
    expect(readFileSync(outside, 'utf8')).toBe('not JSON: must not be read');
    expect(readlinkSync(manifestPath)).toBe(outside);
    expect(existsSync(join(skillsDir, 'new-skill'))).toBe(false);
  });

  it.each(['{', 'null', '{}', 'x'.repeat(64 * 1024 + 1)])(
    'recovers a damaged manifest conservatively (case %#)',
    (contents) => {
      activate({ instanceSkills: [skill('previous')] });
      writeFileSync(manifestPath, contents);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(activate({ instanceSkills: [skill('current')] })).toBe(true);
        expect(warn).toHaveBeenCalledOnce();
        expectMirrored(
          'previous',
          renderManualSkillMarkdown(skill('previous')),
        );
        expectMirrored('current', renderManualSkillMarkdown(skill('current')));
        expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual([
          ownership('current', renderManualSkillMarkdown(skill('current'))),
        ]);
        expect(
          readdirSync(dirname(manifestPath)).filter((entry) =>
            entry.endsWith('.tmp'),
          ),
        ).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('keeps safe pre-existing legacy names outside the new instance slug format', () => {
    const names = ['_legacy', '-legacy', 'Legacy_Name', 'legacy.name'];
    expect(activate({ manualSkills: names.map((name) => skill(name)) })).toBe(
      true,
    );
    for (const name of names)
      expectMirrored(name, renderManualSkillMarkdown(skill(name)));
  });

  it.each(['.agents', '.agents/skills', '.claude'])(
    'rejects redirected %s containers without touching their targets',
    (relativePath) => {
      const outside = join(root, 'outside');
      const sentinel = writeDocument(outside, 'Outside instructions');
      const redirected = join(homeDir, relativePath);
      mkdirSync(dirname(redirected), { recursive: true });
      symlinkSync(outside, redirected);

      expect(() => activate({ instanceSkills: [skill('new-skill')] })).toThrow(
        'Unsafe runtime skills directory',
      );
      expect(readlinkSync(redirected)).toBe(outside);
      expect(readdirSync(outside)).toEqual(['SKILL.md']);
      expect(readFileSync(sentinel, 'utf8')).toBe('Outside instructions');
      expect(existsSync(manifestPath)).toBe(false);
    },
  );

  it('replaces a symlink Claude skills root without following or deleting its target', () => {
    const outside = join(root, 'outside');
    const sentinel = writeDocument(outside, 'Outside instructions');
    mkdirSync(dirname(claudeSkillsDir), { recursive: true });
    symlinkSync(outside, claudeSkillsDir);

    activate({ instanceSkills: [skill('current')] });

    expect(lstatSync(claudeSkillsDir).isSymbolicLink()).toBe(false);
    expectMirrored('current', renderManualSkillMarkdown(skill('current')));
    expect(readdirSync(outside)).toEqual(['SKILL.md']);
    expect(readFileSync(sentinel, 'utf8')).toBe('Outside instructions');
  });

  it('skips manifest entries whose skill directory is a symlink even with a matching digest', () => {
    const outside = join(root, 'outside');
    const sentinel = writeDocument(outside, 'Outside instructions');
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(outside, join(skillsDir, 'redirected'));
    writeManifest([ownership('redirected', 'Outside instructions')]);

    activate();

    expect(readlinkSync(join(skillsDir, 'redirected'))).toBe(outside);
    expect(readFileSync(sentinel, 'utf8')).toBe('Outside instructions');
    expect(readdirSync(outside)).toEqual(['SKILL.md']);
  });

  it.each(unsafeNames)(
    'ignores unsafe manifest path %j during ownership cleanup',
    (name) => {
      const sentinel = writeDocument(
        join(homeDir, '.agents'),
        'Parent instructions',
      );
      const outside = writeDocument(
        join(root, 'outside'),
        'Outside instructions',
      );
      writeManifest([ownership(name, 'Parent instructions')]);

      expect(activate()).toBe(true);

      expect(readFileSync(sentinel, 'utf8')).toBe('Parent instructions');
      expect(readFileSync(outside, 'utf8')).toBe('Outside instructions');
      expect(readdirSync(skillsDir)).toEqual([]);
    },
  );

  it.each([false, true])(
    'does not follow an owned document symlink on resume (replacement: %s)',
    (replace) => {
      const definition = skill('owned');
      const document = renderManualSkillMarkdown(definition);
      activate({ instanceSkills: [definition] });
      const outside = join(root, 'outside.md');
      writeFileSync(outside, document);
      const ownedPath = join(skillsDir, 'owned', 'SKILL.md');
      rmSync(ownedPath);
      symlinkSync(outside, ownedPath);
      const updated = skill('owned', 'Updated instructions');

      activate({ instanceSkills: replace ? [updated] : [] });

      expect(readFileSync(outside, 'utf8')).toBe(document);
      if (replace) {
        expect(lstatSync(ownedPath).isSymbolicLink()).toBe(false);
        expectMirrored('owned', renderManualSkillMarkdown(updated));
      } else {
        expect(readlinkSync(ownedPath)).toBe(outside);
        expect(readlinkSync(join(claudeSkillsDir, 'owned'))).toBe(
          join(skillsDir, 'owned'),
        );
      }
    },
  );
});
