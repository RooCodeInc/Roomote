import type { SandboxServerRpcClient } from '@roomote/sdk/sandbox-router';

/**
 * SandboxClient
 */

export type SandboxClient = SandboxServerRpcClient;

export interface QueuedMessage {
  id: string;
  text: string;
  images?: string[];
  userName?: string;
  userImageUrl?: string;
  clientMessageId?: string;
  timestamp: number;
  optimistic?: boolean;
}

export * from './messages/acp';
