export type LongLivedProxyStreamTrackingContext = {
  route: string;
  method: string;
  path: string;
  requestId?: string;
};

type ActiveLongLivedProxyStream = LongLivedProxyStreamTrackingContext & {
  id: number;
  startedAt: number;
};

type RouteCounts = Record<string, number>;

type LongLivedProxyStreamHealthSnapshot = {
  activeCount: number;
  oldestAgeMs: number | null;
  countsByAge: {
    atLeast1m: number;
    atLeast5m: number;
    atLeast15m: number;
  };
  byRoute: RouteCounts;
  warningActive: boolean;
  warningThresholds: {
    activeCount: number;
    oldestAgeMs: number;
  };
};

const ACTIVE_STREAM_WARN_THRESHOLD = 20;
const OLDEST_STREAM_WARN_THRESHOLD_MS = 10 * 60 * 1000;
const WARN_COOLDOWN_MS = 60 * 1000;
const WARN_SAMPLE_LIMIT = 3;

const activeStreams = new Map<number, ActiveLongLivedProxyStream>();
let nextStreamId = 1;
let warningInterval: NodeJS.Timeout | null = null;
let lastWarnAt = 0;

function buildRouteCounts(now: number): {
  byRoute: RouteCounts;
  oldestAgeMs: number | null;
  countsByAge: LongLivedProxyStreamHealthSnapshot['countsByAge'];
} {
  const byRoute = new Map<string, number>();
  const countsByAge = {
    atLeast1m: 0,
    atLeast5m: 0,
    atLeast15m: 0,
  };
  let oldestAgeMs: number | null = null;

  for (const stream of activeStreams.values()) {
    const ageMs = Math.max(0, now - stream.startedAt);

    byRoute.set(stream.route, (byRoute.get(stream.route) ?? 0) + 1);

    if (ageMs >= 60_000) {
      countsByAge.atLeast1m++;
    }

    if (ageMs >= 5 * 60_000) {
      countsByAge.atLeast5m++;
    }

    if (ageMs >= 15 * 60_000) {
      countsByAge.atLeast15m++;
    }

    oldestAgeMs = oldestAgeMs === null ? ageMs : Math.max(oldestAgeMs, ageMs);
  }

  return {
    byRoute: Object.fromEntries(
      [...byRoute.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    oldestAgeMs,
    countsByAge,
  };
}

function getOldestSamples(now: number): string {
  return [...activeStreams.values()]
    .sort((left, right) => left.startedAt - right.startedAt)
    .slice(0, WARN_SAMPLE_LIMIT)
    .map((stream) => {
      const ageMs = Math.max(0, now - stream.startedAt);
      const requestIdSuffix = stream.requestId
        ? ` requestId=${stream.requestId}`
        : '';

      return `${stream.route} ${stream.method} ${stream.path} ageMs=${ageMs}${requestIdSuffix}`;
    })
    .join(' | ');
}

function startWarningInterval(): void {
  if (warningInterval) {
    return;
  }

  warningInterval = setInterval(() => {
    checkWarningInterval();
  }, WARN_COOLDOWN_MS);
  warningInterval.unref?.();
}

function stopWarningInterval(): void {
  if (!warningInterval) {
    return;
  }

  clearInterval(warningInterval);
  warningInterval = null;
}

function checkWarningInterval(): void {
  if (activeStreams.size === 0) {
    stopWarningInterval();
    return;
  }

  maybeWarnAboutLongLivedProxyStreams();
}

function shouldWarn(snapshot: LongLivedProxyStreamHealthSnapshot): boolean {
  return (
    snapshot.activeCount >= ACTIVE_STREAM_WARN_THRESHOLD ||
    (snapshot.oldestAgeMs ?? 0) >= OLDEST_STREAM_WARN_THRESHOLD_MS
  );
}

function maybeWarnAboutLongLivedProxyStreams(now = Date.now()): void {
  const snapshot = getLongLivedProxyStreamHealthSnapshot(now);

  if (!snapshot.warningActive) {
    return;
  }

  if (now - lastWarnAt < WARN_COOLDOWN_MS) {
    return;
  }

  lastWarnAt = now;

  const oldestSamples = getOldestSamples(now);
  const sampleSuffix = oldestSamples
    ? ` oldest=${JSON.stringify(oldestSamples)}`
    : '';

  console.warn(
    `[API Long-Lived Proxy Streams] active=${snapshot.activeCount} oldestAgeMs=${snapshot.oldestAgeMs ?? 0} atLeast1m=${snapshot.countsByAge.atLeast1m} atLeast5m=${snapshot.countsByAge.atLeast5m} atLeast15m=${snapshot.countsByAge.atLeast15m} byRoute=${JSON.stringify(snapshot.byRoute)}${sampleSuffix}`,
  );
}

export function registerLongLivedProxyStream(
  context: LongLivedProxyStreamTrackingContext,
): () => void {
  const id = nextStreamId++;

  activeStreams.set(id, {
    id,
    startedAt: Date.now(),
    ...context,
  });

  // Always start the interval while streams are active so we can detect
  // when thresholds are eventually crossed as streams age.
  startWarningInterval();
  maybeWarnAboutLongLivedProxyStreams();

  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;
    activeStreams.delete(id);

    if (activeStreams.size === 0) {
      stopWarningInterval();
    }
  };
}

export function getLongLivedProxyStreamHealthSnapshot(
  now = Date.now(),
): LongLivedProxyStreamHealthSnapshot {
  const { byRoute, oldestAgeMs, countsByAge } = buildRouteCounts(now);
  const snapshot: LongLivedProxyStreamHealthSnapshot = {
    activeCount: activeStreams.size,
    oldestAgeMs,
    countsByAge,
    byRoute,
    warningActive: false,
    warningThresholds: {
      activeCount: ACTIVE_STREAM_WARN_THRESHOLD,
      oldestAgeMs: OLDEST_STREAM_WARN_THRESHOLD_MS,
    },
  };

  snapshot.warningActive = shouldWarn(snapshot);

  return snapshot;
}

export function resetLongLivedProxyStreamRegistryForTests(): void {
  activeStreams.clear();
  nextStreamId = 1;
  lastWarnAt = 0;

  if (warningInterval) {
    clearInterval(warningInterval);
    warningInterval = null;
  }
}
