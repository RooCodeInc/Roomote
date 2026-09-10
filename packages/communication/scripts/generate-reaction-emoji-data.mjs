import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = require.resolve('emoji-datasource/emoji.json');
const outputPath = resolve(packageDir, 'src/reaction-emoji-data.json');
const sourceLicensePath = require.resolve('emoji-datasource/LICENSE');
const outputLicensePath = resolve(
  packageDir,
  'src/reaction-emoji-data.LICENSE.txt',
);
const emojiData = JSON.parse(await readFile(sourcePath, 'utf8'));

const shortcodeToUnified = {};
const shortcodeAliases = {};
const skinTonesByShortcode = {};
const toneCodepoints = ['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF'];

for (const entry of emojiData) {
  const shortNames = entry.short_names;
  if (!Array.isArray(shortNames) || shortNames.length === 0) continue;
  if (typeof entry.unified !== 'string' || !entry.unified) continue;

  const canonical = shortNames[0];
  for (const shortName of shortNames) {
    if (shortcodeToUnified[shortName]) {
      throw new Error(`Duplicate emoji shortcode: ${shortName}`);
    }
    shortcodeToUnified[shortName] = entry.unified;
    if (shortName !== canonical) shortcodeAliases[shortName] = canonical;
  }

  const variations = entry.skin_variations;
  if (!variations || typeof variations !== 'object') continue;
  const tones = toneCodepoints.map((codepoint) => {
    const variation = variations[codepoint];
    return typeof variation?.unified === 'string' ? variation.unified : null;
  });
  if (tones.some(Boolean)) skinTonesByShortcode[canonical] = tones;
}

const sortObject = (value) =>
  Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
const output = `${JSON.stringify(
  {
    source: 'emoji-datasource@16.0.0 (MIT)',
    shortcodes: sortObject(shortcodeToUnified),
    aliases: sortObject(shortcodeAliases),
    skinTones: sortObject(skinTonesByShortcode),
  },
  null,
  2,
)}\n`;

await Promise.all([
  writeFile(outputPath, output),
  writeFile(outputLicensePath, await readFile(sourceLicensePath, 'utf8')),
]);
await execFileAsync('pnpm', ['exec', 'oxfmt', outputPath], { cwd: packageDir });
