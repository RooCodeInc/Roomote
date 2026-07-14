import type { TaskArtifact } from '@/types';

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

export function extractVisualProofUploadFromToolMessage(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): VisualProofUploadExtraction | null {
  if (msg.kind !== 'tool_result') {
    return null;
  }

  if (
    msg.partial ||
    msg.data.status === 'failed' ||
    msg.data.status === 'in_progress'
  ) {
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

export function resolveVisualProofDisplayMedia(
  extraction: VisualProofUploadExtraction | null,
  artifacts: readonly TaskArtifact[] | null | undefined,
): VisualProofDisplayMedia | null {
  if (!extraction) {
    return null;
  }

  const artifact = artifacts?.find((item) => item.id === extraction.artifactId);
  const path = artifact?.path;
  const version = artifact?.version;
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
