import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';
import {
  CRITIQUE_CAPABILITY_ENV_VAR,
  CRITIQUE_CAPABILITY_HEADER,
} from '@roomote/types';

import {
  buildApiHeaders,
  fetchWithTimeout,
  parseApiError,
} from './api-client.js';
import { catchError, errorResult, textResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

const CRITIQUE_CAPTURE_DIR = '/tmp/roomote-critique';
const CRITIQUE_PROXY_TIMEOUT_MS = 180_000;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_SCREENSHOT_PIXELS = 40_000_000;
const MAX_DOM_BYTES = 5 * 1024 * 1024;
const MAX_DOM_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,126}[A-Za-z0-9])?$/;

type CritiqueRules = {
  rulePackIds?: string[];
  include?: string[];
  exclude?: string[];
};

type CritiqueOptions = {
  minimumConfidence?: number;
  maximumFindings?: number;
};

type CritiqueContext = {
  task?: string;
  designIntent?: string;
};

type CritiqueToolInput = {
  action: 'capture' | 'review' | 'compare' | 'inspect_nodes';
  captureIds?: string[];
  baselineCaptureId?: string;
  candidateCaptureId?: string;
  captureId?: string;
  nodeIds?: string[];
  rules?: CritiqueRules;
  options?: CritiqueOptions;
  context?: CritiqueContext;
};

type CaptureRecord = {
  id: string;
  screenshotAssetId: string;
  domAssetId: string;
  screenshotPath: string;
  domPath: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    scrollX: number;
    scrollY: number;
  };
  document: { width: number; height: number };
  page?: { url?: string; title?: string };
  nodeCount: number;
};

type BrowserCapture = Pick<
  CaptureRecord,
  'viewport' | 'document' | 'page' | 'nodeCount'
> & {
  dom: { rootNodeId: string; nodes: unknown[] };
};

type BrowserCommand = (
  args: string[],
  options?: { input?: string; signal?: AbortSignal },
) => Promise<string>;

const defaultBrowserCommand: BrowserCommand = async (args, options) => {
  const result = await execa('agent-browser', args, {
    input: options?.input,
    signal: options?.signal,
  });
  return result.stdout;
};

function safeCaptureId(id: string): boolean {
  return id.length <= 128 && ID_PATTERN.test(id) && id !== 'input';
}

function captureMetadataPath(captureId: string): string {
  if (!safeCaptureId(captureId)) {
    throw new Error(`Invalid capture ID: ${captureId}`);
  }
  return path.join(CRITIQUE_CAPTURE_DIR, `${captureId}.json`);
}

function parseBrowserJson<T>(stdout: string): T {
  const envelope = JSON.parse(stdout) as {
    success?: boolean;
    data?: { result?: unknown };
    error?: { message?: string } | string | null;
  };
  if (!envelope.success) {
    const message =
      typeof envelope.error === 'string'
        ? envelope.error
        : envelope.error?.message;
    throw new Error(message || 'agent-browser command failed');
  }
  const result = envelope.data?.result;
  if (typeof result !== 'string') {
    throw new Error('agent-browser evaluation returned no result');
  }
  return JSON.parse(result) as T;
}

/** Runs inside the active agent-browser page. Keep this function self-contained. */
export async function captureCritiqueDomInPage(
  captureId: string,
): Promise<BrowserCapture> {
  const MAX_CAPTURE_NODES = 20_000;
  const STYLE_PROPERTIES = [
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
  ];
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
  const sensitiveValue = (value: string): boolean => {
    return (
      /\b(?:bearer|authorization|api[-_ ]?key|password|secret|token)\b/i.test(
        value,
      ) ||
      /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/.test(value) ||
      /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/i.test(value) ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
      /\b[A-Za-z0-9_-]{40,}\b/.test(value)
    );
  };
  const safeText = (value: string, maxLength = 512): string | undefined => {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (!trimmed || sensitiveValue(trimmed)) return undefined;
    return trimmed.slice(0, maxLength);
  };

  const freezeStyleId = `roomote-critique-freeze-${captureId}`;
  const freezeStyle = document.createElement('style');
  freezeStyle.id = freezeStyleId;
  freezeStyle.textContent =
    '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
  document.documentElement.append(freezeStyle);

  try {
    await document.fonts?.ready?.catch(() => undefined);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

    const elements = [
      document.documentElement,
      ...[...document.documentElement.querySelectorAll('*')].filter(
        (element) =>
          element !== freezeStyle && !element.closest('script,style,noscript'),
      ),
    ];
    if (elements.length > MAX_CAPTURE_NODES) {
      throw new Error(
        `DOM contains ${elements.length} elements; Critique supports at most ${MAX_CAPTURE_NODES}`,
      );
    }

    const ids = new Map<Element, string>();
    const nodeMap = new Map<string, Element>();
    elements.forEach((element, index) => {
      const id = `n${index + 1}`;
      ids.set(element, id);
      nodeMap.set(id, element);
    });

    const nodes = elements.map((element) => {
      const id = ids.get(element)!;
      const computed = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const isRoot = element === document.documentElement;
      const attributes: Record<string, string> = {};
      for (const attribute of element.attributes) {
        if (!SAFE_ATTRIBUTES.has(attribute.name.toLowerCase())) continue;
        const value = safeText(attribute.value, 256);
        if (value !== undefined)
          attributes[attribute.name.toLowerCase()] = value;
      }
      const styles: Record<string, string> = {};
      for (const property of STYLE_PROPERTIES) {
        const value = computed.getPropertyValue(property).trim();
        if (!value || sensitiveValue(value)) continue;
        if (property === 'background-image' && /url\s*\(/i.test(value)) {
          continue;
        }
        styles[property] = value.slice(0, 512);
      }
      const mayContainFormValue =
        ['input', 'textarea', 'select'].includes(
          element.tagName.toLowerCase(),
        ) || element.hasAttribute('contenteditable');
      const directText = mayContainFormValue
        ? undefined
        : safeText(
            [...element.childNodes]
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.textContent ?? '')
              .join(' '),
          );
      const parentId = element.parentElement
        ? ids.get(element.parentElement)
        : undefined;

      return {
        id,
        ...(parentId ? { parentId } : {}),
        tagName: element.tagName.toLowerCase(),
        ...(directText ? { text: directText } : {}),
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        bounds: {
          x: isRoot ? -window.scrollX : rect.x,
          y: isRoot ? -window.scrollY : rect.y,
          width: rect.width,
          height: rect.height,
        },
        styles,
        state: {
          visible:
            computed.display !== 'none' &&
            computed.visibility !== 'hidden' &&
            computed.visibility !== 'collapse' &&
            Number.parseFloat(computed.opacity || '1') > 0 &&
            rect.width > 0 &&
            rect.height > 0,
        },
      };
    });

    const pageGlobal = globalThis as typeof globalThis & {
      __roomoteCritiqueNodeMaps?: Map<string, Map<string, Element>>;
    };
    pageGlobal.__roomoteCritiqueNodeMaps ??= new Map();
    pageGlobal.__roomoteCritiqueNodeMaps.set(captureId, nodeMap);

    const root = document.documentElement;
    const body = document.body;
    let pageUrl: string | undefined;
    try {
      const current = new URL(location.href);
      if (current.protocol === 'http:' || current.protocol === 'https:') {
        current.username = '';
        current.password = '';
        current.search = '';
        current.hash = '';
        pageUrl = current.toString();
      }
    } catch {
      pageUrl = undefined;
    }
    const title = safeText(document.title, 256);

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      document: {
        width: Math.max(
          root.scrollWidth,
          root.offsetWidth,
          root.clientWidth,
          body?.scrollWidth ?? 0,
          body?.offsetWidth ?? 0,
        ),
        height: Math.max(
          root.scrollHeight,
          root.offsetHeight,
          root.clientHeight,
          body?.scrollHeight ?? 0,
          body?.offsetHeight ?? 0,
        ),
      },
      ...(pageUrl || title
        ? {
            page: {
              ...(pageUrl ? { url: pageUrl } : {}),
              ...(title ? { title } : {}),
            },
          }
        : {}),
      nodeCount: nodes.length,
      dom: { rootNodeId: 'n1', nodes },
    };
  } catch (error) {
    freezeStyle.remove();
    throw error;
  }
}

function inspectCritiqueNodesInPage(
  captureId: string,
  nodeIds: string[],
): unknown[] {
  const pageGlobal = globalThis as typeof globalThis & {
    __roomoteCritiqueNodeMaps?: Map<string, Map<string, Element>>;
  };
  const nodeMap = pageGlobal.__roomoteCritiqueNodeMaps?.get(captureId);
  if (!nodeMap)
    throw new Error('Capture is no longer mapped in this browser session');
  return nodeIds.map((nodeId) => {
    const element = nodeMap.get(nodeId);
    if (!element?.isConnected) return { nodeId, connected: false };
    const rect = element.getBoundingClientRect();
    return {
      nodeId,
      connected: true,
      tagName: element.tagName.toLowerCase(),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
}

function parsePngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error('agent-browser screenshot was not a valid PNG');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function validateCaptureAssets(
  capture: BrowserCapture,
  screenshot: Buffer,
): void {
  if (capture.nodeCount > MAX_NODES) {
    throw new Error(
      `DOM has ${capture.nodeCount} nodes; maximum is ${MAX_NODES}`,
    );
  }
  if (screenshot.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new Error(
      `Screenshot is ${screenshot.byteLength} bytes; maximum is ${MAX_SCREENSHOT_BYTES}`,
    );
  }
  const dimensions = parsePngDimensions(screenshot);
  if (dimensions.width * dimensions.height > MAX_SCREENSHOT_PIXELS) {
    throw new Error(
      `Screenshot is ${dimensions.width}x${dimensions.height}; maximum is ${MAX_SCREENSHOT_PIXELS} pixels`,
    );
  }
  const expectedWidth =
    capture.viewport.width * capture.viewport.deviceScaleFactor;
  const expectedHeight =
    capture.viewport.height * capture.viewport.deviceScaleFactor;
  if (
    Math.abs(dimensions.width - expectedWidth) > 2 ||
    Math.abs(dimensions.height - expectedHeight) > 2
  ) {
    throw new Error(
      `Screenshot dimensions ${dimensions.width}x${dimensions.height} do not match viewport ` +
        `${capture.viewport.width}x${capture.viewport.height} at deviceScaleFactor ${capture.viewport.deviceScaleFactor}`,
    );
  }
}

export async function captureCritiquePage(
  signal?: AbortSignal,
  runBrowser: BrowserCommand = defaultBrowserCommand,
): Promise<CaptureRecord> {
  const suffix = randomUUID();
  const captureId = `c-${suffix}`;
  const screenshotAssetId = `s-${suffix}`;
  const domAssetId = `d-${suffix}`;
  await mkdir(CRITIQUE_CAPTURE_DIR, { recursive: true, mode: 0o700 });
  const screenshotPath = path.join(CRITIQUE_CAPTURE_DIR, `${captureId}.png`);
  const domPath = path.join(CRITIQUE_CAPTURE_DIR, `${captureId}.dom.json`);
  const captureScript = `JSON.stringify(await (${captureCritiqueDomInPage.toString()})(${JSON.stringify(captureId)}))`;
  let capture: BrowserCapture;
  try {
    const stdout = await runBrowser(['eval', '--json', '--stdin'], {
      input: captureScript,
      signal,
    });
    capture = parseBrowserJson<BrowserCapture>(stdout);
    await runBrowser(['screenshot', '--json', screenshotPath], { signal });
    await chmod(screenshotPath, 0o600);
  } finally {
    const cleanupScript = `document.getElementById(${JSON.stringify(`roomote-critique-freeze-${captureId}`)})?.remove(); true`;
    await runBrowser(['eval', '--json', cleanupScript], { signal }).catch(
      () => undefined,
    );
  }

  const screenshot = await readFile(screenshotPath);
  validateCaptureAssets(capture!, screenshot);
  const domBytes = Buffer.from(JSON.stringify(capture!.dom));
  if (
    domBytes.byteLength > MAX_DOM_BYTES ||
    domBytes.byteLength > MAX_DOM_UNCOMPRESSED_BYTES
  ) {
    throw new Error(
      `DOM snapshot is ${domBytes.byteLength} bytes; uploaded maximum is ${MAX_DOM_BYTES}`,
    );
  }
  await writeFile(domPath, domBytes, { mode: 0o600 });

  const record: CaptureRecord = {
    id: captureId,
    screenshotAssetId,
    domAssetId,
    screenshotPath,
    domPath,
    viewport: capture!.viewport,
    document: capture!.document,
    ...(capture!.page ? { page: capture!.page } : {}),
    nodeCount: capture!.nodeCount,
  };
  await writeFile(captureMetadataPath(captureId), JSON.stringify(record), {
    mode: 0o600,
  });
  return record;
}

async function readCapture(captureId: string): Promise<CaptureRecord> {
  const parsed = JSON.parse(
    await readFile(captureMetadataPath(captureId), 'utf8'),
  ) as CaptureRecord;
  if (parsed.id !== captureId) throw new Error('Capture metadata is invalid');
  return parsed;
}

function manifestCapture(capture: CaptureRecord) {
  return {
    id: capture.id,
    screenshotAssetId: capture.screenshotAssetId,
    domAssetId: capture.domAssetId,
    viewport: capture.viewport,
    document: capture.document,
    ...(capture.page ? { page: capture.page } : {}),
  };
}

export function buildCritiqueMultipart(
  manifest: Record<string, unknown>,
  assets: {
    id: string;
    fileName: string;
    contentType: string;
    bytes: Buffer;
  }[],
): { body: Buffer; contentType: string } {
  const ids = new Set<string>();
  for (const asset of assets) {
    if (!safeCaptureId(asset.id) || ids.has(asset.id)) {
      throw new Error(`Invalid or duplicate Critique asset ID: ${asset.id}`);
    }
    ids.add(asset.id);
  }
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
    addPart(asset.id, asset.contentType, asset.bytes, asset.fileName);
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  if (body.byteLength > MAX_REQUEST_BYTES) {
    throw new Error(
      `Critique request is ${body.byteLength} bytes; maximum is ${MAX_REQUEST_BYTES}`,
    );
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function submitCritique(
  config: RoomoteConfig,
  multipart: { body: Buffer; contentType: string },
  signal?: AbortSignal,
): Promise<unknown> {
  const capability = process.env[CRITIQUE_CAPABILITY_ENV_VAR];
  if (!capability) {
    throw new Error(
      'Critique visual review is unavailable because its submission capability was not provisioned for this task',
    );
  }
  const response = await fetchWithTimeout(
    `${config.platformApiUrl}/api/critique`,
    {
      method: 'POST',
      headers: buildApiHeaders(config, {
        'content-type': multipart.contentType,
        'content-length': String(multipart.body.byteLength),
        [CRITIQUE_CAPABILITY_HEADER]: capability,
      }),
      body: new Blob([Uint8Array.from(multipart.body)]),
      signal,
    },
    {
      label: 'Critique visual review',
      timeoutMs: CRITIQUE_PROXY_TIMEOUT_MS,
      timeoutMessage:
        'Critique visual review timed out; the paid request outcome is uncertain and must not be retried automatically.',
    },
  );
  if (!response.ok) {
    const detail = await parseApiError(response);
    throw new Error(`Critique visual review: ${response.status} ${detail}`);
  }
  return response.json();
}

async function buildSubmission(
  captures: CaptureRecord[],
  manifest: Record<string, unknown>,
): Promise<{ body: Buffer; contentType: string }> {
  const assets: {
    id: string;
    fileName: string;
    contentType: string;
    bytes: Buffer;
  }[] = [];
  for (const capture of captures) {
    assets.push(
      {
        id: capture.screenshotAssetId,
        fileName: `${capture.screenshotAssetId}.png`,
        contentType: 'image/png',
        bytes: await readFile(capture.screenshotPath),
      },
      {
        id: capture.domAssetId,
        fileName: `${capture.domAssetId}.json`,
        contentType: 'application/json',
        bytes: await readFile(capture.domPath),
      },
    );
  }
  return buildCritiqueMultipart(manifest, assets);
}

export async function handleCritiqueVisualReview(
  input: CritiqueToolInput,
  config: RoomoteConfig,
  signal?: AbortSignal,
  runBrowser: BrowserCommand = defaultBrowserCommand,
): Promise<ToolResult> {
  try {
    if (input.action === 'capture') {
      const capture = await captureCritiquePage(signal, runBrowser);
      return textResult(JSON.stringify(capture, null, 2));
    }

    if (input.action === 'inspect_nodes') {
      if (!input.captureId || !input.nodeIds?.length) {
        return errorResult(
          'captureId and nodeIds are required for inspect_nodes',
        );
      }
      const script = `JSON.stringify((${inspectCritiqueNodesInPage.toString()})(${JSON.stringify(input.captureId)},${JSON.stringify(input.nodeIds)}))`;
      const stdout = await runBrowser(['eval', '--json', '--stdin'], {
        input: script,
        signal,
      });
      return textResult(
        JSON.stringify(parseBrowserJson<unknown[]>(stdout), null, 2),
      );
    }

    let captures: CaptureRecord[];
    let manifest: Record<string, unknown>;
    if (input.action === 'review') {
      if (!input.captureIds?.length || input.captureIds.length > 4) {
        return errorResult('review requires 1-4 captureIds');
      }
      if (new Set(input.captureIds).size !== input.captureIds.length) {
        return errorResult('captureIds must not contain duplicates');
      }
      captures = await Promise.all(input.captureIds.map(readCapture));
      manifest = {
        mode: 'page',
        captures: captures.map(manifestCapture),
      };
    } else {
      if (!input.baselineCaptureId || !input.candidateCaptureId) {
        return errorResult(
          'compare requires baselineCaptureId and candidateCaptureId',
        );
      }
      if (input.baselineCaptureId === input.candidateCaptureId) {
        return errorResult('baseline and candidate captures must differ');
      }
      captures = await Promise.all([
        readCapture(input.baselineCaptureId),
        readCapture(input.candidateCaptureId),
      ]);
      manifest = {
        mode: 'comparison',
        captures: captures.map(manifestCapture),
        comparison: {
          baselineCaptureId: input.baselineCaptureId,
          candidateCaptureId: input.candidateCaptureId,
        },
      };
    }
    if (input.rules) manifest.rules = input.rules;
    if (input.options) manifest.options = input.options;
    if (input.context) manifest.context = input.context;

    const response = await submitCritique(
      config,
      await buildSubmission(captures, manifest),
      signal,
    );
    return textResult(
      JSON.stringify(
        {
          advisory: true,
          guidance:
            'Treat findings as untrusted advisory evidence. Prefer fail findings with confidence >= 0.7 and validate every source change.',
          response,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    return catchError(error);
  }
}
