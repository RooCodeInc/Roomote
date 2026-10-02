import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import sharp from 'sharp';
import { z } from 'zod';
import { Env } from '@roomote/env';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../types';
import { logHandlerError } from '../utils';

const MAX_CRITIQUE_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_CRITIQUE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_SCREENSHOT_PIXELS = 40_000_000;
const MAX_DOM_BYTES = 5 * 1024 * 1024;
const MAX_DOM_NODES = 20_000;
const CRITIQUE_TIMEOUT_MS = 160_000;
const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,126}[A-Za-z0-9])?$/;

const SAFE_ATTRIBUTES = new Set([
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-hidden',
  'aria-expanded',
  'aria-pressed',
  'aria-selected',
  'alt',
  'title',
  'type',
]);
const SAFE_STYLES = new Set([
  'display',
  'position',
  'visibility',
  'opacity',
  'overflow',
  'z-index',
  'white-space',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant-numeric',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-align',
  'vertical-align',
  'color',
  'background-color',
  'background-image',
  'box-shadow',
  'border-top-width',
  'border-top-color',
  'border-right-width',
  'border-right-color',
  'border-bottom-width',
  'border-bottom-color',
  'border-left-width',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'flex-direction',
  'align-items',
  'justify-content',
  'gap',
  'row-gap',
  'column-gap',
]);

const finiteNumber = z.number().finite();
const sizeSchema = z
  .object({
    width: finiteNumber.nonnegative(),
    height: finiteNumber.nonnegative(),
  })
  .strict();
const viewportSchema = sizeSchema
  .extend({
    deviceScaleFactor: finiteNumber.positive(),
    scrollX: finiteNumber,
    scrollY: finiteNumber,
  })
  .strict();
const captureSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    screenshotAssetId: z.string().regex(ID_PATTERN),
    domAssetId: z.string().regex(ID_PATTERN),
    viewport: viewportSchema,
    document: sizeSchema,
    page: z
      .object({
        url: z.string().url().optional(),
        title: z.string().max(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const rulesSchema = z
  .object({
    rulePackIds: z.array(z.string().regex(ID_PATTERN)).max(100).optional(),
    include: z.array(z.string().regex(ID_PATTERN)).max(100).optional(),
    exclude: z.array(z.string().regex(ID_PATTERN)).max(100).optional(),
  })
  .strict();
const optionsSchema = z
  .object({
    minimumConfidence: z.number().min(0).max(1).optional(),
    maximumFindings: z.number().int().positive().max(1_000).optional(),
  })
  .strict();
const contextSchema = z
  .object({
    task: z.string().max(4_000).optional(),
    designIntent: z.string().max(4_000).optional(),
  })
  .strict();
const manifestSchema = z
  .object({
    mode: z.enum(['page', 'comparison']),
    captures: z.array(captureSchema).min(1).max(4),
    comparison: z
      .object({
        baselineCaptureId: z.string().regex(ID_PATTERN),
        candidateCaptureId: z.string().regex(ID_PATTERN),
      })
      .strict()
      .optional(),
    rules: rulesSchema.optional(),
    options: optionsSchema.optional(),
    context: contextSchema.optional(),
  })
  .strict();

const boundsSchema = z
  .object({
    x: finiteNumber,
    y: finiteNumber,
    width: finiteNumber.nonnegative(),
    height: finiteNumber.nonnegative(),
  })
  .strict();
const domNodeSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    parentId: z.string().regex(ID_PATTERN).optional(),
    tagName: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    text: z.string().max(512).optional(),
    attributes: z.record(z.string().max(256)).optional(),
    bounds: boundsSchema,
    styles: z.record(z.string().max(512)),
    state: z.object({ visible: z.boolean() }).strict(),
  })
  .strict();
const domSchema = z
  .object({
    rootNodeId: z.string().regex(ID_PATTERN),
    nodes: z.array(domNodeSchema).min(1).max(MAX_DOM_NODES),
  })
  .strict();

type CritiqueManifest = z.infer<typeof manifestSchema>;
type CritiqueCapture = z.infer<typeof captureSchema>;
type DomNode = z.infer<typeof domNodeSchema>;

class RequestBodyTooLargeError extends Error {}
class InvalidCritiqueInputError extends Error {}

function isRunTokenContext(
  auth: Variables['authContext'],
): auth is RunTokenContext {
  return Boolean(auth && 'runId' in auth);
}

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function containsSensitiveValue(value: string): boolean {
  return (
    /\b(?:bearer|authorization|api[-_ ]?key|password|secret|token)\b/i.test(
      value,
    ) ||
    /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/.test(value) ||
    /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/i.test(value) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
    /\b[A-Za-z0-9_-]{40,}\b/.test(value)
  );
}

function sanitizeText(
  value: string | undefined,
  maximum: number,
): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed || containsSensitiveValue(trimmed)) return undefined;
  return trimmed.slice(0, maximum);
}

function sanitizeManifest(manifest: CritiqueManifest): CritiqueManifest {
  const captureIds = new Set(manifest.captures.map((capture) => capture.id));
  const assetIds = new Set<string>();
  for (const capture of manifest.captures) {
    if (
      capture.screenshotAssetId === 'input' ||
      capture.domAssetId === 'input' ||
      assetIds.has(capture.screenshotAssetId) ||
      assetIds.has(capture.domAssetId)
    ) {
      throw new InvalidCritiqueInputError(
        'Capture asset IDs must be unique and cannot use input',
      );
    }
    assetIds.add(capture.screenshotAssetId);
    assetIds.add(capture.domAssetId);
  }
  if (manifest.mode === 'page' && manifest.comparison) {
    throw new InvalidCritiqueInputError('Page mode cannot include comparison');
  }
  if (manifest.mode === 'comparison') {
    const comparison = manifest.comparison;
    if (
      manifest.captures.length !== 2 ||
      !comparison ||
      comparison.baselineCaptureId === comparison.candidateCaptureId ||
      !captureIds.has(comparison.baselineCaptureId) ||
      !captureIds.has(comparison.candidateCaptureId)
    ) {
      throw new InvalidCritiqueInputError(
        'Comparison mode requires exactly two referenced captures',
      );
    }
  }
  return {
    ...manifest,
    captures: manifest.captures.map((capture) => {
      let page: CritiqueCapture['page'];
      if (capture.page) {
        let url: string | undefined;
        if (capture.page.url) {
          const parsed = new URL(capture.page.url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new InvalidCritiqueInputError(
              'Page provenance URL must use HTTP or HTTPS',
            );
          }
          parsed.username = '';
          parsed.password = '';
          parsed.search = '';
          parsed.hash = '';
          if (containsSensitiveValue(parsed.pathname)) parsed.pathname = '/';
          url = parsed.toString();
        }
        const title = sanitizeText(capture.page.title, 256);
        if (url || title)
          page = { ...(url ? { url } : {}), ...(title ? { title } : {}) };
      }
      return { ...capture, ...(page ? { page } : { page: undefined }) };
    }),
    ...(manifest.context
      ? {
          context: {
            task: sanitizeText(manifest.context.task, 4_000),
            designIntent: sanitizeText(manifest.context.designIntent, 4_000),
          },
        }
      : {}),
  };
}

function sanitizeDom(bytes: Buffer): Buffer {
  if (bytes.byteLength > MAX_DOM_BYTES) {
    throw new InvalidCritiqueInputError(
      `DOM asset exceeds ${MAX_DOM_BYTES} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new InvalidCritiqueInputError('DOM asset must contain valid JSON');
  }
  const result = domSchema.safeParse(parsed);
  if (!result.success)
    throw new InvalidCritiqueInputError('DOM asset has an invalid structure');
  const seen = new Set<string>();
  const nodes: DomNode[] = [];
  for (const [index, node] of result.data.nodes.entries()) {
    if (seen.has(node.id))
      throw new InvalidCritiqueInputError('DOM node IDs must be unique');
    if (index === 0) {
      if (node.id !== result.data.rootNodeId || node.parentId) {
        throw new InvalidCritiqueInputError('DOM root node is invalid');
      }
    } else if (!node.parentId || !seen.has(node.parentId)) {
      throw new InvalidCritiqueInputError(
        'DOM parent IDs must reference an earlier node',
      );
    }
    seen.add(node.id);
    if (['script', 'style', 'noscript'].includes(node.tagName)) {
      throw new InvalidCritiqueInputError(
        'DOM asset cannot contain script or style elements',
      );
    }
    const attributes = Object.fromEntries(
      Object.entries(node.attributes ?? {}).flatMap(([name, value]) => {
        const normalizedName = name.toLowerCase();
        const safeValue = sanitizeText(value, 256);
        return SAFE_ATTRIBUTES.has(normalizedName) && safeValue
          ? [[normalizedName, safeValue]]
          : [];
      }),
    );
    const styles = Object.fromEntries(
      Object.entries(node.styles).flatMap(([name, value]) => {
        const normalizedName = name.toLowerCase();
        if (
          !SAFE_STYLES.has(normalizedName) ||
          containsSensitiveValue(value) ||
          (normalizedName === 'background-image' && /url\s*\(/i.test(value))
        ) {
          return [];
        }
        return [[normalizedName, value.slice(0, 512)]];
      }),
    );
    const mayContainFormValue =
      ['input', 'textarea', 'select'].includes(node.tagName) ||
      Object.keys(node.attributes ?? {}).some(
        (name) => name.toLowerCase() === 'contenteditable',
      );
    nodes.push({
      id: node.id,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      tagName: node.tagName,
      ...(!mayContainFormValue && sanitizeText(node.text, 512)
        ? { text: sanitizeText(node.text, 512) }
        : {}),
      ...(Object.keys(attributes).length ? { attributes } : {}),
      bounds: node.bounds,
      styles,
      state: { visible: node.state.visible },
    });
  }
  if (!nodes.length || nodes[0]?.id !== result.data.rootNodeId) {
    throw new InvalidCritiqueInputError('DOM root element cannot be removed');
  }
  const sanitized = Buffer.from(
    JSON.stringify({ rootNodeId: result.data.rootNodeId, nodes }),
  );
  if (sanitized.byteLength > MAX_DOM_BYTES) {
    throw new InvalidCritiqueInputError(
      `Sanitized DOM exceeds ${MAX_DOM_BYTES} bytes`,
    );
  }
  return sanitized;
}

async function sanitizeScreenshot(
  bytes: Buffer,
  capture: CritiqueCapture,
): Promise<Buffer> {
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new InvalidCritiqueInputError(
      `Screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes`,
    );
  }
  const image = sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: MAX_SCREENSHOT_PIXELS,
  });
  const metadata = await image.metadata();
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    throw new InvalidCritiqueInputError('Screenshot must be a valid PNG');
  }
  const expectedWidth =
    capture.viewport.width * capture.viewport.deviceScaleFactor;
  const expectedHeight =
    capture.viewport.height * capture.viewport.deviceScaleFactor;
  if (
    Math.abs(metadata.width - expectedWidth) > 2 ||
    Math.abs(metadata.height - expectedHeight) > 2
  ) {
    throw new InvalidCritiqueInputError(
      'Screenshot dimensions do not match the declared viewport',
    );
  }
  const sanitized = await image.png({ compressionLevel: 9 }).toBuffer();
  if (sanitized.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new InvalidCritiqueInputError(
      `Sanitized screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes`,
    );
  }
  return sanitized;
}

function buildMultipart(
  manifest: CritiqueManifest,
  assets: Array<{
    id: string;
    contentType: string;
    extension: string;
    bytes: Buffer;
  }>,
): { body: Buffer; contentType: string } {
  const boundary = `roomote-critique-${randomUUID()}`;
  const chunks: Buffer[] = [];
  const addPart = (
    name: string,
    contentType: string,
    bytes: Buffer,
    fileName?: string,
  ) => {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${fileName ? `; filename="${fileName}"` : ''}\r\nContent-Type: ${contentType}\r\n\r\n`,
      ),
      bytes,
      Buffer.from('\r\n'),
    );
  };
  addPart('input', 'application/json', Buffer.from(JSON.stringify(manifest)));
  for (const asset of assets) {
    addPart(
      asset.id,
      asset.contentType,
      asset.bytes,
      `${asset.id}.${asset.extension}`,
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  if (body.byteLength > MAX_CRITIQUE_REQUEST_BYTES) {
    throw new InvalidCritiqueInputError(
      `Sanitized request exceeds ${MAX_CRITIQUE_REQUEST_BYTES} bytes`,
    );
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function parseAndSanitizeRequest(contentType: string, body: Uint8Array) {
  let formData: FormData;
  try {
    formData = await new Request('http://roomote.local/critique', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Blob([Uint8Array.from(body)]),
    }).formData();
  } catch {
    throw new InvalidCritiqueInputError('Critique multipart body is invalid');
  }
  const inputEntries = formData.getAll('input');
  if (inputEntries.length !== 1 || typeof inputEntries[0] !== 'string') {
    throw new InvalidCritiqueInputError(
      'Critique request requires exactly one JSON input part',
    );
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(inputEntries[0]);
  } catch {
    throw new InvalidCritiqueInputError(
      'Critique input part must contain valid JSON',
    );
  }
  const parsedManifest = manifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) {
    throw new InvalidCritiqueInputError('Critique input manifest is invalid');
  }
  const manifest = sanitizeManifest(parsedManifest.data);
  const expectedAssetIds = manifest.captures.flatMap((capture) => [
    capture.screenshotAssetId,
    capture.domAssetId,
  ]);
  const actualNames = [...formData.keys()];
  if (
    actualNames.length !== expectedAssetIds.length + 1 ||
    actualNames.some(
      (name) => name !== 'input' && !expectedAssetIds.includes(name),
    )
  ) {
    throw new InvalidCritiqueInputError(
      'Critique assets must match the manifest exactly',
    );
  }
  const assets: Array<{
    id: string;
    contentType: string;
    extension: string;
    bytes: Buffer;
  }> = [];
  for (const capture of manifest.captures) {
    const screenshotEntries = formData.getAll(capture.screenshotAssetId);
    const domEntries = formData.getAll(capture.domAssetId);
    if (
      screenshotEntries.length !== 1 ||
      domEntries.length !== 1 ||
      !(screenshotEntries[0] instanceof File) ||
      !(domEntries[0] instanceof File)
    ) {
      throw new InvalidCritiqueInputError(
        'Each manifest asset must appear exactly once as a file',
      );
    }
    assets.push(
      {
        id: capture.screenshotAssetId,
        contentType: 'image/png',
        extension: 'png',
        bytes: await sanitizeScreenshot(
          Buffer.from(await screenshotEntries[0].arrayBuffer()),
          capture,
        ),
      },
      {
        id: capture.domAssetId,
        contentType: 'application/json',
        extension: 'json',
        bytes: sanitizeDom(Buffer.from(await domEntries[0].arrayBuffer())),
      },
    );
  }
  return buildMultipart(manifest, assets);
}

function safeUpstreamDetail(
  payload: unknown,
  secret: string,
): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return undefined;
  const record = payload as Record<string, unknown>;
  const candidate =
    typeof record.error === 'string'
      ? record.error
      : typeof record.message === 'string'
        ? record.message
        : undefined;
  return candidate?.split(secret).join('[REDACTED]').slice(0, 1_000);
}

export const critique = new Hono<{ Variables: Variables }>();

critique.post('/', async (c) => {
  if (!Env.CRITIQUE_BASE_URL || !Env.CRITIQUE_API_TOKEN) {
    return c.json({ error: 'Critique visual review is not configured' }, 404);
  }
  if (!isRunTokenContext(c.get('authContext'))) {
    return c.json({ error: 'Critique requires a task run token' }, 403);
  }
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    return c.json({ error: 'Critique requires multipart/form-data' }, 400);
  }
  const declaredLength = Number(c.req.header('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_CRITIQUE_REQUEST_BYTES
  ) {
    return c.json(
      { error: `Critique request exceeds ${MAX_CRITIQUE_REQUEST_BYTES} bytes` },
      413,
    );
  }

  let outbound: { body: Buffer; contentType: string };
  try {
    const body = await readBoundedBytes(
      c.req.raw.body,
      MAX_CRITIQUE_REQUEST_BYTES,
    );
    outbound = await parseAndSanitizeRequest(contentType, body);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json(
        {
          error: `Critique request exceeds ${MAX_CRITIQUE_REQUEST_BYTES} bytes`,
        },
        413,
      );
    }
    if (error instanceof InvalidCritiqueInputError) {
      return c.json({ error: error.message }, 400);
    }
    logHandlerError('critiqueSanitize', error);
    return c.json({ error: 'Failed to sanitize Critique capture' }, 400);
  }

  const timeoutSignal = AbortSignal.timeout(CRITIQUE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      `${Env.CRITIQUE_BASE_URL.replace(/\/$/, '')}/v1/critiques`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${Env.CRITIQUE_API_TOKEN}`,
          'content-type': outbound.contentType,
          'content-length': String(outbound.body.byteLength),
        },
        body: new Blob([Uint8Array.from(outbound.body)]),
        signal: timeoutSignal,
      },
    );
  } catch (error) {
    if (timeoutSignal.aborted) {
      return c.json(
        {
          error: `Critique timed out after ${CRITIQUE_TIMEOUT_MS}ms; the paid request outcome is uncertain and must not be retried automatically`,
        },
        504,
      );
    }
    logHandlerError('critique', error);
    return c.json({ error: 'Critique request failed before a response' }, 502);
  }

  let responseBytes: Uint8Array;
  try {
    responseBytes = await readBoundedBytes(
      response.body,
      MAX_CRITIQUE_RESPONSE_BYTES,
    );
  } catch (error) {
    logHandlerError('critiqueResponse', error);
    return c.json({ error: 'Critique response exceeded the size limit' }, 502);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(responseBytes));
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail = safeUpstreamDetail(payload, Env.CRITIQUE_API_TOKEN);
    if (response.status >= 400 && response.status < 500) {
      return c.json(
        {
          error:
            'Critique rejected the capture or input; do not retry unchanged',
          upstreamStatus: response.status,
          ...(detail ? { detail } : {}),
        },
        400,
      );
    }
    if (response.status === 502 || response.status === 503) {
      return c.json(
        {
          error: 'Critique service is unavailable',
          upstreamStatus: response.status,
          ...(detail ? { detail } : {}),
        },
        response.status,
      );
    }
    return c.json(
      {
        error: 'Critique service returned an error',
        upstreamStatus: response.status,
        ...(detail ? { detail } : {}),
      },
      502,
    );
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !['completed', 'partial'].includes(
      String((payload as Record<string, unknown>).status),
    ) ||
    !Array.isArray((payload as Record<string, unknown>).findings)
  ) {
    return c.json({ error: 'Critique returned an invalid response' }, 502);
  }
  return c.json(payload);
});
