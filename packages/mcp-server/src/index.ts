#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createRoomoteTaskClient } from './roomote-client.js';
import { createRoomoteMcpServer } from './server.js';

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const client = await createRoomoteTaskClient({
    roomoteUrl: requireEnvironmentVariable('ROOMOTE_URL'),
    accessToken: requireEnvironmentVariable('ROOMOTE_ACCESS_TOKEN'),
  });
  const server = createRoomoteMcpServer(client);
  const transport = new StdioServerTransport();

  const close = async () => {
    await server.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  };

  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());

  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
