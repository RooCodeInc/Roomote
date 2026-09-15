import { client } from './client';

export const isOrgEnabled = (mcpId: string) =>
  client.mcpConnections.isOrgEnabled.query({ mcpId });

export const getMcpServerConfigs = () =>
  client.mcpConnections.getMcpServerConfigs.query();

export const getCredentialEgressDelivery = (nonce: string) =>
  client.mcpConnections.getCredentialEgressDelivery.query({ nonce });

export const markCredentialEgressBootstrapReady = (nonce: string) =>
  client.mcpConnections.markCredentialEgressBootstrapReady.mutate({ nonce });

export const getCustomStdioMcpServers = () =>
  client.mcpConnections.getCustomStdioMcpServers.query();
