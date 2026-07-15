import type { TaskArtifact } from '@/types';

import { isSubagentToolPayload } from './subagent-tool';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';

const MANAGE_ARTIFACTS_TOOL_NAME = 'manage_artifacts';

type VisualProofUploadExtraction = {
  artifactId: string;
  artifactType: 'visual-proof';
  viewUrl: string;
  rawUrl?: string;
};

export type VisualProofDisplayMedia =
  | {
      kind: 'image';
      src: string;
      viewUrl: string;
      artifactId: string;
      path?: string;
      version?: number;
    }
  | {
      kind: 'video';
      src: string;
      viewUrl: string;
      artifactId: string;
      path?: string;
      version?: number;
    }
  | {
      kind: 'link';
      viewUrl: string;
      artifactId: string;
      path?: string;
      version?: number;
    };

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function unwrapToolResultPayload(
  value: unknown,
): Record<string, unknown> | null {
  const record = asRecord(value);

  if (!record) {
    return null;
  }

  if (record.success === true) {
    return record;
  }

  const nested = asRecord(record.result) ?? asRecord(record.data);
  return nested?.success === true ? nested : null;
}

function getMcpToolName(
  data: AcpToolResultUiMessage['data'] | AcpToolCallUiMessage['data'],
): string | null {
  return (
    asNonEmptyString(data.mcpToolName) ??
    asNonEmptyString(data.toolName) ??
    null
  );
}

function parseVisualProofSuccessPayload(
  value: unknown,
): VisualProofUploadExtraction | null {
  const record = unwrapToolResultPayload(value);

  if (!record) {
    return null;
  }

  const artifactId = asNonEmptyString(record.artifactId);
  const viewUrl = asNonEmptyString(record.viewUrl);
  const artifactType = asNonEmptyString(record.artifactType);
  const rawUrl = asNonEmptyString(record.rawUrl) ?? undefined;

  if (!artifactId || !viewUrl || artifactType !== 'visual-proof') {
    return null;
  }

  return {
    artifactId,
    artifactType: 'visual-proof',
    viewUrl,
    ...(rawUrl ? { rawUrl } : {}),
  };
}

function isSettledToolResult(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): msg is AcpToolResultUiMessage {
  return (
    msg.kind === 'tool_result' &&
    !msg.partial &&
    msg.data.status !== 'failed' &&
    msg.data.status !== 'in_progress'
  );
}

function extractVisualProofUploadFromToolMessage(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): VisualProofUploadExtraction | null {
  if (!isSettledToolResult(msg)) {
    return null;
  }

  if (msg.data.isMcp !== true) {
    return null;
  }

  const toolName = getMcpToolName(msg.data);

  if (toolName !== MANAGE_ARTIFACTS_TOOL_NAME) {
    return null;
  }

  const output = asNonEmptyString(msg.data.output);
  const text = asNonEmptyString(msg.text);

  for (const candidate of [output, text]) {
    if (!candidate) {
      continue;
    }

    const parsed = tryParseJson(candidate);
    const extraction = parseVisualProofSuccessPayload(parsed);

    if (extraction) {
      return extraction;
    }
  }

  return null;
}

function parseArtifactLocationFromViewUrl(viewUrl: string): {
  path?: string;
  version?: number;
} {
  try {
    const url = new URL(viewUrl, 'http://localhost');
    const match = url.pathname.match(/\/artifacts\/(.+)$/);
    if (!match?.[1]) {
      return {};
    }

    const path = decodeURIComponent(match[1]);
    const versionParam = url.searchParams.get('v');
    const version =
      versionParam && Number.isFinite(Number(versionParam))
        ? Number(versionParam)
        : undefined;

    return { path, version };
  } catch {
    return {};
  }
}

function resolveVisualProofDisplayMedia(
  extraction: VisualProofUploadExtraction | null,
  artifacts: readonly TaskArtifact[] | null | undefined,
): VisualProofDisplayMedia | null {
  if (!extraction) {
    return null;
  }

  const artifact = artifacts?.find((item) => item.id === extraction.artifactId);
  const parsedLocation = parseArtifactLocationFromViewUrl(extraction.viewUrl);
  const path = artifact?.path ?? parsedLocation.path;
  const version = artifact?.version ?? parsedLocation.version;
  const contentType = artifact?.contentType ?? '';

  // Prefer session-supplied thumbnails whenever present.
  if (artifact?.thumbnailUrl) {
    return {
      kind: 'image',
      src: artifact.thumbnailUrl,
      viewUrl: extraction.viewUrl,
      artifactId: extraction.artifactId,
      path,
      version,
    };
  }

  if (artifact && contentType.startsWith('video/')) {
    const src = artifact.previewUrl;

    if (src) {
      return {
        kind: 'video',
        src,
        viewUrl: extraction.viewUrl,
        artifactId: extraction.artifactId,
        path,
        version,
      };
    }
  }

  // Upload contract: rawUrl is only set for images.
  if (extraction.rawUrl) {
    return {
      kind: 'image',
      src: extraction.rawUrl,
      viewUrl: extraction.viewUrl,
      artifactId: extraction.artifactId,
      path,
      version,
    };
  }

  return {
    kind: 'link',
    viewUrl: extraction.viewUrl,
    artifactId: extraction.artifactId,
    path,
    version,
  };
}

const URL_CANDIDATE_PATTERN = /https?:\/\/[^\s"'`<>]+/g;
const TASK_ARTIFACT_VIEW_PATH_PATTERN = /^\/task\/[^/]+\/artifacts\/.+$/;

/**
 * Pull task-artifact viewUrls (`/task/<id>/artifacts/<path>?v=N`) out of
 * free-form subagent result text. Signed rawUrls (`/api/artifacts/...`) are
 * deliberately skipped: their signatures expire, so they cannot back a
 * durable inline preview.
 */
function extractArtifactViewUrlsFromText(text: string): string[] {
  const viewUrls: string[] = [];

  for (const match of text.matchAll(URL_CANDIDATE_PATTERN)) {
    const candidate = match[0].replace(/[)\],.;'"`]+$/, '');

    try {
      const url = new URL(candidate);

      if (TASK_ARTIFACT_VIEW_PATH_PATTERN.test(url.pathname)) {
        viewUrls.push(candidate);
      }
    } catch {
      // Not a parseable URL; skip.
    }
  }

  return viewUrls;
}

function findSessionArtifactByLocation(
  artifacts: readonly TaskArtifact[],
  path: string,
  version: number | undefined,
): TaskArtifact | undefined {
  const matches = artifacts.filter((artifact) => artifact.path === path);

  if (matches.length === 0) {
    return undefined;
  }

  if (version !== undefined) {
    const exact = matches.find((artifact) => artifact.version === version);

    if (exact) {
      return exact;
    }
  }

  return matches.reduce((best, artifact) =>
    artifact.version > best.version ? artifact : best,
  );
}

/**
 * Proof-runner delegation path: the subagent uploads through
 * manage_artifacts inside its own session, so the transcript only carries
 * the spawn's terminal tool_result — a text blob with artifact viewUrls in
 * prose, not the structured upload JSON. Recover those viewUrls and resolve
 * them against the session artifact list, which supplies fresh signed
 * thumbnail/preview URLs.
 */
function resolveSubagentVisualProofMedia(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
  artifacts: readonly TaskArtifact[] | null | undefined,
): VisualProofDisplayMedia[] {
  if (!isSettledToolResult(msg) || !isSubagentToolPayload(msg.data)) {
    return [];
  }

  if (!artifacts || artifacts.length === 0) {
    return [];
  }

  const text = [asNonEmptyString(msg.data.output), asNonEmptyString(msg.text)]
    .filter(Boolean)
    .join('\n');

  if (!text) {
    return [];
  }

  const media: VisualProofDisplayMedia[] = [];
  const seenArtifactIds = new Set<string>();

  for (const viewUrl of extractArtifactViewUrlsFromText(text)) {
    const location = parseArtifactLocationFromViewUrl(viewUrl);

    if (!location.path) {
      continue;
    }

    const artifact = findSessionArtifactByLocation(
      artifacts,
      location.path,
      location.version,
    );

    if (
      !artifact ||
      artifact.artifactType !== 'visual-proof' ||
      seenArtifactIds.has(artifact.id)
    ) {
      continue;
    }

    const resolved = resolveVisualProofDisplayMedia(
      {
        artifactId: artifact.id,
        artifactType: 'visual-proof',
        viewUrl,
      },
      artifacts,
    );

    // Without renderable media there is nothing to preview inline; the
    // subagent row's regular details already carry the artifact link.
    if (resolved && resolved.kind !== 'link') {
      seenArtifactIds.add(artifact.id);
      media.push(resolved);
    }
  }

  return media;
}

export function resolveVisualProofMediaForToolMessage(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
  artifacts: readonly TaskArtifact[] | null | undefined,
): VisualProofDisplayMedia[] {
  const direct = resolveVisualProofDisplayMedia(
    extractVisualProofUploadFromToolMessage(msg),
    artifacts,
  );

  if (direct) {
    return [direct];
  }

  return resolveSubagentVisualProofMedia(msg, artifacts);
}
