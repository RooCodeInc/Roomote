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

  await sharp(SOURCE_PATH)
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toFile(join(OUTPUT_DIRECTORY, name));
}

console.log(`Generated ${ICON_COUNT} task robot icons in ${OUTPUT_DIRECTORY}`);
