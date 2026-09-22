import { client } from './client';

export const request = (input: {
  integrationId: string;
  toolName: string;
  nativeRequestId: string;
  args?: unknown;
}) => client.toolApprovals.request.mutate(input);

export const status = (approvalId: string) =>
  client.toolApprovals.status.query({ approvalId });
