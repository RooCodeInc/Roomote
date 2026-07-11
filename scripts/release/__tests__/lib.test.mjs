import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  applyProductVersion,
  buildChangelogSection,
  computeNextVersion,
  extractChangelogSection,
  findVersionCommit,
  insertChangelogSection,
  parsePendingChangesets,
} from '../lib.mjs'

describe('release lib', () => {
  it('computeNextVersion applies highest bump', () => {
    assert.equal(computeNextVersion('1.2.3', ['patch']), '1.2.4')
    assert.equal(computeNextVersion('1.2.3', ['minor', 'patch']), '1.3.0')
    assert.equal(computeNextVersion('1.2.3', ['major', 'minor']), '2.0.0')
    assert.equal(computeNextVersion('1.2.3', []), '1.2.3')
  })

  it('parsePendingChangesets reads frontmatter and summary', () => {
    const root = mkdtempSync(join(tmpdir(), 'roomote-changeset-'))
    try {
      const dir = join(root, '.changeset')
      mkdirSync(dir)
      writeFileSync(join(dir, 'README.md'), '# Changesets\n')
      writeFileSync(
        join(dir, 'nice-otter.md'),
        `---
"@roomote/types": minor
'@roomote/web': patch
---

Add declarative environments
`,
      )
      const entries = parsePendingChangesets(root)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].file, 'nice-otter.md')
      assert.match(entries[0].summary, /declarative environments/)
      assert.equal(entries[0].bumps['@roomote/types'], 'minor')
      assert.equal(entries[0].bumps['@roomote/web'], 'patch')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extractChangelogSection returns one release heading body', () => {
    const md = `# Changelog

Intro text.

## 0.2.0 (2026-07-09)

### Minor changes

- New thing

## 0.1.0 (2026-06-01)

### Patch changes

- Older thing
`
    const section = extractChangelogSection(md, '0.2.0')
    assert.match(section, /## 0.2.0/)
    assert.match(section, /New thing/)
    assert.equal(section.includes('Older thing'), false)
    assert.match(extractChangelogSection(md, 'v0.1.0'), /Older thing/)
    assert.equal(extractChangelogSection(md, '9.9.9'), null)
  })

  it('insertChangelogSection keeps intro prose above release headings', () => {
    const existing = `# Changelog

This file tracks product releases for Roomote (single monorepo version). Automated release entries are prepended by \`pnpm run version\`.

## 0.0.1 (2026-07-01)

### Patch changes

- First ship
`
    const inserted = insertChangelogSection(
      existing,
      `## 0.0.2 (2026-07-10)

### Patch changes

- Second ship
`,
    )
    const introIdx = inserted.indexOf('This file tracks product releases')
    const v002 = inserted.indexOf('## 0.0.2')
    const v001 = inserted.indexOf('## 0.0.1')
    assert.ok(introIdx > 0)
    assert.ok(v002 > introIdx)
    assert.ok(v001 > v002)
    assert.match(inserted, /^# Changelog\n\nThis file tracks/m)

    const onlyTitle = insertChangelogSection(
      '# Changelog\n\nIntro only.\n',
      '## 1.0.0\n\n- Boot\n',
    )
    assert.match(onlyTitle, /Intro only\.\n\n## 1\.0\.0/)
  })

  it('findVersionCommit returns the commit that introduced the tip version', () => {
    const root = mkdtempSync(join(tmpdir(), 'roomote-version-commit-'))
    const git = (...args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    try {
      git('init', '--quiet', '--initial-branch=develop')
      git('config', 'user.name', 'Test')
      git('config', 'user.email', 'test@example.com')

      const commit = (message) => {
        git('add', '-A')
        git('commit', '--quiet', '-m', message)
        return git('rev-parse', 'HEAD')
      }
      const setPkg = (fields) =>
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({ name: 'roomote', ...fields }, null, 2),
        )

      setPkg({ version: '0.0.1' })
      commit('initial 0.0.1')

      writeFileSync(join(root, 'other.txt'), 'unrelated\n')
      commit('unrelated change')

      setPkg({ version: '0.0.2' })
      const bumpSha = commit('chore(release): version roomote 0.0.2')

      setPkg({ version: '0.0.2', dependencies: { left: '1.0.0' } })
      commit('dep change keeps version')

      writeFileSync(join(root, 'other.txt'), 'rider feature\n')
      commit('rider feature after the bump')

      // The bump commit, not the tip or the later package.json touch.
      assert.equal(findVersionCommit({ cwd: root, version: '0.0.2' }), bumpSha)
      // A superseded version is no longer contiguous from the tip.
      assert.equal(findVersionCommit({ cwd: root, version: '0.0.1' }), null)
      // Unknown versions resolve to nothing.
      assert.equal(findVersionCommit({ cwd: root, version: '9.9.9' }), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('buildChangelogSection groups summaries by highest bump level', () => {
    const section = buildChangelogSection(
      [
        { file: 'one.md', summary: 'New capability', bumps: { '@roomote/web': 'minor' } },
        { file: 'two.md', summary: 'Bug\nfix details', bumps: { '@roomote/api': 'patch' } },
      ],
      '0.1.0',
      '2026-07-11',
    )
    assert.match(section, /^## 0\.1\.0 \(2026-07-11\)/)
    assert.match(section, /### Minor changes\n\n- New capability/)
    assert.match(section, /### Patch changes\n\n- Bug fix details/)
  })

  it('applyProductVersion bumps only the root version and consumes changesets', () => {
    const root = mkdtempSync(join(tmpdir(), 'roomote-apply-version-'))
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'roomote', version: '0.0.3' }, null, 2) + '\n',
      )
      mkdirSync(join(root, 'apps', 'web'), { recursive: true })
      writeFileSync(
        join(root, 'apps', 'web', 'package.json'),
        JSON.stringify({ name: '@roomote/web', version: '0.0.3' }, null, 2) + '\n',
      )
      const changesetDir = join(root, '.changeset')
      mkdirSync(changesetDir)
      writeFileSync(join(changesetDir, 'README.md'), '# Changesets\n')
      writeFileSync(
        join(changesetDir, 'brave-otter.md'),
        `---\n'@roomote/web': minor\n---\n\nAdd a new capability\n`,
      )

      const result = applyProductVersion(root, { date: '2026-07-11' })
      assert.equal(result.previous, '0.0.3')
      assert.equal(result.next, '0.1.0')
      assert.deepEqual(result.changesets, ['brave-otter.md'])

      const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      assert.equal(rootPkg.version, '0.1.0')
      // Workspace package versions are frozen.
      const webPkg = JSON.parse(
        readFileSync(join(root, 'apps', 'web', 'package.json'), 'utf8'),
      )
      assert.equal(webPkg.version, '0.0.3')
      // Changeset consumed; README kept.
      assert.equal(existsSync(join(changesetDir, 'brave-otter.md')), false)
      assert.equal(existsSync(join(changesetDir, 'README.md')), true)
      // Changelog created with the release section.
      const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
      assert.match(changelog, /## 0\.1\.0 \(2026-07-11\)/)
      assert.match(changelog, /- Add a new capability/)

      // Idempotent: nothing pending means nothing to do.
      assert.equal(applyProductVersion(root), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
