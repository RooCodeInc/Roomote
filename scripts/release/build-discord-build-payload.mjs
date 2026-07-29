#!/usr/bin/env node
/**
 * Convert branch build JSON from stdin into a Discord webhook payload.
 */

import { buildDiscordBuildPayload } from './lib.mjs';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
}

if (!input.trim()) {
  throw new Error('Expected branch build JSON on stdin');
}

const build = JSON.parse(input);
process.stdout.write(`${JSON.stringify(buildDiscordBuildPayload(build))}\n`);
