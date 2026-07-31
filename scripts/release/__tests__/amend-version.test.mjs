import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  amendChangelogSection,
  amendProductVersion,
} from '../lib.mjs'

describe('release amendments', () => {
  it('adds notes without changing the product version', () => {
    const root = mkdtempSync(join(tmpdir(), 'roomote-amend-version-'))
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'roomote', version: '1.2.3' }, null, 2) + '\n',
      )
      writeFileSync(
        join(root, 'CHANGELOG.md'),
        `# Changelog

Intro.

## 1.2.3 (2026-07-31)

Existing summary.

### Highlights

- Existing highlight.

### Patch changes

- Existing fix.

## 1.2.2 (2026-07-30)

Previous release.
`,
      )
      const changesetDir = join(root, '.changeset')
      mkdirSync(changesetDir)
      writeFileSync(join(changesetDir, 'README.md'), '# Changesets\n')
      writeFileSync(
        join(changesetDir, 'faster-clones.md'),
        `---\n'@roomote/web': minor\n---\n\nClone repositories faster.\n`,
      )
      writeFileSync(
        join(changesetDir, 'review-fix.md'),
        `---\n'@roomote/web': patch\n---\n\nHonor review instructions.\n`,
      )

      const result = amendProductVersion(root)
      assert.equal(result.version, '1.2.3')
      assert.deepEqual(result.changesets, [
        'faster-clones.md',
        'review-fix.md',
      ])
      assert.equal(
        JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
        '1.2.3',
      )

      const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
      assert.match(changelog, /Existing summary/)
      assert.match(changelog, /### Highlights\n\n- Existing highlight/)
      assert.match(changelog, /### Minor changes\n\n- Clone repositories faster\./)
      assert.match(
        changelog,
        /### Patch changes\n\n- Existing fix\.\n- Honor review instructions\./,
      )
      assert.equal(changelog.match(/## 1\.2\.2 \(2026-07-30\)/g)?.length, 1)
      assert.equal(existsSync(join(changesetDir, 'faster-clones.md')), false)
      assert.equal(existsSync(join(changesetDir, 'review-fix.md')), false)
      assert.equal(amendProductVersion(root), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a missing release section', () => {
    assert.throws(
      () => amendChangelogSection('# Changelog\n', [], '1.2.3'),
      /No CHANGELOG section found for 1\.2\.3/,
    )
  })
})
