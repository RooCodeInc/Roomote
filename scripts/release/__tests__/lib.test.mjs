import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  computeNextVersion,
  extractChangelogSection,
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
})
