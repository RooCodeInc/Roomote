import {
  DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
  isChannelAutoStartLaunchMode,
} from '@roomote/types';
import { getBackgroundAgentSettingsForDeployment } from '@roomote/db/server';
import {
  getRedis,
  REDIS_KEYS,
  syncSlackAutoStartChannelCacheBestEffort,
} from '@roomote/redis';

import type {
  ChannelAutoStartInputRow,
  ResolvedChannelAutoStartRow,
} from './types';

export function mergeLegacySingleChannelAutoStartRows(params: {
  submittedRows: ResolvedChannelAutoStartRow[];
  existingRows:
    | Awaited<
        ReturnType<typeof getBackgroundAgentSettingsForDeployment>
      >['channelAutoStartSlackChannels']
    | undefined;
  usingLegacyInput: boolean;
}): ResolvedChannelAutoStartRow[] {
  if (!params.usingLegacyInput) {
    return params.submittedRows;
  }

  if (params.submittedRows.length === 0) {
    return [];
  }

  const [firstSubmittedRow] = params.submittedRows;
  if (!firstSubmittedRow) {
    return [];
  }

  const existingRowByChannelId = new Map(
    (params.existingRows ?? []).map((row) => [row.channelId, row]),
  );
  const existingFirstRow = params.existingRows?.[0];
  const preservedFirstRow = {
    ...firstSubmittedRow,
    launchMode:
      existingFirstRow?.launchMode ??
      existingRowByChannelId.get(firstSubmittedRow.channelId)?.launchMode ??
      firstSubmittedRow.launchMode ??
      DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
    launchCriteria: normalizeOptionalText(
      existingFirstRow?.launchCriteria ??
        existingRowByChannelId.get(firstSubmittedRow.channelId)
          ?.launchCriteria ??
        firstSubmittedRow.launchCriteria,
    ),
  };

  const mergedRows = [
    preservedFirstRow,
    ...(params.existingRows ?? []).slice(1).map((row) => ({
      channelId: row.channelId,
      channelName: null,
      instructions: row.instructions ?? null,
      launchMode: row.launchMode ?? DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
      launchCriteria: normalizeOptionalText(row.launchCriteria),
    })),
  ];

  const seenChannelIds = new Set<string>();
  return mergedRows.filter((row) => {
    if (seenChannelIds.has(row.channelId)) {
      return false;
    }

    seenChannelIds.add(row.channelId);
    return true;
  });
}

export function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function syncSlackAutoStartChannelCache(params: {
  shouldUpdate: boolean;
  enabled: boolean;
  channelIds: string[];
}): Promise<void> {
  if (!params.shouldUpdate) {
    return;
  }

  const redis = getRedis();
  const key = REDIS_KEYS.SLACK_AUTO_START_CHANNEL;
  const channelIds = params.enabled ? params.channelIds : [];

  await syncSlackAutoStartChannelCacheBestEffort({
    redis,
    key,
    channelIds,
    onError: (error) => {
      console.warn(
        `[updateBackgroundAgentSettingsCommand] Failed to sync Slack auto-start channel cache: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}

export function normalizeChannelAutoStartInputRows(params: {
  rows?: ChannelAutoStartInputRow[];
  legacyEnabled?: boolean;
  legacyChannel?: string | null;
  legacyInstructions?: string | null;
}): ChannelAutoStartInputRow[] {
  const inputRows =
    params.rows ??
    ((params.legacyEnabled ?? false) ||
    params.legacyChannel ||
    params.legacyInstructions
      ? [
          {
            channelId: null,
            slackChannel: params.legacyChannel ?? null,
            instructions: params.legacyInstructions ?? null,
            launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
            launchCriteria: null,
          },
        ]
      : []);

  return inputRows
    .map((row) => ({
      channelId: normalizeOptionalText(row.channelId),
      slackChannel: normalizeOptionalText(row.slackChannel),
      instructions: normalizeOptionalText(row.instructions),
      launchMode:
        row.launchMode && isChannelAutoStartLaunchMode(row.launchMode)
          ? row.launchMode
          : DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
      launchCriteria: normalizeOptionalText(row.launchCriteria),
    }))
    .filter((row) => row.channelId || row.slackChannel || row.instructions);
}
