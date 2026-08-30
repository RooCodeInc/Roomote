import { execFileSync } from 'node:child_process';

import { db, deploymentSettings, eq } from '@roomote/db/server';
import {
  getRedis,
  REDIS_KEYS,
  RELEASE_NOTES_CACHE_TTL_SECONDS,
  RELEASE_NOTES_NEGATIVE_CACHE_TTL_SECONDS,
} from '@roomote/redis';

import type { UserAuthSuccess } from '@/types';
import { Env, isRoomoteCloudEnabled } from '@/lib/server/env';
import { parseReleaseBody } from '@/lib/release-notes';
import {
  GITHUB_RELEASES_BASE_URL,
  ROOMOTE_GITHUB_REPO,
} from '@/lib/release-links';
import {
  compareProductVersions,
  isParsableProductVersion,
  isProductVersionNewer,
  normalizeProductVersion,
  toReleaseTag,
} from '@/lib/product-version';

const DEFAULT_DEPLOYMENT_ID = 'default';
const RELEASE_HISTORY_PAGE_SIZE = 100;

const PRODUCT_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/i;

type ReleaseStatus = {
  runningVersion: string | null;
  displayVersion: string | null;
  latestKnownVersion: string | null;
  latestVersionCheckedAt: string | null;
  updateAvailable: boolean;
};

type ReleaseNotes = {
  version: string;
  tagName: string;
  title: string;
  summary: string | null;
  highlights: string[];
  detailsMarkdown: string;
  htmlUrl: string;
};

function getRunningVersion(): string | null {
  // Channel builds bake RELEASE_VERSION as develop-<sha>/main-<sha>, which the
  // product-version comparator cannot order. Prefer the product (changelog)
  // version baked alongside it so release notices work on those deployments.
  return (
    normalizeProductVersion(Env.RELEASE_PRODUCT_VERSION) ??
    normalizeProductVersion(Env.RELEASE_VERSION)
  );
}

function getDisplayVersion(): string | null {
  const releaseVersion = Env.RELEASE_VERSION?.trim();
  if (releaseVersion) {
    if (isParsableProductVersion(releaseVersion)) {
      return toReleaseTag(releaseVersion);
    }

    // Channel builds include their commit after the final dash.
    const commitFromRelease = releaseVersion.match(/[a-f0-9]{7,40}$/i)?.[0];
    if (commitFromRelease) {
      return commitFromRelease;
    }
  }

  // Channel image builds receive their commit from GitHub Actions. A source
  // checkout (the normal development path) has neither build metadata value,
  // so resolve HEAD directly instead.
  const commit = process.env.GITHUB_SHA?.trim() || getLocalGitCommit();
  if (commit) {
    return commit;
  }

  const productVersion = normalizeProductVersion(Env.RELEASE_PRODUCT_VERSION);
  if (productVersion) {
    return toReleaseTag(productVersion);
  }

  // Keep a useful identifier for deployments that do not expose commit
  // metadata (for example a locally built self-hosted image).
  return releaseVersion ?? null;
}

function getLocalGitCommit(): string | null {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return commit || null;
  } catch {
    // Release images do not include .git. They always have RELEASE_VERSION,
    // but keep this fallback safe for custom and detached deployments.
    return null;
  }
}

function canSeeUpdateStatus(auth: UserAuthSuccess): boolean {
  return auth.isAdmin && !isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED);
}

function releaseNotesCacheKey(version: string): string {
  return `${REDIS_KEYS.RELEASE_NOTES}:${normalizeProductVersion(version) ?? version}`;
}

function releaseHistoryCacheKey(version: string): string {
  return `${releaseNotesCacheKey(version)}:history`;
}

export async function getReleaseStatusCommand(
  auth: UserAuthSuccess,
): Promise<ReleaseStatus> {
  const runningVersion = getRunningVersion();
  const displayVersion = getDisplayVersion();

  if (!canSeeUpdateStatus(auth)) {
    return {
      runningVersion,
      displayVersion,
      latestKnownVersion: null,
      latestVersionCheckedAt: null,
      updateAvailable: false,
    };
  }

  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      latestKnownVersion: true,
      latestVersionCheckedAt: true,
    },
  });

  const latestKnownVersion = normalizeProductVersion(
    settings?.latestKnownVersion,
  );
  const latestVersionCheckedAt =
    settings?.latestVersionCheckedAt?.toISOString() ?? null;

  return {
    runningVersion,
    displayVersion,
    latestKnownVersion,
    latestVersionCheckedAt,
    updateAvailable: isProductVersionNewer(latestKnownVersion, runningVersion),
  };
}

function isAllowedNotesVersion(
  auth: UserAuthSuccess,
  requestedVersion: string,
  status: ReleaseStatus,
): boolean {
  const requested = normalizeProductVersion(requestedVersion);
  if (!requested) {
    return false;
  }

  const running = normalizeProductVersion(status.runningVersion);
  if (running && requested === running) {
    return true;
  }

  if (
    canSeeUpdateStatus(auth) &&
    status.latestKnownVersion &&
    requested === status.latestKnownVersion
  ) {
    return true;
  }

  return false;
}

type CachedNotesPayload =
  | { kind: 'notes'; notes: ReleaseNotes }
  | { kind: 'missing' };

type CachedHistoryPayload = {
  kind: 'history';
  releases: ReleaseNotes[];
};

async function readCachedNotes(
  version: string,
): Promise<CachedNotesPayload | null> {
  try {
    const raw = await getRedis().get(releaseNotesCacheKey(version));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as CachedNotesPayload;
  } catch {
    return null;
  }
}

async function writeCachedNotes(
  version: string,
  payload: CachedNotesPayload,
  ttlSeconds: number,
): Promise<void> {
  try {
    await getRedis().set(
      releaseNotesCacheKey(version),
      JSON.stringify(payload),
      'EX',
      ttlSeconds,
    );
  } catch {
    // Best-effort cache; callers still return the fetched payload.
  }
}

async function readCachedHistory(
  version: string,
): Promise<ReleaseNotes[] | null> {
  try {
    const raw = await getRedis().get(releaseHistoryCacheKey(version));
    if (!raw) {
      return null;
    }
    const payload = JSON.parse(raw) as CachedHistoryPayload;
    return payload.kind === 'history' ? payload.releases : null;
  } catch {
    return null;
  }
}

async function writeCachedHistory(
  version: string,
  releases: ReleaseNotes[],
  ttlSeconds: number,
): Promise<void> {
  try {
    await getRedis().set(
      releaseHistoryCacheKey(version),
      JSON.stringify({
        kind: 'history',
        releases,
      } satisfies CachedHistoryPayload),
      'EX',
      ttlSeconds,
    );
  } catch {
    // Best-effort cache; callers still return the fetched payload.
  }
}

type GithubReleasePayload = {
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  html_url?: string;
  draft?: boolean;
};

function parseGithubRelease(
  payload: GithubReleasePayload,
): ReleaseNotes | null {
  const version = normalizeProductVersion(payload.tag_name);
  if (!version || !PRODUCT_VERSION_PATTERN.test(version) || payload.draft) {
    return null;
  }

  const tagName = toReleaseTag(version);
  const body = typeof payload.body === 'string' ? payload.body : '';
  const parsed = parseReleaseBody(body);

  return {
    version,
    tagName,
    title:
      (typeof payload.name === 'string' && payload.name.trim()) ||
      `Roomote ${tagName}`,
    summary: parsed.summary,
    highlights: parsed.highlights,
    detailsMarkdown: parsed.detailsMarkdown,
    htmlUrl:
      (typeof payload.html_url === 'string' && payload.html_url) ||
      `${GITHUB_RELEASES_BASE_URL}/tag/${tagName}`,
  };
}

async function fetchGithubReleaseNotes(
  version: string,
): Promise<ReleaseNotes | null> {
  const bare = normalizeProductVersion(version);
  if (!bare) {
    return null;
  }

  const tagName = toReleaseTag(bare);
  const fallbackUrl = `${GITHUB_RELEASES_BASE_URL}/tag/${tagName}`;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${ROOMOTE_GITHUB_REPO}/releases/tags/${tagName}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Roomote',
        },
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      console.warn(
        `[releases] GitHub release fetch failed for ${tagName}: ${response.status}`,
      );
      return null;
    }

    const payload = (await response.json()) as GithubReleasePayload;
    return (
      parseGithubRelease({
        ...payload,
        tag_name: payload.tag_name || tagName,
        html_url: payload.html_url || fallbackUrl,
      }) ?? null
    );
  } catch (error) {
    console.warn(
      `[releases] GitHub release fetch failed for ${tagName}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function fetchGithubReleaseHistory(
  version: string,
): Promise<ReleaseNotes[] | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${ROOMOTE_GITHUB_REPO}/releases?per_page=${RELEASE_HISTORY_PAGE_SIZE}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Roomote',
        },
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!response.ok) {
      console.warn(
        `[releases] GitHub release history fetch failed: ${response.status}`,
      );
      return null;
    }

    const payload = (await response.json()) as GithubReleasePayload[];
    const releases = new Map<string, ReleaseNotes>();
    for (const item of payload) {
      const release = parseGithubRelease(item);
      if (
        release &&
        compareProductVersions(release.version, version) <= 0 &&
        !releases.has(release.version)
      ) {
        releases.set(release.version, release);
      }
    }

    return [...releases.values()].sort((left, right) =>
      compareProductVersions(right.version, left.version),
    );
  } catch (error) {
    console.warn(
      '[releases] GitHub release history fetch failed:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function getReleaseNotesForVersion(
  version: string,
): Promise<ReleaseNotes | null> {
  const cached = await readCachedNotes(version);
  if (cached?.kind === 'notes') {
    return cached.notes;
  }
  if (cached?.kind === 'missing') {
    return null;
  }

  const notes = await fetchGithubReleaseNotes(version);
  if (notes) {
    await writeCachedNotes(
      version,
      { kind: 'notes', notes },
      RELEASE_NOTES_CACHE_TTL_SECONDS,
    );
    return notes;
  }

  await writeCachedNotes(
    version,
    { kind: 'missing' },
    RELEASE_NOTES_NEGATIVE_CACHE_TTL_SECONDS,
  );
  return null;
}

export async function getReleaseNotesCommand(
  auth: UserAuthSuccess,
  input: { version: string },
): Promise<ReleaseNotes | null> {
  const version = input.version.trim();
  if (!PRODUCT_VERSION_PATTERN.test(version)) {
    return null;
  }

  const status = await getReleaseStatusCommand(auth);
  if (!isAllowedNotesVersion(auth, version, status)) {
    return null;
  }

  return getReleaseNotesForVersion(version);
}

export async function getReleaseHistoryCommand(
  auth: UserAuthSuccess,
  input: { version: string },
): Promise<ReleaseNotes[]> {
  const version = input.version.trim();
  if (!PRODUCT_VERSION_PATTERN.test(version)) {
    return [];
  }

  const status = await getReleaseStatusCommand(auth);
  if (!isAllowedNotesVersion(auth, version, status)) {
    return [];
  }

  const cached = await readCachedHistory(version);
  if (cached) {
    return cached;
  }

  const listedReleases = await fetchGithubReleaseHistory(version);
  const releases = listedReleases ?? [];
  const normalizedVersion = normalizeProductVersion(version);

  if (
    normalizedVersion &&
    !releases.some((release) => release.version === normalizedVersion)
  ) {
    const currentRelease = await getReleaseNotesForVersion(version);
    if (currentRelease) {
      releases.push(currentRelease);
      releases.sort((left, right) =>
        compareProductVersions(right.version, left.version),
      );
    }
  }

  await writeCachedHistory(
    version,
    releases,
    releases.length > 0
      ? RELEASE_NOTES_CACHE_TTL_SECONDS
      : RELEASE_NOTES_NEGATIVE_CACHE_TTL_SECONDS,
  );
  return releases;
}
