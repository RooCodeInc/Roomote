import type {
  AuthTokenContext,
  AutomationTokenContext,
  McpAccessTokenContext,
  RunTokenContext,
} from '@roomote/types';

export type WebhookResponse = {
  status: 'ok' | 'error';
  message?: string;
  metadata?: Record<string, unknown>;
};

export type CiE2eAuthContext = {
  userId: string;
  environmentId: string;
  tokenType: 'ci_e2e';
};

export type Variables = {
  authContext:
    | AuthTokenContext
    | AutomationTokenContext
    | McpAccessTokenContext
    | RunTokenContext
    | undefined;
  ciE2eAuth: CiE2eAuthContext | undefined;
};
