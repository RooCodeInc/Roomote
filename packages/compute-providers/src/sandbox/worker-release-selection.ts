import path from 'node:path';
import { resolveAppEnv } from '@roomote/env';

export type WorkerReleaseChannel = 'stable' | 'preview';

export interface WorkerReleaseSelection {
  channel: WorkerReleaseChannel;
  version?: string;
}

export interface ParsedWorkerReleaseTag {
  channel: WorkerReleaseChannel;
  tag: string;
  version: string;
}

export interface GitHubWorkerReleaseListEntry {
  tag_name: string;
  prerelease?: boolean;
  draft?: boolean;
}

interface ParsedComparableWorkerReleaseVersion {
  major: number;
  minor: number;
  patch: number;
  prereleaseLabel: string | null;
  prereleaseNumber: number | null;
}

export const DEFAULT_WORKER_RELEASE_CHANNEL: WorkerReleaseChannel = 'stable';

const WORKER_RELEASE_TAG_PREFIXES: Record<WorkerReleaseChannel, string> = {
  stable: 'worker-v',
  preview: 'worker-preview-v',
};

export function isWorkerReleaseChannel(
  value: string,
): value is WorkerReleaseChannel {
  return value === 'stable' || value === 'preview';
}

export function buildWorkerReleaseTag(
  version: string,
  channel: WorkerReleaseChannel = DEFAULT_WORKER_RELEASE_CHANNEL,
): string {
  return `${WORKER_RELEASE_TAG_PREFIXES[channel]}${version}`;
}

export function getWorkerReleaseTagPrefix(
  channel: WorkerReleaseChannel = DEFAULT_WORKER_RELEASE_CHANNEL,
): string {
  return WORKER_RELEASE_TAG_PREFIXES[channel];
}

export function parseWorkerReleaseTag(
  tag: string,
): ParsedWorkerReleaseTag | null {
  for (const channel of Object.keys(
    WORKER_RELEASE_TAG_PREFIXES,
  ) as WorkerReleaseChannel[]) {
    const prefix = WORKER_RELEASE_TAG_PREFIXES[channel];

    if (!tag.startsWith(prefix)) {
      continue;
    }

    const version = tag.slice(prefix.length);

    if (!version) {
      return null;
    }

    return { channel, tag, version };
  }

  return null;
}

function parseComparableWorkerReleaseVersion(
  version: string,
): ParsedComparableWorkerReleaseVersion | null {
  const match = version.match(
    /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<label>[a-z]+)\.(?<number>\d+))?$/,
  );

  if (!match?.groups) {
    return null;
  }

  const { major, minor, patch, label, number } = match.groups;

  if (!major || !minor || !patch) {
    return null;
  }

  const prereleaseNumber = number ? Number.parseInt(number, 10) : null;

  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prereleaseLabel: label ?? null,
    prereleaseNumber:
      prereleaseNumber !== null && Number.isNaN(prereleaseNumber)
        ? null
        : prereleaseNumber,
  };
}

export function compareParsedWorkerReleaseTags(
  left: ParsedWorkerReleaseTag,
  right: ParsedWorkerReleaseTag,
): number {
  const leftVersion = parseComparableWorkerReleaseVersion(left.version);
  const rightVersion = parseComparableWorkerReleaseVersion(right.version);

  if (!leftVersion && !rightVersion) {
    return 0;
  }

  if (!leftVersion) {
    return -1;
  }

  if (!rightVersion) {
    return 1;
  }

  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major - rightVersion.major;
  }

  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor - rightVersion.minor;
  }

  if (leftVersion.patch !== rightVersion.patch) {
    return leftVersion.patch - rightVersion.patch;
  }

  if (leftVersion.prereleaseLabel === null && rightVersion.prereleaseLabel) {
    return 1;
  }

  if (leftVersion.prereleaseLabel && rightVersion.prereleaseLabel === null) {
    return -1;
  }

  if (leftVersion.prereleaseLabel !== rightVersion.prereleaseLabel) {
    return (leftVersion.prereleaseLabel ?? '').localeCompare(
      rightVersion.prereleaseLabel ?? '',
    );
  }

  return (
    (leftVersion.prereleaseNumber ?? 0) - (rightVersion.prereleaseNumber ?? 0)
  );
}

export function selectLatestWorkerReleaseFromList(
  releases: ReadonlyArray<GitHubWorkerReleaseListEntry>,
  channel: WorkerReleaseChannel = DEFAULT_WORKER_RELEASE_CHANNEL,
): ParsedWorkerReleaseTag | null {
  const tags: string[] = [];

  for (const release of releases) {
    if (release.draft) {
      continue;
    }

    if (channel === 'stable' && release.prerelease) {
      continue;
    }

    tags.push(release.tag_name);
  }

  return selectLatestWorkerReleaseFromTags(tags, channel);
}

export function selectLatestWorkerReleaseFromTags(
  tags: ReadonlyArray<string>,
  channel: WorkerReleaseChannel = DEFAULT_WORKER_RELEASE_CHANNEL,
): ParsedWorkerReleaseTag | null {
  let latest: ParsedWorkerReleaseTag | null = null;

  for (const tag of tags) {
    const parsed = parseWorkerReleaseTag(tag);

    if (!parsed || parsed.channel !== channel) {
      continue;
    }

    if (!latest || compareParsedWorkerReleaseTags(parsed, latest) > 0) {
      latest = parsed;
    }
  }

  return latest;
}

export function parseWorkerReleaseTagFromArchivePath(
  archivePath: string,
): ParsedWorkerReleaseTag | null {
  const filename = path.basename(archivePath);

  if (!filename.endsWith('.tar.gz')) {
    return null;
  }

  return parseWorkerReleaseTag(filename.slice(0, -'.tar.gz'.length));
}

export function extractWorkerReleaseTagFromArchivePath(
  archivePath: string,
): string {
  const parsed = parseWorkerReleaseTagFromArchivePath(archivePath);

  if (!parsed) {
    throw new Error(
      `Invalid worker release archive filename: ${path.basename(archivePath)}. Expected format: worker-v<version>.tar.gz or worker-preview-v<version>.tar.gz`,
    );
  }

  return parsed.tag;
}

export function extractWorkerReleaseVersionFromArchivePath(
  archivePath: string,
): string {
  return parseWorkerReleaseTag(
    extractWorkerReleaseTagFromArchivePath(archivePath),
  )!.version;
}

export function resolveWorkerReleaseSelectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkerReleaseSelection {
  const rawChannel = env.R_WORKER_RELEASE_CHANNEL?.trim();
  const rawVersion = env.R_WORKER_RELEASE_VERSION?.trim();
  let channel: WorkerReleaseChannel =
    resolveAppEnv(env) === 'preview'
      ? 'preview'
      : DEFAULT_WORKER_RELEASE_CHANNEL;

  if (rawChannel) {
    if (!isWorkerReleaseChannel(rawChannel)) {
      throw new Error(
        `Unsupported R_WORKER_RELEASE_CHANNEL: ${rawChannel}. Expected "stable" or "preview".`,
      );
    }

    channel = rawChannel as WorkerReleaseChannel;
  }

  return {
    channel,
    ...(rawVersion ? { version: rawVersion } : {}),
  };
}

export function normalizeWorkerReleaseSelection(
  selection?: Partial<WorkerReleaseSelection>,
  env: NodeJS.ProcessEnv = process.env,
): WorkerReleaseSelection {
  const envSelection = resolveWorkerReleaseSelectionFromEnv(env);

  if (!selection) {
    return envSelection;
  }

  return {
    channel: selection.channel ?? envSelection.channel,
    ...((selection.version ?? envSelection.version)
      ? { version: selection.version ?? envSelection.version }
      : {}),
  };
}

export function getWorkerReleaseSelectionCacheKey(
  selection: WorkerReleaseSelection,
): string {
  return `${selection.channel}:${selection.version ?? '__latest__'}`;
}
