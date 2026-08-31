import { z } from 'zod';

/**
 * AgentMail webhook payload schemas (https://docs.agentmail.to). Every object
 * uses `.passthrough()` so unknown fields survive parsing — the pipeline
 * stores raw events and later readers may need fields we do not model yet.
 */

export const agentMailAddressSchema = z.union([
  z.string(),
  z
    .object({
      address: z.string().optional(),
      email: z.string().optional(),
      name: z.string().optional(),
    })
    .passthrough(),
]);

export const agentMailAttachmentSchema = z
  .object({
    attachment_id: z.string(),
    filename: z.string().optional(),
    content_type: z.string().optional(),
    size: z.number().optional(),
  })
  .passthrough();

export const agentMailMessageSchema = z
  .object({
    message_id: z.string(),
    thread_id: z.string(),
    inbox_id: z.string(),
    organization_id: z.string().optional(),
    from: z.union([agentMailAddressSchema, z.array(agentMailAddressSchema)]),
    to: z.array(agentMailAddressSchema).optional(),
    cc: z.array(agentMailAddressSchema).optional(),
    bcc: z.array(agentMailAddressSchema).optional(),
    subject: z.string().optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    extracted_text: z.string().optional(),
    extracted_html: z.string().optional(),
    /** Provider timestamp (ISO string) used for message ordering. */
    timestamp: z.string(),
    in_reply_to: z.string().optional(),
    references: z.array(z.string()).optional(),
    labels: z.array(z.string()).optional(),
    attachments: z.array(agentMailAttachmentSchema).optional(),
  })
  .passthrough();

export const agentMailThreadSummarySchema = z
  .object({
    thread_id: z.string(),
    last_message_id: z.string().optional(),
    message_count: z.number().optional(),
  })
  .passthrough();

export const agentMailWebhookEventSchema = z
  .object({
    type: z.literal('event').optional(),
    event_type: z.string(),
    event_id: z.string().optional(),
    message: agentMailMessageSchema.optional(),
    thread: agentMailThreadSummarySchema.optional(),
  })
  .passthrough();

export type AgentMailAddress = z.infer<typeof agentMailAddressSchema>;
export type AgentMailAttachment = z.infer<typeof agentMailAttachmentSchema>;
export type AgentMailMessage = z.infer<typeof agentMailMessageSchema>;
export type AgentMailThreadSummary = z.infer<
  typeof agentMailThreadSummarySchema
>;
export type AgentMailWebhookEvent = z.infer<typeof agentMailWebhookEventSchema>;

export function parseAgentMailWebhookEvent(
  value: unknown,
): AgentMailWebhookEvent | null {
  const parsed = agentMailWebhookEventSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

export function isAgentMailMessageReceivedEvent(
  event: AgentMailWebhookEvent,
): boolean {
  return event.event_type === 'message.received';
}

/**
 * Crude tag stripper for the HTML fallback body. Real sanitization happens
 * later in the pipeline — this only recovers readable text for routing.
 */
function stripElementWithContent(html: string, tagName: string): string {
  // Linear scan instead of a backtracking regex (CodeQL js/polynomial-redos,
  // js/bad-tag-filter): find each opening tag, then the matching close tag
  // allowing whitespace before '>', and cut the whole block.
  const lower = html.toLowerCase();
  const openToken = `<${tagName}`;
  let result = '';
  let cursor = 0;

  for (;;) {
    const openAt = lower.indexOf(openToken, cursor);
    if (openAt === -1) {
      result += html.slice(cursor);
      return result;
    }
    // Replace the removed block with a space so neighboring text does not
    // merge ("Please<script>x</script>review" must not become
    // "Pleasereview"); later whitespace normalization collapses it.
    result += `${html.slice(cursor, openAt)} `;

    const closePattern = `</${tagName}`;
    const closeAt = lower.indexOf(closePattern, openAt);
    if (closeAt === -1) {
      // Unterminated block: drop the rest, matching sanitizer behavior.
      return result;
    }
    const closeEnd = lower.indexOf('>', closeAt);
    if (closeEnd === -1) {
      return result;
    }
    cursor = closeEnd + 1;
  }
}

function stripHtmlTags(html: string): string {
  return stripElementWithContent(
    stripElementWithContent(html, 'script'),
    'style',
  )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|blockquote|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Prefer the provider's extracted plain text, then raw text, then HTML. */
export function getAgentMailMessageBodyText(message: AgentMailMessage): string {
  const extractedText = message.extracted_text?.trim();

  if (extractedText) {
    return extractedText;
  }

  const text = message.text?.trim();

  if (text) {
    return text;
  }

  const html = message.extracted_html ?? message.html;

  return html ? stripHtmlTags(html).trim() : '';
}

function readAddressString(address: AgentMailAddress): string | undefined {
  if (typeof address === 'string') {
    return address;
  }

  return address.address ?? address.email;
}

/**
 * Normalize the `from` field — a bare address, a `Name <a@b.c>` display
 * string, an address object, or an array of any of those — to a lowercased
 * bare email address.
 */
export function getAgentMailSenderAddress(
  message: AgentMailMessage,
): string | null {
  const from = Array.isArray(message.from) ? message.from[0] : message.from;

  if (from === undefined) {
    return null;
  }

  return normalizeAgentMailAddress(from);
}

/**
 * Normalize one address value — a bare address, a `Name <a@b.c>` display
 * string, or an address object — to a lowercased bare email address.
 */
export function normalizeAgentMailAddress(
  value: AgentMailAddress,
): string | null {
  const raw = readAddressString(value)?.trim();

  if (!raw) {
    return null;
  }

  const angleMatch = /<([^<>]+)>/.exec(raw);
  const candidate = (angleMatch?.[1] ?? raw).trim().toLowerCase();

  return candidate.includes('@') ? candidate : null;
}

function readHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lowered = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered && typeof value === 'string') {
      return value;
    }
  }

  return undefined;
}

/**
 * Loop protection: detect auto-generated mail (vacation responders, bounce
 * notices, list traffic) so the pipeline never auto-replies to it. The
 * webhook payload may carry raw headers in a passthrough `headers` field —
 * check defensively since the shape is not guaranteed.
 */
export function isAgentMailAutoGeneratedMessage(
  message: AgentMailMessage,
): boolean {
  const headersValue = (message as Record<string, unknown>).headers;
  const headers =
    headersValue &&
    typeof headersValue === 'object' &&
    !Array.isArray(headersValue)
      ? (headersValue as Record<string, string>)
      : {};

  const autoSubmitted = readHeader(headers, 'Auto-Submitted')
    ?.trim()
    .toLowerCase();

  if (autoSubmitted && autoSubmitted !== 'no') {
    return true;
  }

  const precedence = readHeader(headers, 'Precedence')?.trim().toLowerCase();

  if (precedence && ['bulk', 'list', 'junk'].includes(precedence)) {
    return true;
  }

  const labels = (message.labels ?? []).map((label) => label.toLowerCase());

  return labels.includes('auto-generated') || labels.includes('auto-submitted');
}
