import { client } from './client';

export const isOrgEnabled = (mcpId: string) =>
  client.mcpConnections.isOrgEnabled.query({ mcpId });

export const getMcpServerConfigs = () =>
  client.mcpConnections.getMcpServerConfigs.query();

export const getSessionEgressDelivery = (nonce: string) =>
  client.mcpConnections.getSessionEgressDelivery.query({ nonce });

export const markSessionEgressBootstrapReady = (nonce: string) =>
  client.mcpConnections.markSessionEgressBootstrapReady.mutate({ nonce });

export const getCustomStdioMcpServers = () =>
  client.mcpConnections.getCustomStdioMcpServers.query();
