import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const ASSET_DIRECTORY = join(process.cwd(), 'public', 'task-robots');
const BACKGROUND = { r: 213, g: 241, b: 68 };
const FOREGROUND_DISTANCE_SQUARED = 50 ** 2;

describe('generated task robot assets', () => {
  it('contains 100 centered 96px robot drawings', async () => {
    const files = (await readdir(ASSET_DIRECTORY))
      .filter((file) => file.endsWith('.png'))
      .sort();
    expect(files).toHaveLength(100);
    expect(files[0]).toBe('robot-001.png');
    expect(files.at(-1)).toBe('robot-100.png');

    for (const file of files) {
      const { data, info } = await sharp(join(ASSET_DIRECTORY, file))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([info.width, info.height], file).toEqual([96, 96]);

      let left = info.width;
      let top = info.height;
      let right = -1;
      let bottom = -1;
      let horizontalMass = 0;
      let verticalMass = 0;
      let foregroundPixels = 0;
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          const offset = (y * info.width + x) * info.channels;
          const red = data[offset] - BACKGROUND.r;
          const green = data[offset + 1] - BACKGROUND.g;
          const blue = data[offset + 2] - BACKGROUND.b;
          if (
            red * red + green * green + blue * blue <=
            FOREGROUND_DISTANCE_SQUARED
          ) {
            continue;
          }
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
          horizontalMass += x;
          verticalMass += y;
          foregroundPixels += 1;
        }
      }

      expect(right, `${file} has no drawing`).toBeGreaterThanOrEqual(0);
      expect(
        Math.min(left, top, info.width - 1 - right, info.height - 1 - bottom),
        `${file} canvas clearance`,
      ).toBeGreaterThanOrEqual(2);
      const horizontalOffset =
        horizontalMass / foregroundPixels - (info.width - 1) / 2;
      const verticalOffset =
        verticalMass / foregroundPixels - (info.height - 1) / 2;
      expect(
        Math.abs(horizontalOffset),
        `${file} horizontal center`,
      ).toBeLessThanOrEqual(4.5);
      expect(
        Math.abs(verticalOffset),
        `${file} vertical center`,
      ).toBeLessThanOrEqual(4.5);
    }
  });
});
