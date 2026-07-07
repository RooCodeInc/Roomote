export interface DirectStreamableHttpMcpConfig {
  type: 'streamable-http';
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
