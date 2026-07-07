import { describe, expect, it } from 'vitest';

import {
  buildStoredZip,
  buildTeamsAppManifest,
  buildTeamsAppPackage,
} from '../teams-app-package';

describe('buildTeamsAppManifest', () => {
  it('fills the bot id, valid domains, and icon references', () => {
    const manifest = JSON.parse(
      buildTeamsAppManifest({
        botAppId: '5037b551-0000-0000-0000-000000000000',
        appUrl: 'https://roomote.example.com',
      }),
    ) as {
      id: string;
      bots: Array<{ botId: string; scopes: string[] }>;
      validDomains: string[];
      icons: { color: string; outline: string };
      developer: { websiteUrl: string };
      description: { full: string };
      webApplicationInfo: { id: string; resource: string };
      authorization: {
        permissions: {
          resourceSpecific: Array<{ name: string; type: string }>;
        };
      };
    };

    expect(manifest.id).toBe('5037b551-0000-0000-0000-000000000000');
    expect(manifest.bots[0]).toMatchObject({
      botId: '5037b551-0000-0000-0000-000000000000',
      scopes: ['personal', 'team', 'groupChat'],
    });
    expect(manifest.validDomains).toEqual(['roomote.example.com']);
    expect(manifest.icons).toEqual({
      color: 'color.png',
      outline: 'outline.png',
    });
    expect(manifest.developer.websiteUrl).toBe('https://roomote.example.com');
    expect(manifest.webApplicationInfo).toEqual({
      id: '5037b551-0000-0000-0000-000000000000',
      resource: 'https://roomote.example.com',
    });
    expect(manifest.authorization.permissions.resourceSpecific).toEqual([
      { name: 'ChannelMessage.Read.Group', type: 'Application' },
      { name: 'ChatMessage.Read.Chat', type: 'Application' },
    ]);
    expect(manifest.description.full).toContain(
      'receives channel and chat messages',
    );
  });
});

describe('buildStoredZip', () => {
  it('produces a structurally valid zip with all entries listed', () => {
    const zip = buildTeamsAppPackage({
      manifestJson: '{"ok":true}',
      colorIcon: Buffer.from('color-bytes'),
      outlineIcon: Buffer.from('outline-bytes'),
    });

    // Local file header signature at the start.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);

    // End-of-central-directory record at the tail reports three entries.
    const endOffset = zip.length - 22;
    expect(zip.readUInt32LE(endOffset)).toBe(0x06054b50);
    expect(zip.readUInt16LE(endOffset + 10)).toBe(3);

    const asText = zip.toString('latin1');
    expect(asText).toContain('manifest.json');
    expect(asText).toContain('color.png');
    expect(asText).toContain('outline.png');
  });

  it('records sizes and offsets that add up', () => {
    const data = Buffer.from('hello world');
    const zip = buildStoredZip([{ name: 'a.txt', data }]);

    // STORE keeps the payload verbatim right after the 30-byte header + name.
    const payloadStart = 30 + 'a.txt'.length;
    expect(
      zip.subarray(payloadStart, payloadStart + data.length).toString(),
    ).toBe('hello world');
    // Central directory offset points past the local section.
    const endOffset = zip.length - 22;
    expect(zip.readUInt32LE(endOffset + 16)).toBe(payloadStart + data.length);
  });
});
