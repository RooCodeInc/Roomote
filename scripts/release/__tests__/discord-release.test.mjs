import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDiscordReleasePayload } from '../lib.mjs';

describe('Discord release announcement', () => {
  it('creates a branded release payload', () => {
    const payload = buildDiscordReleasePayload({
      name: 'Roomote v0.24.1',
      body: '### Highlights\n\n- A useful new capability',
      url: 'https://github.com/RooCodeInc/Roomote/releases/tag/v0.24.1',
      publishedAt: '2026-07-29T18:00:00Z',
      tagName: 'v0.24.1',
    });

    assert.equal(payload.username, 'Roomote Releases');
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.deepEqual(payload.embeds, [
      {
        title: 'Roomote v0.24.1 is now available',
        url: 'https://github.com/RooCodeInc/Roomote/releases/tag/v0.24.1',
        description: '### Highlights\n\n- A useful new capability',
        color: 0xb0cd26,
        footer: { text: 'RooCodeInc/Roomote • GitHub Release' },
        timestamp: '2026-07-29T18:00:00Z',
      },
    ]);
  });

  it('truncates long notes with a release link', () => {
    const url = 'https://github.com/RooCodeInc/Roomote/releases/tag/v0.24.1';
    const payload = buildDiscordReleasePayload({
      name: '',
      body: 'x'.repeat(5000),
      url,
      tagName: 'v0.24.1',
    });
    const [embed] = payload.embeds;

    assert.equal(embed.title, 'Roomote v0.24.1 is now available');
    assert.ok(embed.description.length <= 4096);
    assert.match(
      embed.description,
      new RegExp(`…\\n\\n\\[Read the full release notes\\]\\(${url}\\)$`),
    );
    assert.equal('timestamp' in embed, false);
  });
});
