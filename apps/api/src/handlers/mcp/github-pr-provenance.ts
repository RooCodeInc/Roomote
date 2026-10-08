import { db, getSessionForFastConversation } from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  formatPrBodyAttribution,
  prependPrBodyAttribution,
  preservePrBodyAttribution,
} from '@roomote/types';
import {
  getToolCallName,
  McpProxyError,
  type McpAuthContext,
} from './proxy-utils';
import { readFastConversationIdHeader } from './tool-approval-enforcement';

/** Native conversational PR creation bypasses coding-task delivery. */
export async function normalizeNativeGitHubPrProvenance(input: {
  auth: McpAuthContext;
  request: unknown;
  headers: Headers;
}): Promise<unknown> {
  if (getToolCallName(input.request) !== 'create_pull_request')
    return input.request;
  const conversationId = readFastConversationIdHeader(input.headers);
  const session = conversationId
    ? await getSessionForFastConversation(db, conversationId)
    : null;
  if (
    !session ||
    (session.privacy === 'private' &&
      session.privateOwnerUserId !== input.auth.userId)
  ) {
    throw new McpProxyError(
      403,
      'PR creation requires an accessible originating session',
    );
  }
  const request = input.request as {
    params: { arguments?: Record<string, unknown> };
  };
  const args = request.params.arguments ?? {};
  const url = new URL(`/sessions/${session.id}`, Env.R_APP_URL);
  url.searchParams.set('utm_source', 'github-comment');
  url.searchParams.set('utm_medium', 'link');
  url.searchParams.set('utm_campaign', 'session');
  const authoredBody = typeof args.body === 'string' ? args.body : '';
  const line = preservePrBodyAttribution(
    formatPrBodyAttribution(
      'Created by Roomote.',
      `[View the session](${url.toString()}).`,
    ),
    authoredBody,
  );
  return {
    ...request,
    params: {
      ...request.params,
      arguments: {
        ...args,
        body: prependPrBodyAttribution(authoredBody, line),
      },
    },
  };
}
