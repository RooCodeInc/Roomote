import { Env } from '@roomote/env';
import { getRedis } from '@roomote/redis';

const CACHE_KEY = 'statuspage:incidents:unresolved';
const NEGATIVE_CACHE_KEY = `${CACHE_KEY}:empty`;
const REFRESH_LOCK_KEY = `${CACHE_KEY}:refresh`;
const FRESH_FOR_MS = 5 * 60 * 1000;
const STALE_FOR_SECONDS = 24 * 60 * 60;
const NEGATIVE_CACHE_FOR_SECONDS = 60;
const REFRESH_LOCK_FOR_SECONDS = 30;

export type StatuspageImpact = 'critical' | 'major' | 'minor' | 'none';

export interface StatuspageIncident {
  id: string;
  name: string;
  status: string;
  impact: StatuspageImpact;
  created_at: string;
  shortlink: string | null;
  url: string | null;
}

interface CachedIncident {
  incident: StatuspageIncident;
  fetchedAt: number;
}

const impactRank: Record<StatuspageImpact, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  none: 3,
};

function isStatuspageImpact(value: unknown): value is StatuspageImpact {
  return (
    value === 'critical' ||
    value === 'major' ||
    value === 'minor' ||
    value === 'none'
  );
}

function parseIncident(value: unknown): StatuspageIncident | null {
  if (!value || typeof value !== 'object') return null;
  const incident = value as Record<string, unknown>;
  if (
    typeof incident.id !== 'string' ||
    typeof incident.name !== 'string' ||
    typeof incident.status !== 'string' ||
    !isStatuspageImpact(incident.impact) ||
    typeof incident.created_at !== 'string'
  ) {
    return null;
  }

  return {
    id: incident.id,
    name: incident.name,
    status: incident.status,
    impact: incident.impact,
    created_at: incident.created_at,
    shortlink:
      typeof incident.shortlink === 'string' ? incident.shortlink : null,
    url: typeof incident.url === 'string' ? incident.url : null,
  };
}

export function selectStatuspageIncident(
  incidents: unknown[],
): StatuspageIncident | null {
  return (
    incidents
      .map(parseIncident)
      .filter((incident): incident is StatuspageIncident => incident !== null)
      .sort(
        (left, right) =>
          impactRank[left.impact] - impactRank[right.impact] ||
          Date.parse(right.created_at) - Date.parse(left.created_at),
      )[0] ?? null
  );
}

export function isStatuspageIncidentsEnabled(): boolean {
  return Boolean(Env.R_STATUSPAGE_INCIDENTS_URL);
}

export function buildStatuspageSlackWarning(
  incident: StatuspageIncident | null,
): string | undefined {
  if (!incident) return undefined;
  const url = incident.shortlink ?? incident.url;
  return `> :warning: Heads up: my humans are ${url ? `<${url}|working on an issue>` : 'working on an issue'} that may affect me.`;
}

function parseCachedIncident(value: string | null): CachedIncident | null {
  if (!value) return null;
  try {
    const cached = JSON.parse(value) as Partial<CachedIncident>;
    const incident = parseIncident(cached.incident);
    return incident && typeof cached.fetchedAt === 'number'
      ? { incident, fetchedAt: cached.fetchedAt }
      : null;
  } catch {
    return null;
  }
}

async function fetchIncident(url: string): Promise<StatuspageIncident | null> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Statuspage returned ${response.status}`);
  const body = (await response.json()) as { incidents?: unknown[] };
  return selectStatuspageIncident(body.incidents ?? []);
}

export async function getStatuspageIncident(): Promise<StatuspageIncident | null> {
  const incidentsUrl = Env.R_STATUSPAGE_INCIDENTS_URL;
  if (!incidentsUrl) return null;

  try {
    const redis = getRedis();
    const cached = parseCachedIncident(await redis.get(CACHE_KEY));
    if (cached && Date.now() - cached.fetchedAt < FRESH_FOR_MS) {
      return cached.incident;
    }

    if (await redis.get(NEGATIVE_CACHE_KEY)) return cached?.incident ?? null;

    const acquiredLock = await redis.set(
      REFRESH_LOCK_KEY,
      '1',
      'EX',
      REFRESH_LOCK_FOR_SECONDS,
      'NX',
    );
    if (!acquiredLock) return cached?.incident ?? null;

    try {
      const incident = await fetchIncident(incidentsUrl);
      if (!incident) {
        await redis.del(CACHE_KEY);
        await redis.set(
          NEGATIVE_CACHE_KEY,
          '1',
          'EX',
          NEGATIVE_CACHE_FOR_SECONDS,
        );
        return null;
      }

      await redis.set(
        CACHE_KEY,
        JSON.stringify({ incident, fetchedAt: Date.now() }),
        'EX',
        STALE_FOR_SECONDS,
      );
      await redis.del(NEGATIVE_CACHE_KEY);
      return incident;
    } catch (error) {
      console.warn(
        `[Statuspage] Failed to refresh unresolved incidents: ${error instanceof Error ? error.message : String(error)}`,
      );
      return cached?.incident ?? null;
    } finally {
      await redis.del(REFRESH_LOCK_KEY).catch(() => undefined);
    }
  } catch (error) {
    console.warn(
      `[Statuspage] Incident lookup unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
