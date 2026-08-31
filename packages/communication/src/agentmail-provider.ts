import type {
  CommunicationChannelMessagesResult,
  CommunicationPostMessageInput,
  CommunicationPostMessageResult,
  CommunicationProviderAdapter,
  CommunicationReactionResult,
  CommunicationThreadLookupResult,
} from './provider';
import { UnsupportedCommunicationOperationError } from './provider';
import { readBoundedResponseBody } from './bounded-response-body';
import { getAgentMailApiBaseUrl } from './agentmail-api-base-url';
import {
  buildAgentMailButtonSections,
  buildAgentMailEmailBody,
  escapeAgentMailHtml,
} from './agentmail-format';

const DEFAULT_AGENTMAIL_TIMEOUT_MS = 10_000;
const DEFAULT_AGENTMAIL_MAX_RETRIES = 2;
const AGENTMAIL_RETRY_BASE_DELAY_MS = 250;
const AGENTMAIL_ERROR_BODY_MAX_BYTES = 4_096;

/**
 * The durable reply anchor for one AgentMail conversation, resolved from
 * storage at send time. The adapter never trusts caller-supplied reply
 * targets — email threading must always come from the recorded route.
 */
export type AgentMailReplyRoute = {
  inboxId: string;
  replyToMessageId: string | null;
  recipientEmail: string | null;
  subject?: string | null;
};

export type AgentMailCommunicationProviderOptions = {
  apiKey: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Resolves the internal conversation id carried in `input.threadId` to the
   * stored reply route (inbox, anchor message, recipient).
   */
  resolveRoute: (conversationId: string) => Promise<AgentMailReplyRoute | null>;
  /**
   * Invoked after a successful send. Write-back of the conversation's
   * `latestOutboundMessageId` happens here, not in the adapter.
   */
  onMessageSent?: (update: {
    conversationId: string;
    messageId: string;
    threadId?: string;
  }) => Promise<void>;
};

type AgentMailSendResponse = {
  message_id?: string;
  thread_id?: string;
};

export class AgentMailCommunicationProvider implements CommunicationProviderAdapter {
  readonly provider = 'agentmail' as const;

  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: AgentMailCommunicationProviderOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? getAgentMailApiBaseUrl()).replace(
      /\/+$/,
      '',
    );
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_AGENTMAIL_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_AGENTMAIL_MAX_RETRIES;
  }

  /**
   * `input.channelId` carries the AgentMail inbox id; `input.threadId`
   * carries the INTERNAL conversation id (never the provider thread id).
   * Every send resolves the stored reply route — caller-supplied reply
   * anchors are ignored by design so a reply can never target the wrong
   * message or leak to the wrong recipient.
   */
  async postMessage(
    input: CommunicationPostMessageInput,
  ): Promise<CommunicationPostMessageResult> {
    const text = input.text?.trim();

    if (!text) {
      throw new Error('AgentMail postMessage requires text.');
    }

    if (!input.threadId) {
      throw new UnsupportedCommunicationOperationError({
        provider: 'agentmail',
        operation: 'postMessage',
        message: 'AgentMail does not support unsolicited outbound email.',
        help: 'Email is inbound-initiated in v1: sends must reply within an existing conversation (pass the internal conversation id as threadId).',
      });
    }

    const conversationId = input.threadId;
    const route = await this.options.resolveRoute(conversationId);

    if (!route || !route.replyToMessageId) {
      // A reply without a durable route is a bug upstream, not a fallback.
      throw new Error(
        `AgentMail conversation ${conversationId} has no stored reply route; refusing to send without a reply anchor.`,
      );
    }

    const useMarkdown =
      input.textFormat !== 'plain' && input.textFormat !== 'xml';
    const body = useMarkdown
      ? buildAgentMailEmailBody(text)
      : {
          text,
          html: `<div>${escapeAgentMailHtml(text).replaceAll('\n', '<br />')}</div>`,
        };

    // Email has no callback intake, so only URL buttons render (one-click
    // answer links); callback-data buttons are silently skipped.
    const buttonRows = (input.buttons ?? []).map((row) =>
      row
        .filter((button) => button.url)
        .map((button) => ({ text: button.text, url: button.url! })),
    );
    const buttonSections = buildAgentMailButtonSections(buttonRows);
    if (buttonSections.html) {
      body.html = `${body.html}${buttonSections.html}`;
      body.text = `${body.text}\n\n${buttonSections.text}`;
    }

    const response = await this.request<AgentMailSendResponse>(
      'POST',
      `/v0/inboxes/${encodeURIComponent(route.inboxId)}/messages/${encodeURIComponent(route.replyToMessageId)}/reply`,
      {
        text: body.text,
        html: body.html,
        // Reply only to the recorded correspondent — never reply-all, never
        // cc. Omitting `to` lets AgentMail default to the original sender.
        ...(route.recipientEmail ? { to: [route.recipientEmail] } : {}),
      },
      {
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      },
    );
    const messageId = response.message_id;

    if (!messageId) {
      throw new Error('AgentMail reply returned no message_id.');
    }

    await this.options.onMessageSent?.({
      conversationId,
      messageId,
      ...(response.thread_id ? { threadId: response.thread_id } : {}),
    });

    return {
      provider: 'agentmail',
      channelId: input.channelId,
      messageId,
      lastTextMessageId: messageId,
      threadId: conversationId,
    };
  }

  async fetchThreadMessages(_input: {
    channelId: string;
    messageId: string;
  }): Promise<CommunicationThreadLookupResult> {
    throw new UnsupportedCommunicationOperationError({
      provider: 'agentmail',
      operation: 'fetchThreadMessages',
      message:
        'AgentMail thread history reads are not supported by this adapter.',
      help: 'Use stored conversation messages for active task context.',
    });
  }

  async fetchChannelMessages(_input: {
    channelId: string;
    oldest?: string;
    latest?: string;
  }): Promise<CommunicationChannelMessagesResult> {
    throw new UnsupportedCommunicationOperationError({
      provider: 'agentmail',
      operation: 'fetchChannelMessages',
      message:
        'AgentMail inbox history reads are not supported by this adapter.',
      help: 'Use stored conversation messages for active task context.',
    });
  }

  async addReaction(_input: {
    channelId: string;
    messageId: string;
    name: string;
  }): Promise<CommunicationReactionResult> {
    throw new UnsupportedCommunicationOperationError({
      provider: 'agentmail',
      operation: 'addReaction',
      message: 'AgentMail does not support reactions.',
      help: 'Email has no reactions; send a reply instead.',
    });
  }

  async removeReaction(_input: {
    channelId: string;
    messageId: string;
    name: string;
  }): Promise<CommunicationReactionResult> {
    throw new UnsupportedCommunicationOperationError({
      provider: 'agentmail',
      operation: 'removeReaction',
      message: 'AgentMail does not support reactions.',
      help: 'Email has no reactions; send a reply instead.',
    });
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    options: { idempotencyKey?: string } = {},
  ): Promise<T> {
    return callAgentMailApi<T>({
      fetchImpl: this.fetchImpl,
      apiBaseUrl: this.apiBaseUrl,
      apiKey: this.options.apiKey,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      method,
      path,
      ...(body !== undefined ? { body } : {}),
      ...(options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
    });
  }
}

/**
 * Shared REST call with the same retry/timeout discipline as the Telegram
 * provider: AbortSignal timeout per attempt, bounded retries on 429/5xx
 * honoring `Retry-After`, and bounded error-body reads.
 */
async function callAgentMailApi<T>(params: {
  fetchImpl: typeof fetch;
  apiBaseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<T> {
  const url = `${params.apiBaseUrl}${params.path}`;
  let lastError: unknown;

  for (let attempt = 0; attempt <= params.maxRetries; attempt += 1) {
    let response: Response;

    try {
      response = await params.fetchImpl(url, {
        method: params.method,
        headers: {
          authorization: `Bearer ${params.apiKey}`,
          ...(params.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
          ...(params.idempotencyKey
            ? { 'idempotency-key': params.idempotencyKey }
            : {}),
        },
        ...(params.body !== undefined
          ? { body: JSON.stringify(params.body) }
          : {}),
        signal: AbortSignal.timeout(params.timeoutMs),
      });
    } catch (error) {
      lastError = error;

      // Only idempotent-by-contract calls retry network errors: GET always,
      // and writes only when the caller supplied an Idempotency-Key.
      const retryNetworkErrors =
        params.method === 'GET' || Boolean(params.idempotencyKey);

      if (!retryNetworkErrors || attempt >= params.maxRetries) {
        throw error;
      }

      await delay(AGENTMAIL_RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }

    // 429 means the request was rejected before processing, so it is always
    // safe to retry. A 5xx is ambiguous — the provider may have sent the
    // email before failing — so mutating calls retry it only when the caller
    // supplied an Idempotency-Key that makes the replay a no-op.
    const retryableStatus =
      response.status === 429 ||
      (response.status >= 500 &&
        (params.method === 'GET' || Boolean(params.idempotencyKey)));

    if (attempt < params.maxRetries && retryableStatus) {
      const retryAfterSeconds = Number.parseFloat(
        response.headers.get('retry-after') ?? '',
      );
      const delayMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : AGENTMAIL_RETRY_BASE_DELAY_MS * 2 ** attempt;

      await response.body?.cancel().catch(() => undefined);
      await delay(delayMs);
      continue;
    }

    if (!response.ok) {
      const bodyBytes = await readBoundedResponseBody(
        response,
        AGENTMAIL_ERROR_BODY_MAX_BYTES,
        `AgentMail ${params.method} ${params.path} error body exceeded ${AGENTMAIL_ERROR_BODY_MAX_BYTES} bytes.`,
      ).catch(() => new Uint8Array());
      const bodyText = new TextDecoder().decode(bodyBytes).trim();

      throw new Error(
        `AgentMail ${params.method} ${params.path} failed (${response.status})${
          bodyText ? `: ${bodyText}` : ''
        }`,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json().catch(() => ({}))) as T;
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`AgentMail ${params.method} ${params.path} failed.`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type AgentMailInbox = {
  inbox_id: string;
  display_name?: string;
} & Record<string, unknown>;

export type AgentMailWebhook = {
  webhook_id: string;
  url: string;
  secret?: string;
  inbox_ids?: string[];
} & Record<string, unknown>;

export type AgentMailApiClientOptions = {
  apiKey: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type AgentMailOutboundBody = {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
};

/**
 * Standalone AgentMail REST client for setup and reconcile flows (inbox and
 * webhook provisioning), separate from the message-sending adapter above.
 */
export class AgentMailApiClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: AgentMailApiClientOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? getAgentMailApiBaseUrl()).replace(
      /\/+$/,
      '',
    );
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_AGENTMAIL_TIMEOUT_MS;
  }

  listInboxes(): Promise<
    { inboxes?: AgentMailInbox[] } & Record<string, unknown>
  > {
    return this.request('GET', '/v0/inboxes');
  }

  createInbox(input: {
    username?: string;
    domain?: string;
    clientId?: string;
    displayName?: string;
  }): Promise<AgentMailInbox> {
    return this.request('POST', '/v0/inboxes', {
      ...(input.username ? { username: input.username } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      ...(input.clientId ? { client_id: input.clientId } : {}),
      ...(input.displayName ? { display_name: input.displayName } : {}),
    });
  }

  getInbox(inboxId: string): Promise<AgentMailInbox> {
    return this.request('GET', `/v0/inboxes/${encodeURIComponent(inboxId)}`);
  }

  listWebhooks(): Promise<
    { webhooks?: AgentMailWebhook[] } & Record<string, unknown>
  > {
    return this.request('GET', '/v0/webhooks');
  }

  createWebhook(input: {
    url: string;
    clientId?: string;
    inboxIds?: string[];
    eventTypes?: string[];
  }): Promise<AgentMailWebhook> {
    return this.request('POST', '/v0/webhooks', {
      url: input.url,
      ...(input.clientId ? { client_id: input.clientId } : {}),
      ...(input.inboxIds ? { inbox_ids: input.inboxIds } : {}),
      ...(input.eventTypes ? { event_types: input.eventTypes } : {}),
    });
  }

  getWebhook(webhookId: string): Promise<AgentMailWebhook> {
    return this.request('GET', `/v0/webhooks/${encodeURIComponent(webhookId)}`);
  }

  updateWebhook(
    webhookId: string,
    input: { url?: string; inboxIds?: string[] },
  ): Promise<AgentMailWebhook> {
    return this.request(
      'PATCH',
      `/v0/webhooks/${encodeURIComponent(webhookId)}`,
      {
        ...(input.url ? { url: input.url } : {}),
        ...(input.inboxIds ? { inbox_ids: input.inboxIds } : {}),
      },
    );
  }

  deleteWebhook(webhookId: string): Promise<void> {
    return this.request(
      'DELETE',
      `/v0/webhooks/${encodeURIComponent(webhookId)}`,
    );
  }

  getMessage(
    inboxId: string,
    messageId: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      'GET',
      `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  replyToMessage(
    inboxId: string,
    messageId: string,
    body: AgentMailOutboundBody,
    opts: { idempotencyKey?: string } = {},
  ): Promise<AgentMailSendResponse> {
    return this.request(
      'POST',
      `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/reply`,
      { ...body },
      opts,
    );
  }

  sendMessage(
    inboxId: string,
    body: AgentMailOutboundBody,
    opts: { idempotencyKey?: string } = {},
  ): Promise<AgentMailSendResponse> {
    return this.request(
      'POST',
      `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
      { ...body },
      opts,
    );
  }

  private request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    opts: { idempotencyKey?: string } = {},
  ): Promise<T> {
    return callAgentMailApi<T>({
      fetchImpl: this.fetchImpl,
      apiBaseUrl: this.apiBaseUrl,
      apiKey: this.options.apiKey,
      timeoutMs: this.timeoutMs,
      maxRetries: DEFAULT_AGENTMAIL_MAX_RETRIES,
      method,
      path,
      ...(body !== undefined ? { body } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
  }
}
