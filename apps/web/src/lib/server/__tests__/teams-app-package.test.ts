import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  buildStoredZip,
  buildTeamsAppManifest,
  buildTeamsAppPackage,
} from '../teams-app-package';

type PngPixel = {
  r: number;
  g: number;
  b: number;
  a: number;
};

function readPngPixels(filePath: string): PngPixel[] {
  const png = readFileSync(filePath);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = png.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      colorType = data[9]!;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  const channels = colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  expect(channels).toBeGreaterThan(0);

  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const pixels: PngPixel[] = [];
  let inputOffset = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset]!;
    inputOffset += 1;
    const row = Buffer.from(
      inflated.subarray(inputOffset, inputOffset + stride),
    );
    inputOffset += stride;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel]! : 0;
      const up = previous[x]!;
      const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel]! : 0;

      if (filter === 1) {
        row[x] = (row[x]! + left) & 0xff;
      } else if (filter === 2) {
        row[x] = (row[x]! + up) & 0xff;
      } else if (filter === 3) {
        row[x] = (row[x]! + Math.floor((left + up) / 2)) & 0xff;
      } else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        row[x] = (row[x]! + predictor) & 0xff;
      } else {
        expect(filter).toBe(0);
      }
    }

    for (let x = 0; x < width; x += 1) {
      const pixelOffset = x * bytesPerPixel;
      if (colorType === 4) {
        const gray = row[pixelOffset]!;
        pixels.push({
          r: gray,
          g: gray,
          b: gray,
          a: row[pixelOffset + 1]!,
        });
      } else {
        pixels.push({
          r: row[pixelOffset]!,
          g: row[pixelOffset + 1]!,
          b: row[pixelOffset + 2]!,
          a: row[pixelOffset + 3]!,
        });
      }
    }

    previous = row;
  }

  return pixels;
}

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

describe('Teams app icons', () => {
  it('keeps the outline icon transparent with only white visible pixels', () => {
    const pixels = readPngPixels(
      path.join(process.cwd(), 'public', 'teams-app-icon-outline.png'),
    );

    expect(pixels.some((pixel) => pixel.a === 0)).toBe(true);
    expect(
      pixels.filter(
        (pixel) =>
          pixel.a > 0 &&
          (pixel.r !== 255 || pixel.g !== 255 || pixel.b !== 255),
      ),
    ).toEqual([]);
  });
});
