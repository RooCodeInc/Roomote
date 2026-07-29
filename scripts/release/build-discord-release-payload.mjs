#!/usr/bin/env node
/**
 * Convert GitHub Release JSON from stdin into a Discord webhook payload.
 */

import { buildDiscordReleasePayload } from './lib.mjs';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
}

if (!input.trim()) {
  throw new Error('Expected GitHub Release JSON on stdin');
}

const release = JSON.parse(input);
process.stdout.write(
  `${JSON.stringify(buildDiscordReleasePayload(release))}\n`,
);
