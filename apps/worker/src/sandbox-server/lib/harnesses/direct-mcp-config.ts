import { HTTP_INTEGRATIONS_BROKER } from '../../../mcp-provenance';

export interface DirectStreamableHttpMcpConfig {
  type: 'streamable-http';
  roomoteManaged?: typeof HTTP_INTEGRATIONS_BROKER;
  url: string;
  headers: Record<string, string>;
}

export interface DirectStdioMcpConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type DirectMcpConfig =
  | DirectStreamableHttpMcpConfig
  | DirectStdioMcpConfig;
