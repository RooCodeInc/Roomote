import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDiscordReleasePayload } from '../lib.mjs';

describe('Discord release announcement', () => {
  it('creates a compact patch announcement from the release intro', () => {
    const url = 'https://github.com/RooCodeInc/Roomote/releases/tag/v0.24.1';
    const payload = buildDiscordReleasePayload({
      name: '0.24.1 (2026-07-29)',
      body: [
        '## 0.24.1 (2026-07-29)',
        '',
        'A useful release.',
        '',
        '### Highlights',
        '',
        '- A useful new capability',
        '',
        '### Patch changes',
        '',
        '- Internal patch details',
      ].join('\n'),
      url,
      publishedAt: '2026-07-29T18:00:00Z',
      tagName: 'v0.24.1',
    });

    assert.equal(payload.username, 'Roomote Releases');
    assert.equal(payload.flags, 4);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(
      payload.content,
      [
        '### Roomote 0.24.1 is published',
        '',
        'A useful release.',
        '',
        `See the full release notes → [v0.24.1](${url}).`,
      ].join('\n'),
    );
    assert.equal('embeds' in payload, false);
  });

  it('creates a compact minor announcement', () => {
    const url = 'https://github.com/RooCodeInc/Roomote/releases/tag/v0.25.0';
    const payload = buildDiscordReleasePayload({
      body: [
        '## 0.25.0 (2026-07-30)',
        '',
        'A focused minor release.',
        '',
        '### Highlights',
        '',
        '- A useful new capability',
      ].join('\n'),
      url,
      tagName: 'v0.25.0',
    });

    assert.equal(
      payload.content,
      [
        '### Roomote 0.25.0 is published',
        '',
        'A focused minor release.',
        '',
        `See the full release notes → [v0.25.0](${url}).`,
      ].join('\n'),
    );
  });

  it('creates a detailed major announcement without redundant spacing', () => {
    const url = 'https://github.com/RooCodeInc/Roomote/releases/tag/v1.0.0';
    const payload = buildDiscordReleasePayload({
      body: [
        '## 1.0.0 (2026-08-01)',
        '',
        'A major release.',
        '',
        '### Highlights',
        '',
        '- A useful new capability',
        '',
        '### Patch changes',
        '',
        '- Internal patch details',
      ].join('\n'),
      url,
      tagName: 'v1.0.0',
    });

    assert.equal(
      payload.content,
      [
        '# Roomote 1.0.0 is out!',
        '',
        'A major release.',
        '### Highlights',
        '',
        '- A useful new capability',
        '',
        `See the full release notes → [v1.0.0](${url}). Let us know what you think!`,
      ].join('\n'),
    );
  });

  it('truncates long notes while keeping the release link', () => {
    const url = 'https://github.com/RooCodeInc/Roomote/releases/tag/v0.24.1';
    const payload = buildDiscordReleasePayload({
      name: '',
      body: 'x'.repeat(5000),
      url,
      tagName: 'v0.24.1',
    });
    assert.ok(payload.content.length <= 2000);
    assert.match(
      payload.content,
      new RegExp(
        `See the full release notes → \\[v0\\.24\\.1\\]\\(${url}\\)\\.$`,
      ),
    );
  });
});
