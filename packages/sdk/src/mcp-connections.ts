import { client } from './client';

export const isOrgEnabled = (mcpId: string) =>
  client.mcpConnections.isOrgEnabled.query({ mcpId });

export const getMcpServerConfigs = () =>
  client.mcpConnections.getMcpServerConfigs.query();

export const getCustomStdioMcpServers = () =>
  client.mcpConnections.getCustomStdioMcpServers.query();
