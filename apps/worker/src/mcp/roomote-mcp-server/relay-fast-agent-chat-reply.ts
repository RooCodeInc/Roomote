import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { sdk } from '@roomote/sdk/client';

import {
  errorResultWithArtifacts,
  normalizeOptionalSlackText,
  uniqueNonEmpty,
  uploadSlackImagePaths,
  validateSlackPostContent,
} from './slack-post-helpers.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { ArtifactConfig, ToolResult } from './types.js';

export async function handleRelayFastAgentChatReply(
  input: {
    runId: number;
    taskId: string;
    purpose: 'ack' | 'progress' | 'closeout' | 'clarification';
    message: string;
    imagePaths?: string[];
    imageArtifactIds?: string[];
    relayStateDirectory?: string;
  },
  artifactConfig: ArtifactConfig,
): Promise<ToolResult> {
  if (!Number.isInteger(input.runId) || input.runId <= 0) {
    return errorResult('ROOMOTE_TASK_RUN_ID environment variable not set');
  }

  const message = normalizeOptionalSlackText(input.message);
  const imagePaths = uniqueNonEmpty(input.imagePaths);
  const imageArtifactIds = uniqueNonEmpty(input.imageArtifactIds);
  const relaySignature = createHash('sha256')
    .update(
      JSON.stringify({
        runId: input.runId,
        taskId: input.taskId,
        purpose: input.purpose,
        message,
        imagePaths,
        imageArtifactIds,
      }),
    )
    .digest('hex');
  const relayStateDirectory =
    input.relayStateDirectory ??
    join(
      process.env.HOME ?? '/tmp',
      '.config',
      'opencode',
      'fast-agent-relays',
    );
  const relayStateFilePath = join(
    relayStateDirectory,
    `${relaySignature}.json`,
  );
  const relayId = getOrCreateRelayId(relayStateFilePath, relaySignature);

  if (imagePaths.length > 0 && !artifactConfig.workspacePath) {
    return errorResult('ROOMOTE_WORKSPACE_PATH not set');
  }

  const uploadedArtifactIds: string[] = [];

  try {
    const uploads = await uploadSlackImagePaths({
      taskId: input.taskId,
      imagePaths,
      artifactConfig,
    });
    uploadedArtifactIds.push(...uploads.uploadedArtifactIds);
    const allArtifactIds = [
      ...new Set([...imageArtifactIds, ...uploadedArtifactIds]),
    ];
    const contentValidation = validateSlackPostContent({
      text: message,
      imagePaths,
      imageArtifactIds,
      emptyContentError:
        'At least one of message, imagePaths, or imageArtifactIds is required',
    });
    if (contentValidation) {
      return contentValidation;
    }

    const result = await sdk.taskRuns.relayFastAgentChildChatReply({
      runId: input.runId,
      taskId: input.taskId,
      messageId: relayId,
      purpose: input.purpose,
      message: message ?? '',
      ...(allArtifactIds.length ? { imageArtifactIds: allArtifactIds } : {}),
    });

    if (!result.relayed) {
      return errorResult('The Fast parent could not receive this update.');
    }

    clearRelayId(relayStateFilePath, relaySignature);

    return successResult({
      relayed: true,
      relayId,
      ...(uploadedArtifactIds.length ? { uploadedArtifactIds } : {}),
      ...(imageArtifactIds.length ? { imageArtifactIds } : {}),
    });
  } catch (error) {
    if (uploadedArtifactIds.length) {
      return errorResultWithArtifacts(
        error instanceof Error ? error.message : String(error),
        uploadedArtifactIds,
      );
    }

    return catchError(error);
  }
}

function readRelayState(
  stateFilePath: string,
): { signature: string; relayId: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath, 'utf8')) as {
      signature?: unknown;
      relayId?: unknown;
    };
    return typeof parsed.signature === 'string' &&
      typeof parsed.relayId === 'string'
      ? { signature: parsed.signature, relayId: parsed.relayId }
      : null;
  } catch {
    return null;
  }
}

function getOrCreateRelayId(stateFilePath: string, signature: string): string {
  const existing = readRelayState(stateFilePath);
  if (existing?.signature === signature) {
    return existing.relayId;
  }

  const relayId = randomUUID();
  mkdirSync(dirname(stateFilePath), { recursive: true });
  try {
    writeFileSync(stateFilePath, JSON.stringify({ signature, relayId }), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return relayId;
  } catch {
    const persisted = readRelayState(stateFilePath);
    if (persisted) {
      return persisted.relayId;
    }
    throw new Error('Failed to persist the Fast relay delivery key.');
  }
}

function clearRelayId(stateFilePath: string, signature: string): void {
  if (readRelayState(stateFilePath)?.signature !== signature) {
    return;
  }

  try {
    unlinkSync(stateFilePath);
  } catch {
    // A later retry can safely reuse or replace stale state.
  }
}
