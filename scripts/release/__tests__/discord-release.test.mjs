import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDiscordReleasePayload } from '../lib.mjs';

describe('Discord release announcement', () => {
  it('creates a regular announcement without patch changes', () => {
    const url = 'https://github.com/RooCodeInc/Roomote/releases/tag/v0.24.1';
    const payload = buildDiscordReleasePayload({
      name: '0.24.1 (2026-07-29)',
      body: [
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
    assert.deepEqual(payload.allowed_mentions, { parse: ['everyone'] });
    assert.equal(
      payload.content,
      [
        '@everyone',
        '',
        '# Roomote 0.24.1 is out!',
        '',
        'A useful release.',
        '',
        '### Highlights',
        '',
        '- A useful new capability',
        '',
        `See the full release notes [v0.24.1](${url}). Let us know what you think!`,
      ].join('\n'),
    );
    assert.equal('embeds' in payload, false);
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
        `…\\n\\nSee the full release notes \\[v0\\.24\\.1\\]\\(${url}\\)\\. Let us know what you think!$`,
      ),
    );
  });
});
