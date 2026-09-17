import { createHmac, randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

type JsonRecord = Record<string, unknown>;

export type MockAgentMailPod = {
  pod_id: string;
  name?: string;
  /** Creation is idempotent per client_id, matching real AgentMail. */
  client_id?: string;
  created_at: string;
};

export type MockAgentMailInbox = {
  /** Canonical id, `<username>@<domain>` — also the inbox email address. */
  inbox_id: string;
  username: string;
  domain: string;
  display_name?: string;
  /** Creation is idempotent per client_id, matching real AgentMail. */
  client_id?: string;
  /** Set when the inbox lives inside a pod (`POST /v0/pods/{pod}/inboxes`). */
  pod_id?: string;
  created_at: string;
};

export type MockAgentMailWebhook = {
  webhook_id: string;
  url: string;
  /** Svix-style signing secret: `whsec_<base64 key>`. */
  secret: string;
  client_id?: string;
  /** Omitted means the webhook receives events for every inbox. */
  inbox_ids?: string[];
  /**
   * Omitted means every pod (and organization-level inboxes). A webhook
   * created through `POST /v0/pods/{pod}/webhooks` is scoped to that pod.
   */
  pod_ids?: string[];
  /** Omitted means the webhook receives every event type. */
  event_types?: string[];
  enabled: boolean;
  created_at: string;
};

export type MockAgentMailStoredMessage = {
  message_id: string;
  thread_id: string;
  inbox_id: string;
  /**
   * `inbound` messages arrive via `/mock/events`; `outbound` messages were
   * sent by the system under test through the send/reply endpoints — evals
   * assert replies by filtering on this.
   */
  direction: 'inbound' | 'outbound';
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  timestamp: string;
  in_reply_to?: string;
  references?: string[];
  /** Extra RFC 5322 headers, e.g. `auto-submitted` for automated senders. */
  headers?: Record<string, string>;
};

type MockAgentMailWebhookDelivery = {
  webhook_id: string;
  url: string;
  status: number;
  body: string;
};

export type MockAgentMailDeliveredEvent = {
  event_id: string;
  /**
   * Svix delivery id. Redeliveries reuse it — that is how the production
   * verifier recognizes a duplicate delivery of the same event.
   */
  svix_id: string;
  event_type: string;
  inbox_id: string;
  message_id: string;
  /** Raw JSON body signed and delivered — redeliveries resend it verbatim. */
  payload: string;
  deliveries: MockAgentMailWebhookDelivery[];
};

export type MockAgentMailState = {
  /**
   * API keys accepted as `Authorization: Bearer <key>`. Empty or omitted
   * accepts any non-empty bearer token — convenient for exploratory runs;
   * set it to catch requests built with the wrong credential.
   */
  acceptedApiKeys?: string[];
  pods?: MockAgentMailPod[];
  inboxes: MockAgentMailInbox[];
  webhooks?: MockAgentMailWebhook[];
  messages?: MockAgentMailStoredMessage[];
  events?: MockAgentMailDeliveredEvent[];
};

/**
 * An inbound email as a scenario author writes it. `threadId` continues an
 * existing thread (minting reply headers the way a real mail chain would);
 * omit it to start a fresh thread. The flags exercise edge cases the real
 * AgentMail pipeline produces: `autoSubmitted` stamps an `Auto-Submitted`
 * header, `oversize` delivers the webhook with `text`/`html` omitted (the
 * 1MB payload cap), and `duplicate` redelivers the previous event with the
 * SAME svix-id instead of creating a new message.
 */
export type MockAgentMailInboundEmail = {
  kind?: 'message';
  inboxId: string;
  from: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  threadId?: string;
  timestamp?: string;
  autoSubmitted?: boolean;
  oversize?: boolean;
  duplicate?: boolean;
};

/**
 * A delivery-failure notification (`message.bounced` / `message.complained`)
 * as a scenario author writes it, for exercising the outbound suppression
 * pipeline. Bounce recipients deliver as `{address, status}` objects and
 * complaint recipients as bare strings, matching real AgentMail payloads.
 */
export type MockAgentMailDeliveryFailure = {
  kind: 'bounce' | 'complaint';
  inboxId: string;
  recipients: string[];
  messageId?: string;
  threadId?: string;
  /** Bounce only; defaults to 'Permanent'. */
  bounceType?: string;
  subType?: string;
};

export type MockAgentMailReplayEvent =
  | MockAgentMailInboundEmail
  | MockAgentMailDeliveryFailure
  | {
      /** Redeliver a past event verbatim, reusing its original svix-id. */
      kind: 'redeliver';
      eventId: string;
    };

type MockAgentMailDispatchResult = {
  eventId: string;
  svixId: string;
  messageId: string;
  threadId: string;
  deliveries: MockAgentMailWebhookDelivery[];
};

const AGENTMAIL_DEFAULT_DOMAIN = 'agentmail.to';
const AGENTMAIL_MESSAGE_RECEIVED_EVENT = 'message.received';

/**
 * `kind` is optional on inbound emails, so the union is not a discriminated
 * union TypeScript narrows on its own; this guard does the narrowing.
 */
function isMockDeliveryFailure(
  event: MockAgentMailReplayEvent,
): event is MockAgentMailDeliveryFailure {
  return event.kind === 'bounce' || event.kind === 'complaint';
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function splitInboxId(inboxId: string): { username: string; domain: string } {
  const separator = inboxId.indexOf('@');

  if (separator <= 0) {
    return { username: inboxId, domain: AGENTMAIL_DEFAULT_DOMAIN };
  }

  return {
    username: inboxId.slice(0, separator),
    domain: inboxId.slice(separator + 1),
  };
}

function mintWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

/**
 * Sign a delivery exactly the way Svix does, so the production verifier
 * (the `svix` npm package) accepts mock deliveries: HMAC-SHA256 over
 * `${svixId}.${timestamp}.${rawBody}` keyed with the base64-decoded portion
 * of the secret after the `whsec_` prefix.
 */
export function signSvixPayload({
  secret,
  svixId,
  timestamp,
  payload,
}: {
  secret: string;
  svixId: string;
  timestamp: string;
  payload: string;
}): string {
  const encodedKey = secret.startsWith('whsec_')
    ? secret.slice('whsec_'.length)
    : secret;

  const signature = createHmac('sha256', Buffer.from(encodedKey, 'base64'))
    .update(`${svixId}.${timestamp}.${payload}`)
    .digest('base64');

  return `v1,${signature}`;
}

function normalizeState(state: MockAgentMailState): MockAgentMailState {
  return {
    ...cloneState(state),
    // Seeded scenarios may omit derivable fields; fill them in here.
    pods: (state.pods ?? []).map((pod) => ({
      ...pod,
      created_at: pod.created_at ?? new Date(0).toISOString(),
    })),
    inboxes: state.inboxes.map((inbox) => ({
      ...splitInboxId(inbox.inbox_id),
      ...inbox,
      created_at: inbox.created_at ?? new Date(0).toISOString(),
    })),
    webhooks: (state.webhooks ?? []).map((webhook) => ({
      ...webhook,
      secret: webhook.secret || mintWebhookSecret(),
      enabled: webhook.enabled ?? true,
      created_at: webhook.created_at ?? new Date(0).toISOString(),
    })),
    messages: (state.messages ?? []).map((message) => ({ ...message })),
    // Seeded events may omit the delivery log; a redelivery appends to it.
    events: (state.events ?? []).map((event) => ({
      ...event,
      deliveries: event.deliveries ?? [],
    })),
  };
}

/**
 * Scope filter for management routes: a pod (`/v0/pods/{pod}/...`), an inbox
 * (`/v0/inboxes/{inbox}/webhooks...`), or null for the organization level.
 */
type PodScope = { podId: string } | { inboxId: string } | null;

function inboxInScope(inbox: MockAgentMailInbox, scope: PodScope): boolean {
  return scope && 'podId' in scope ? inbox.pod_id === scope.podId : true;
}

function webhookInScope(
  webhook: MockAgentMailWebhook,
  scope: PodScope,
): boolean {
  if (!scope) return true;
  return 'podId' in scope
    ? Boolean(webhook.pod_ids?.includes(scope.podId))
    : Boolean(webhook.inbox_ids?.includes(scope.inboxId));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end(body);
}

function apiError(response: ServerResponse, status: number, message: string) {
  json(response, status, { message });
}

export class MockAgentMailServer {
  private server: Server | null = null;
  private state: MockAgentMailState;
  private port: number | null = null;
  // Seed from the clock so minted ids never repeat across harness runs —
  // consumers may dedupe messages and svix deliveries by id.
  private idSequence = Math.floor(Date.now() / 1000);
  /** Idempotency-Key header → prior send/reply result, per endpoint. */
  private idempotencyResults = new Map<
    string,
    { message_id: string; thread_id: string }
  >();

  constructor({ state }: { state: MockAgentMailState }) {
    this.state = normalizeState(state);
  }

  public get baseUrl(): string {
    if (this.port === null) {
      throw new Error('Mock AgentMail server is not running.');
    }

    return `http://127.0.0.1:${this.port}`;
  }

  public getState(): MockAgentMailState {
    return cloneState(this.state);
  }

  public setState(state: MockAgentMailState): void {
    this.state = normalizeState(state);
    this.idempotencyResults.clear();
  }

  public async start(port = 0): Promise<string> {
    if (this.server) {
      return this.baseUrl;
    }

    this.server = createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response);
      } catch (error) {
        text(
          response,
          500,
          error instanceof Error
            ? error.message
            : 'Unknown mock AgentMail error',
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, '127.0.0.1', () => {
        this.server?.off('error', reject);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve mock AgentMail server address.');
    }

    this.port = (address as AddressInfo).port;
    return this.baseUrl;
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    this.port = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private nextId(prefix: string): string {
    this.idSequence += 1;
    return `${prefix}_${this.idSequence}`;
  }

  /**
   * Store an inbound email and deliver the signed `message.received` webhook
   * to every matching registration. `duplicate` and `kind: 'redeliver'`
   * resend a past event's payload verbatim with its original svix-id.
   */
  public async dispatch(
    event: MockAgentMailReplayEvent,
  ): Promise<MockAgentMailDispatchResult> {
    if (event.kind === 'redeliver') {
      const stored = (this.state.events ?? []).find(
        (entry) => entry.event_id === event.eventId,
      );

      if (!stored) {
        throw new Error(`Unknown eventId for redelivery: ${event.eventId}`);
      }

      return this.redeliver(stored);
    }

    if (isMockDeliveryFailure(event)) {
      return this.dispatchDeliveryFailure(event);
    }

    if (event.duplicate) {
      const previous = (this.state.events ?? []).at(-1);

      if (!previous) {
        throw new Error('No previous event to redeliver as a duplicate.');
      }

      return this.redeliver(previous);
    }

    const inbox = this.findInbox(event.inboxId);

    if (!inbox) {
      throw new Error(`Unknown inboxId: ${event.inboxId}`);
    }

    const message = this.storeInboundMessage(inbox, event);
    const payload = this.buildMessageReceivedPayload(message, {
      oversize: event.oversize === true,
    });

    const stored: MockAgentMailDeliveredEvent = {
      event_id: String(payload.event_id),
      svix_id: this.nextId('svix'),
      event_type: AGENTMAIL_MESSAGE_RECEIVED_EVENT,
      inbox_id: message.inbox_id,
      message_id: message.message_id,
      payload: JSON.stringify(payload),
      deliveries: [],
    };
    this.state.events = [...(this.state.events ?? []), stored];

    return this.redeliver(stored);
  }

  private async dispatchDeliveryFailure(
    event: MockAgentMailDeliveryFailure,
  ): Promise<MockAgentMailDispatchResult> {
    const inbox = this.findInbox(event.inboxId);

    if (!inbox) {
      throw new Error(`Unknown inboxId: ${event.inboxId}`);
    }

    const bounce = event.kind === 'bounce';
    const eventId = this.nextId('evt');
    const messageId = event.messageId ?? `<${this.nextId('msg')}@mock>`;
    const threadId = event.threadId ?? this.nextId('thread');
    const failure = {
      inbox_id: inbox.inbox_id,
      thread_id: threadId,
      message_id: messageId,
      timestamp: new Date().toISOString(),
      type: bounce ? (event.bounceType ?? 'Permanent') : 'abuse',
      sub_type: event.subType ?? (bounce ? 'General' : 'spam'),
      // Real payload shapes differ: bounce recipients are objects,
      // complaint recipients are bare strings.
      recipients: bounce
        ? event.recipients.map((address) => ({ address, status: 'bounced' }))
        : event.recipients,
    };
    const payload = {
      type: 'event',
      event_type: bounce ? 'message.bounced' : 'message.complained',
      event_id: eventId,
      ...(bounce ? { bounce: failure } : { complaint: failure }),
    };

    const stored: MockAgentMailDeliveredEvent = {
      event_id: eventId,
      svix_id: this.nextId('svix'),
      event_type: String(payload.event_type),
      inbox_id: inbox.inbox_id,
      message_id: messageId,
      payload: JSON.stringify(payload),
      deliveries: [],
    };
    this.state.events = [...(this.state.events ?? []), stored];

    return this.redeliver(stored);
  }

  /**
   * Deliver an event's raw payload with its original svix-id. Timestamp and
   * signature are computed fresh per delivery, matching real Svix retries.
   */
  private async redeliver(
    event: MockAgentMailDeliveredEvent,
  ): Promise<MockAgentMailDispatchResult> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const deliveries: MockAgentMailWebhookDelivery[] = [];

    for (const webhook of this.state.webhooks ?? []) {
      if (!this.webhookMatches(webhook, event)) {
        continue;
      }

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'svix-id': event.svix_id,
          'svix-timestamp': timestamp,
          'svix-signature': signSvixPayload({
            secret: webhook.secret,
            svixId: event.svix_id,
            timestamp,
            payload: event.payload,
          }),
        },
        body: event.payload,
      });

      deliveries.push({
        webhook_id: webhook.webhook_id,
        url: webhook.url,
        status: response.status,
        body: await response.text(),
      });
    }

    event.deliveries = [...event.deliveries, ...deliveries];

    const parsed = JSON.parse(event.payload) as {
      message?: { thread_id: string };
      bounce?: { thread_id?: string };
      complaint?: { thread_id?: string };
    };

    return {
      eventId: event.event_id,
      svixId: event.svix_id,
      messageId: event.message_id,
      threadId:
        parsed.message?.thread_id ??
        parsed.bounce?.thread_id ??
        parsed.complaint?.thread_id ??
        '',
      deliveries,
    };
  }

  private webhookMatches(
    webhook: MockAgentMailWebhook,
    event: MockAgentMailDeliveredEvent,
  ): boolean {
    if (!webhook.enabled) {
      return false;
    }

    if (
      webhook.inbox_ids?.length &&
      !webhook.inbox_ids.includes(event.inbox_id)
    ) {
      return false;
    }

    if (webhook.pod_ids?.length) {
      const podId = this.findInbox(event.inbox_id)?.pod_id;
      if (!podId || !webhook.pod_ids.includes(podId)) {
        return false;
      }
    }

    if (
      webhook.event_types?.length &&
      !webhook.event_types.includes(event.event_type)
    ) {
      return false;
    }

    return true;
  }

  private storeInboundMessage(
    inbox: MockAgentMailInbox,
    email: MockAgentMailInboundEmail,
  ): MockAgentMailStoredMessage {
    const threadId = email.threadId ?? this.nextId('thread');
    const threadMessages = (this.state.messages ?? []).filter(
      (entry) => entry.thread_id === threadId,
    );
    const previous = threadMessages.at(-1);

    const stored: MockAgentMailStoredMessage = {
      message_id: this.nextId('msg'),
      thread_id: threadId,
      inbox_id: inbox.inbox_id,
      direction: 'inbound',
      from: email.from,
      to: email.to ?? [inbox.inbox_id],
      ...(email.cc ? { cc: email.cc } : {}),
      ...(email.subject !== undefined ? { subject: email.subject } : {}),
      ...(email.text !== undefined ? { text: email.text } : {}),
      ...(email.html !== undefined ? { html: email.html } : {}),
      timestamp: email.timestamp ?? new Date().toISOString(),
      ...(previous
        ? {
            in_reply_to: previous.message_id,
            references: [...(previous.references ?? []), previous.message_id],
          }
        : {}),
      ...(email.autoSubmitted
        ? { headers: { 'auto-submitted': 'auto-generated' } }
        : {}),
    };

    this.state.messages = [...(this.state.messages ?? []), stored];
    return stored;
  }

  private buildMessageReceivedPayload(
    message: MockAgentMailStoredMessage,
    { oversize }: { oversize: boolean },
  ): JsonRecord {
    const threadMessages = (this.state.messages ?? []).filter(
      (entry) => entry.thread_id === message.thread_id,
    );

    return {
      type: 'event',
      event_type: AGENTMAIL_MESSAGE_RECEIVED_EVENT,
      event_id: this.nextId('evt'),
      message: {
        message_id: message.message_id,
        thread_id: message.thread_id,
        inbox_id: message.inbox_id,
        from: message.from,
        to: message.to,
        cc: message.cc ?? [],
        ...(message.subject !== undefined ? { subject: message.subject } : {}),
        // The real pipeline drops text/html when the payload would exceed
        // the 1MB cap; consumers must re-fetch the message by id.
        ...(oversize
          ? {}
          : {
              ...(message.text !== undefined
                ? { text: message.text, extracted_text: message.text }
                : {}),
              ...(message.html !== undefined ? { html: message.html } : {}),
            }),
        timestamp: message.timestamp,
        ...(message.in_reply_to !== undefined
          ? { in_reply_to: message.in_reply_to }
          : {}),
        ...(message.references !== undefined
          ? { references: message.references }
          : {}),
        ...(message.headers !== undefined ? { headers: message.headers } : {}),
        attachments: [],
      },
      thread: {
        thread_id: message.thread_id,
        last_message_id:
          threadMessages.at(-1)?.message_id ?? message.message_id,
        message_count: threadMessages.length,
      },
    };
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl);

    if (url.pathname.startsWith('/mock/')) {
      await this.handleControlRequest(request, response, url);
      return;
    }

    if (!url.pathname.startsWith('/v0/')) {
      text(response, 404, 'Not Found');
      return;
    }

    if (!this.isAuthorized(request)) {
      apiError(response, 401, 'Unauthorized');
      return;
    }

    await this.handleApiRequest(request, response, url);
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? '';

    if (!header.startsWith('Bearer ')) {
      return false;
    }

    const apiKey = header.slice('Bearer '.length).trim();

    if (!apiKey) {
      return false;
    }

    const acceptedApiKeys = this.state.acceptedApiKeys;

    if (!acceptedApiKeys?.length) {
      return true;
    }

    return acceptedApiKeys.includes(apiKey);
  }

  private async handleControlRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method === 'GET' && url.pathname === '/mock/state') {
      json(response, 200, this.getState() as unknown as JsonRecord);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/mock/state') {
      const body = JSON.parse(
        await readRequestBody(request),
      ) as MockAgentMailState;
      this.setState(body);
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/mock/events') {
      const body = JSON.parse(
        await readRequestBody(request),
      ) as MockAgentMailReplayEvent;
      const dispatchResult = await this.dispatch(body);
      json(response, 200, {
        ok: true,
        dispatchResult,
      });
      return;
    }

    text(response, 404, 'Not Found');
  }

  private async handleApiRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    const method = request.method ?? 'GET';
    const bodyText = method === 'GET' ? '' : await readRequestBody(request);
    const body: JsonRecord = bodyText
      ? (JSON.parse(bodyText) as JsonRecord)
      : {};

    // segments[0] is 'v0'. Pod-scoped management paths
    // (`/v0/pods/{pod}/inboxes...`, `/v0/pods/{pod}/webhooks...`) reuse the
    // organization-level handlers with the pod as a filter, mirroring how the
    // real API exposes the same resources under both prefixes.
    let scope: PodScope = null;
    let resource = segments.slice(1);

    if (segments[1] === 'pods') {
      if (segments.length === 2) {
        if (method === 'GET') {
          json(response, 200, { pods: this.state.pods ?? [] });
          return;
        }

        if (method === 'POST') {
          this.handleCreatePod(response, body);
          return;
        }
      }

      const pod = (this.state.pods ?? []).find(
        (entry) => entry.pod_id === segments[2],
      );

      if (!pod) {
        apiError(response, 404, 'Pod not found');
        return;
      }

      if (segments.length === 3 && method === 'GET') {
        json(response, 200, pod);
        return;
      }

      scope = { podId: pod.pod_id };
      resource = segments.slice(3);
    }

    if (resource[0] === 'inboxes') {
      if (resource.length === 1) {
        if (method === 'GET') {
          json(response, 200, {
            inboxes: this.state.inboxes.filter((inbox) =>
              inboxInScope(inbox, scope),
            ),
          });
          return;
        }

        if (method === 'POST') {
          this.handleCreateInbox(response, body, scope);
          return;
        }
      }

      const found = this.findInbox(resource[1] ?? '');
      const inbox = found && inboxInScope(found, scope) ? found : undefined;

      if (resource.length === 2) {
        if (!inbox) {
          apiError(response, 404, 'Inbox not found');
          return;
        }

        if (method === 'GET') {
          json(response, 200, inbox);
          return;
        }

        if (method === 'PATCH') {
          if (typeof body.display_name === 'string') {
            inbox.display_name = body.display_name;
          }
          json(response, 200, inbox);
          return;
        }
      }

      if (resource[2] === 'webhooks') {
        if (!inbox) {
          apiError(response, 404, 'Inbox not found');
          return;
        }
        if (
          this.handleWebhookRoutes(
            resource.slice(2),
            { inboxId: inbox.inbox_id },
            method,
            body,
            response,
          )
        ) {
          return;
        }
      }

      if (resource[2] === 'messages') {
        if (!inbox) {
          apiError(response, 404, 'Inbox not found');
          return;
        }

        if (
          resource.length === 4 &&
          resource[3] === 'send' &&
          method === 'POST'
        ) {
          this.handleSendMessage(request, response, inbox, body);
          return;
        }

        const message = (this.state.messages ?? []).find(
          (entry) =>
            entry.inbox_id === inbox.inbox_id &&
            entry.message_id === resource[3],
        );

        if (resource.length === 4 && method === 'GET') {
          if (!message) {
            apiError(response, 404, 'Message not found');
            return;
          }

          json(response, 200, message);
          return;
        }

        if (
          resource.length === 5 &&
          resource[4] === 'reply' &&
          method === 'POST'
        ) {
          if (!message) {
            apiError(response, 404, 'Message not found');
            return;
          }

          this.handleReplyToMessage(request, response, inbox, message, body);
          return;
        }
      }
    }

    if (
      resource[0] === 'webhooks' &&
      this.handleWebhookRoutes(resource, scope, method, body, response)
    ) {
      return;
    }

    apiError(
      response,
      404,
      `Not Found: unhandled mock AgentMail route "${method} ${url.pathname}"`,
    );
  }

  /**
   * Webhook CRUD shared by the organization, pod, and inbox prefixes; the
   * scope decides which registrations are visible and how a new one is
   * scoped. Returns false when the route is not a webhook route.
   */
  private handleWebhookRoutes(
    resource: string[],
    scope: PodScope,
    method: string,
    body: JsonRecord,
    response: ServerResponse,
  ): boolean {
    if (resource.length === 1) {
      if (method === 'GET') {
        json(response, 200, {
          webhooks: (this.state.webhooks ?? []).filter((webhook) =>
            webhookInScope(webhook, scope),
          ),
        });
        return true;
      }

      if (method === 'POST') {
        this.handleCreateWebhook(response, body, scope);
        return true;
      }
    }

    if (resource.length === 2) {
      const webhook = (this.state.webhooks ?? []).find(
        (entry) =>
          entry.webhook_id === resource[1] && webhookInScope(entry, scope),
      );

      if (!webhook) {
        apiError(response, 404, 'Webhook not found');
        return true;
      }

      if (method === 'GET') {
        json(response, 200, webhook);
        return true;
      }

      if (method === 'PATCH') {
        // Real AgentMail semantics: the URL is immutable, inbox and pod
        // scope change through add/remove lists, and a non-empty
        // event_types list replaces the subscription in full.
        // An inbox-scoped webhook is fixed to its inbox: only event types
        // can change there.
        const inboxScoped = Boolean(scope && 'inboxId' in scope);
        const addInboxIds = inboxScoped ? [] : stringList(body.add_inbox_ids);
        const removeInboxIds = inboxScoped
          ? []
          : stringList(body.remove_inbox_ids);
        if (addInboxIds.length || removeInboxIds.length) {
          webhook.inbox_ids = [
            ...new Set([
              ...(webhook.inbox_ids ?? []).filter(
                (id) => !removeInboxIds.includes(id),
              ),
              ...addInboxIds,
            ]),
          ];
        }
        if (!scope) {
          const addPodIds = stringList(body.add_pod_ids);
          const removePodIds = stringList(body.remove_pod_ids);
          if (addPodIds.length || removePodIds.length) {
            webhook.pod_ids = [
              ...new Set([
                ...(webhook.pod_ids ?? []).filter(
                  (id) => !removePodIds.includes(id),
                ),
                ...addPodIds,
              ]),
            ];
          }
        }
        const eventTypes = stringList(body.event_types);
        if (eventTypes.length) {
          webhook.event_types = eventTypes;
        }
        json(response, 200, webhook);
        return true;
      }

      if (method === 'DELETE') {
        this.state.webhooks = (this.state.webhooks ?? []).filter(
          (entry) => entry !== webhook,
        );
        json(response, 200, { ok: true });
        return true;
      }
    }
    return false;
  }

  private handleCreatePod(response: ServerResponse, body: JsonRecord): void {
    const clientId =
      typeof body.client_id === 'string' ? body.client_id : undefined;

    if (clientId) {
      const existing = (this.state.pods ?? []).find(
        (entry) => entry.client_id === clientId,
      );

      if (existing) {
        json(response, 200, existing);
        return;
      }
    }

    const pod: MockAgentMailPod = {
      pod_id: this.nextId('pod'),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(clientId ? { client_id: clientId } : {}),
      created_at: new Date().toISOString(),
    };

    this.state.pods = [...(this.state.pods ?? []), pod];
    json(response, 200, pod);
  }

  private handleCreateInbox(
    response: ServerResponse,
    body: JsonRecord,
    scope: PodScope,
  ): void {
    const clientId =
      typeof body.client_id === 'string' ? body.client_id : undefined;

    if (clientId) {
      const existing = this.state.inboxes.find(
        (entry) => entry.client_id === clientId && inboxInScope(entry, scope),
      );

      if (existing) {
        json(response, 200, existing);
        return;
      }
    }

    const username =
      typeof body.username === 'string' && body.username
        ? body.username
        : this.nextId('inbox');
    const domain =
      typeof body.domain === 'string' && body.domain
        ? body.domain
        : AGENTMAIL_DEFAULT_DOMAIN;
    const inboxId = `${username}@${domain}`;

    if (this.findInbox(inboxId)) {
      apiError(response, 409, 'Inbox already exists');
      return;
    }

    const inbox: MockAgentMailInbox = {
      inbox_id: inboxId,
      username,
      domain,
      ...(typeof body.display_name === 'string'
        ? { display_name: body.display_name }
        : {}),
      ...(clientId ? { client_id: clientId } : {}),
      ...(scope && 'podId' in scope ? { pod_id: scope.podId } : {}),
      created_at: new Date().toISOString(),
    };

    this.state.inboxes = [...this.state.inboxes, inbox];
    json(response, 200, inbox);
  }

  private handleCreateWebhook(
    response: ServerResponse,
    body: JsonRecord,
    scope: PodScope,
  ): void {
    const webhookUrl = typeof body.url === 'string' ? body.url : '';

    if (!webhookUrl) {
      apiError(response, 400, 'url is required');
      return;
    }

    const clientId =
      typeof body.client_id === 'string' ? body.client_id : undefined;

    if (clientId) {
      const existing = (this.state.webhooks ?? []).find(
        (entry) => entry.client_id === clientId && webhookInScope(entry, scope),
      );

      if (existing) {
        json(response, 200, existing);
        return;
      }
    }

    // The path fixes the scope: a pod webhook is pinned to its pod (and may
    // narrow to inboxes), an inbox webhook is pinned to its inbox, and an
    // organization-level create may name either explicitly.
    const inboxIds =
      scope && 'inboxId' in scope
        ? [scope.inboxId]
        : stringList(body.inbox_ids);
    const podIds =
      scope && 'podId' in scope
        ? [scope.podId]
        : scope
          ? []
          : stringList(body.pod_ids);
    const eventTypes = stringList(body.event_types);
    const webhook: MockAgentMailWebhook = {
      webhook_id: this.nextId('wh'),
      url: webhookUrl,
      secret: mintWebhookSecret(),
      ...(clientId ? { client_id: clientId } : {}),
      ...(inboxIds.length ? { inbox_ids: inboxIds } : {}),
      ...(podIds.length ? { pod_ids: podIds } : {}),
      ...(eventTypes.length ? { event_types: eventTypes } : {}),
      enabled: true,
      created_at: new Date().toISOString(),
    };

    this.state.webhooks = [...(this.state.webhooks ?? []), webhook];
    json(response, 200, webhook);
  }

  private handleSendMessage(
    request: IncomingMessage,
    response: ServerResponse,
    inbox: MockAgentMailInbox,
    body: JsonRecord,
  ): void {
    this.handleOutboundMessage(request, response, inbox, body, undefined);
  }

  private handleReplyToMessage(
    request: IncomingMessage,
    response: ServerResponse,
    inbox: MockAgentMailInbox,
    target: MockAgentMailStoredMessage,
    body: JsonRecord,
  ): void {
    this.handleOutboundMessage(request, response, inbox, body, target);
  }

  /**
   * Shared send/reply path. Honors the `Idempotency-Key` header: repeating a
   * key returns the original `{message_id, thread_id}` without storing a
   * second message, matching real AgentMail retry semantics.
   */
  private handleOutboundMessage(
    request: IncomingMessage,
    response: ServerResponse,
    inbox: MockAgentMailInbox,
    body: JsonRecord,
    replyTarget: MockAgentMailStoredMessage | undefined,
  ): void {
    const idempotencyKey = request.headers['idempotency-key'];
    // Mirror the real API's charset restriction so parity bugs surface in
    // tests instead of production (validation_error, path headers/Idempotency-Key).
    if (
      typeof idempotencyKey === 'string' &&
      idempotencyKey &&
      !/^[A-Za-z0-9\-._~]+$/.test(idempotencyKey)
    ) {
      json(response, 400, {
        name: 'ValidationError',
        code: 'validation_error',
        message: 'Request validation failed',
        errors: [
          {
            code: 'invalid_format',
            format: 'custom',
            path: ['headers', 'Idempotency-Key'],
            message:
              'Idempotency-Key must contain only the following characters: A-Z a-z 0-9 - . _ ~',
          },
        ],
      });
      return;
    }
    const idempotencyMapKey =
      typeof idempotencyKey === 'string' && idempotencyKey
        ? [
            inbox.inbox_id,
            replyTarget ? `reply:${replyTarget.message_id}` : 'send',
            idempotencyKey,
          ].join(':')
        : undefined;

    if (idempotencyMapKey) {
      const previous = this.idempotencyResults.get(idempotencyMapKey);

      if (previous) {
        json(response, 200, previous);
        return;
      }
    }

    const to = Array.isArray(body.to)
      ? body.to.map(String)
      : typeof body.to === 'string'
        ? [body.to]
        : replyTarget
          ? [replyTarget.from]
          : [];

    if (to.length === 0) {
      apiError(response, 400, 'to is required');
      return;
    }

    const cc = Array.isArray(body.cc) ? body.cc.map(String) : undefined;

    const stored: MockAgentMailStoredMessage = {
      message_id: this.nextId('msg'),
      thread_id: replyTarget?.thread_id ?? this.nextId('thread'),
      inbox_id: inbox.inbox_id,
      direction: 'outbound',
      from: inbox.inbox_id,
      to,
      ...(cc ? { cc } : {}),
      ...(typeof body.subject === 'string'
        ? { subject: body.subject }
        : replyTarget?.subject !== undefined
          ? { subject: `Re: ${replyTarget.subject}` }
          : {}),
      ...(typeof body.text === 'string' ? { text: body.text } : {}),
      ...(typeof body.html === 'string' ? { html: body.html } : {}),
      timestamp: new Date().toISOString(),
      ...(replyTarget
        ? {
            in_reply_to: replyTarget.message_id,
            references: [
              ...(replyTarget.references ?? []),
              replyTarget.message_id,
            ],
          }
        : {}),
    };

    this.state.messages = [...(this.state.messages ?? []), stored];

    const result = {
      message_id: stored.message_id,
      thread_id: stored.thread_id,
    };

    if (idempotencyMapKey) {
      this.idempotencyResults.set(idempotencyMapKey, result);
    }

    json(response, 200, result);
  }

  private findInbox(inboxId: string): MockAgentMailInbox | undefined {
    return this.state.inboxes.find((entry) => entry.inbox_id === inboxId);
  }
}
