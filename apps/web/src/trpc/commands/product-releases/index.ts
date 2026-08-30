import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { db, deploymentSettings, eq } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { Env, isRoomoteCloudEnabled } from '@/lib/server/env';
import { parseProductReleaseHistory } from '@/lib/release-notes';
import { GITHUB_RELEASES_BASE_URL } from '@/lib/release-links';
import {
  compareProductVersions,
  isParsableProductVersion,
  isProductVersionNewer,
  normalizeProductVersion,
  toReleaseTag,
} from '@/lib/product-version';

const DEFAULT_DEPLOYMENT_ID = 'default';
const PRODUCT_CHANGELOG_PATH = resolve(
  process.cwd(),
  '..',
  '..',
  'CHANGELOG.md',
);

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

function toReleaseNotes(
  release: ReturnType<typeof parseProductReleaseHistory>[number],
): ReleaseNotes {
  const tagName = toReleaseTag(release.version);
  return {
    ...release,
    tagName,
    title: `Roomote ${tagName}`,
    htmlUrl: `${GITHUB_RELEASES_BASE_URL}/tag/${tagName}`,
  };
}

function unavailableReleaseNotes(version: string): ReleaseNotes {
  const tagName = toReleaseTag(version);
  return {
    version,
    tagName,
    title: `Roomote ${tagName}`,
    summary: null,
    highlights: [],
    detailsMarkdown: '',
    htmlUrl: `${GITHUB_RELEASES_BASE_URL}/tag/${tagName}`,
  };
}

async function readChangelogReleaseNotes(): Promise<ReleaseNotes[]> {
  try {
    const changelog = await readFile(PRODUCT_CHANGELOG_PATH, 'utf8');
    return parseProductReleaseHistory(changelog).map(toReleaseNotes);
  } catch {
    return [];
  }
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

  const normalizedVersion = normalizeProductVersion(version);
  const releases = await readChangelogReleaseNotes();
  return (
    releases.find((release) => release.version === normalizedVersion) ?? null
  );
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

  const normalizedVersion = normalizeProductVersion(version);
  const releases = (await readChangelogReleaseNotes())
    .filter((release) => compareProductVersions(release.version, version) <= 0)
    .sort((left, right) => compareProductVersions(right.version, left.version));

  if (
    normalizedVersion &&
    !releases.some((release) => release.version === normalizedVersion)
  ) {
    releases.unshift(unavailableReleaseNotes(normalizedVersion));
  }

  return releases;
}
