import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDiscordBuildPayload,
  buildDiscordReleasePayload,
} from '../lib.mjs';

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

describe('Discord branch build announcement', () => {
  it('creates a development build payload', () => {
    const payload = buildDiscordBuildPayload({
      branch: 'develop',
      commitMessage: 'Improve the release feed',
      committedAt: '2026-07-29T19:00:00Z',
      repository: 'RooCodeInc/Roomote',
      sha: '1234567890abcdef',
      version: 'develop-12345678',
    });

    assert.equal(payload.username, 'Roomote Builds');
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.deepEqual(payload.embeds, [
      {
        title: 'Development build is ready',
        url: 'https://github.com/RooCodeInc/Roomote/commit/1234567890abcdef',
        description: 'Improve the release feed',
        color: 0x20bbc9,
        fields: [
          { name: 'Branch', value: '`develop`', inline: true },
          {
            name: 'Image tag',
            value: '`develop-12345678`',
            inline: true,
          },
          {
            name: 'Commit',
            value:
              '[12345678](https://github.com/RooCodeInc/Roomote/commit/1234567890abcdef)',
            inline: true,
          },
        ],
        footer: { text: 'RooCodeInc/Roomote • GHCR Publish' },
        timestamp: '2026-07-29T19:00:00Z',
      },
    ]);
  });

  it('uses Roomote branding for main builds', () => {
    const payload = buildDiscordBuildPayload({
      branch: 'main',
      repository: 'RooCodeInc/Roomote',
      sha: 'abcdef1234567890',
      version: 'main-abcdef12',
    });

    assert.equal(payload.embeds[0].title, 'Main build is ready');
    assert.equal(payload.embeds[0].color, 0xb0cd26);
  });
});
