import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(SCRIPT_DIRECTORY, 'task-robot-icons.source.jpg');
const OUTPUT_DIRECTORY = join(SCRIPT_DIRECTORY, '..', 'public', 'task-robots');
const SOURCE_GRID_SIZE = 11;
const ICON_COUNT = 100;
const OUTPUT_SIZE = 96;
const DRAWING_SIZE = 76;
const DRAWING_PADDING = 2;
const BACKGROUND = { r: 213, g: 241, b: 68 };
const FOREGROUND_DISTANCE_SQUARED = 50 ** 2;

async function findDrawingMetrics(image, name) {
  const { data: pixels, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
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
      const red = pixels[offset] - BACKGROUND.r;
      const green = pixels[offset + 1] - BACKGROUND.g;
      const blue = pixels[offset + 2] - BACKGROUND.b;
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

  if (right < 0) throw new Error(`${name} contains no drawing.`);
  return {
    left,
    top,
    right,
    bottom,
    imageWidth: info.width,
    imageHeight: info.height,
    centerX: horizontalMass / foregroundPixels,
    centerY: verticalMass / foregroundPixels,
  };
}

function paddedRectangle(bounds, padding) {
  const left = Math.max(0, bounds.left - padding);
  const top = Math.max(0, bounds.top - padding);
  const right = Math.min(bounds.imageWidth - 1, bounds.right + padding);
  const bottom = Math.min(bounds.imageHeight - 1, bounds.bottom + padding);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

const source = sharp(SOURCE_PATH);
const metadata = await source.metadata();
if (!metadata.width || !metadata.height || metadata.width !== metadata.height) {
  throw new Error('Task robot source must be a square image.');
}

await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
await mkdir(OUTPUT_DIRECTORY, { recursive: true });

for (let index = 0; index < ICON_COUNT; index += 1) {
  const row = Math.floor(index / SOURCE_GRID_SIZE);
  const column = index % SOURCE_GRID_SIZE;
  const left = Math.round((column * metadata.width) / SOURCE_GRID_SIZE);
  const top = Math.round((row * metadata.height) / SOURCE_GRID_SIZE);
  const right = Math.round(((column + 1) * metadata.width) / SOURCE_GRID_SIZE);
  const bottom = Math.round(((row + 1) * metadata.height) / SOURCE_GRID_SIZE);
  const name = `robot-${String(index + 1).padStart(3, '0')}.png`;
  const cell = await sharp(SOURCE_PATH)
    .extract({ left, top, width: right - left, height: bottom - top })
    .png()
    .toBuffer();
  const sourceBounds = await findDrawingMetrics(cell, name);

  const { data: drawing, info } = await sharp(cell)
    .extract(paddedRectangle(sourceBounds, DRAWING_PADDING))
    .resize(DRAWING_SIZE, DRAWING_SIZE, { fit: 'inside' })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  const outputLeft = Math.floor((OUTPUT_SIZE - info.width) / 2);
  const outputTop = Math.floor((OUTPUT_SIZE - info.height) / 2);

  const initialIcon = await sharp({
    create: {
      width: OUTPUT_SIZE,
      height: OUTPUT_SIZE,
      channels: 3,
      background: BACKGROUND,
    },
  })
    .composite([{ input: drawing, left: outputLeft, top: outputTop }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const finalBounds = await findDrawingMetrics(initialIcon, name);
  const finalRectangle = paddedRectangle(finalBounds, DRAWING_PADDING);
  const finalDrawing = await sharp(initialIcon)
    .extract(finalRectangle)
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: OUTPUT_SIZE,
      height: OUTPUT_SIZE,
      channels: 3,
      background: BACKGROUND,
    },
  })
    .composite([
      {
        input: finalDrawing,
        left: Math.max(
          0,
          Math.min(
            OUTPUT_SIZE - finalRectangle.width,
            Math.round(
              (OUTPUT_SIZE - 1) / 2 -
                (finalBounds.centerX - finalRectangle.left),
            ),
          ),
        ),
        top: Math.max(
          0,
          Math.min(
            OUTPUT_SIZE - finalRectangle.height,
            Math.round(
              (OUTPUT_SIZE - 1) / 2 -
                (finalBounds.centerY - finalRectangle.top),
            ),
          ),
        ),
      },
    ])
    .png({ compressionLevel: 9 })
    .toFile(join(OUTPUT_DIRECTORY, name));
}

console.log(`Generated ${ICON_COUNT} task robot icons in ${OUTPUT_DIRECTORY}`);
