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
export const syncSessionProxyServices = (
  input: import('@roomote/types').SessionProxySync,
  signal?: AbortSignal,
) => client.mcpConnections.syncSessionProxyServices.mutate(input, { signal });
export const acknowledgeSessionProxyServices = (
  generation: number,
  revision: number,
  signal?: AbortSignal,
) =>
  client.mcpConnections.acknowledgeSessionProxyServices.mutate(
    { generation, revision },
    { signal },
  );
