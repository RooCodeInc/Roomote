type RequestEndpointMetricStatusCounts = {
  '2xx': number;
  '3xx': number;
  '4xx': number;
  '5xx': number;
  other: number;
};

type RequestEndpointMetricSnapshot = {
  method: string;
  route: string;
  count: number;
  statusCounts: RequestEndpointMetricStatusCounts;
  avgDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
  lastSeenAt: string;
};

type RequestEndpointMetricsSnapshot = {
  sinceStartedAt: string;
  totalRequests: number;
  trackedEndpointCount: number;
  overflowedUniqueEndpointCount: number;
  overflowedRequestCount: number;
  endpoints: RequestEndpointMetricSnapshot[];
};

type TrackedRequestEndpointMetric = {
  method: string;
  route: string;
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
  lastSeenAtMs: number;
  statusCounts: RequestEndpointMetricStatusCounts;
};

const MAX_TRACKED_ENDPOINTS = 256;
const WARN_COOLDOWN_MS = 60 * 1000;

const trackedEndpoints = new Map<string, TrackedRequestEndpointMetric>();
// Tracks which overflowed endpoint keys we've seen, capped to prevent
// unbounded growth if a runaway client creates many unique paths.
const overflowedEndpointKeys = new Set<string>();
const MAX_OVERFLOW_TRACKING = MAX_TRACKED_ENDPOINTS;

let sinceStartedAtMs = Date.now();
let totalRequests = 0;
let overflowedRequestCount = 0;
let lastOverflowWarnAt = 0;

function createStatusCounts(): RequestEndpointMetricStatusCounts {
  return {
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
    other: 0,
  };
}

function buildEndpointKey(method: string, route: string): string {
  return `${method} ${route}`;
}

// Primary sort: highest request count first.
// Secondary sort: highest average duration first.
// Tertiary: deterministic alphabetical tiebreaker by method, then route.
function sortEndpointSnapshots(
  left: RequestEndpointMetricSnapshot,
  right: RequestEndpointMetricSnapshot,
): number {
  if (left.count !== right.count) {
    return right.count - left.count;
  }

  if (left.avgDurationMs !== right.avgDurationMs) {
    return right.avgDurationMs - left.avgDurationMs;
  }

  if (left.method !== right.method) {
    return left.method.localeCompare(right.method);
  }

  return left.route.localeCompare(right.route);
}

function incrementStatusCount(
  statusCounts: RequestEndpointMetricStatusCounts,
  status: number,
): void {
  if (status >= 200 && status < 300) {
    statusCounts['2xx']++;
    return;
  }

  if (status >= 300 && status < 400) {
    statusCounts['3xx']++;
    return;
  }

  if (status >= 400 && status < 500) {
    statusCounts['4xx']++;
    return;
  }

  if (status >= 500 && status < 600) {
    statusCounts['5xx']++;
    return;
  }

  statusCounts.other++;
}

function maybeWarnAboutOverflow(now: number): void {
  if (overflowedRequestCount === 0) {
    return;
  }

  if (now - lastOverflowWarnAt < WARN_COOLDOWN_MS) {
    return;
  }

  lastOverflowWarnAt = now;

  console.warn(
    `[API Request Endpoint Metrics] tracked=${trackedEndpoints.size} limit=${MAX_TRACKED_ENDPOINTS} overflowedUnique=${overflowedEndpointKeys.size} overflowedRequests=${overflowedRequestCount}`,
  );
}

export function recordRequestEndpointMetric({
  method,
  route,
  status,
  durationMs,
}: {
  method: string;
  route: string;
  status: number;
  durationMs: number;
}): void {
  const now = Date.now();
  totalRequests++;

  const endpointKey = buildEndpointKey(method, route);
  const existingMetric = trackedEndpoints.get(endpointKey);

  if (existingMetric) {
    existingMetric.count++;
    existingMetric.totalDurationMs += durationMs;
    existingMetric.maxDurationMs = Math.max(
      existingMetric.maxDurationMs,
      durationMs,
    );
    existingMetric.lastDurationMs = durationMs;
    existingMetric.lastSeenAtMs = now;
    incrementStatusCount(existingMetric.statusCounts, status);
    return;
  }

  if (trackedEndpoints.size >= MAX_TRACKED_ENDPOINTS) {
    if (overflowedEndpointKeys.size < MAX_OVERFLOW_TRACKING) {
      overflowedEndpointKeys.add(endpointKey);
    }
    overflowedRequestCount++;
    maybeWarnAboutOverflow(now);
    return;
  }

  const statusCounts = createStatusCounts();
  incrementStatusCount(statusCounts, status);

  trackedEndpoints.set(endpointKey, {
    method,
    route,
    count: 1,
    totalDurationMs: durationMs,
    maxDurationMs: durationMs,
    lastDurationMs: durationMs,
    lastSeenAtMs: now,
    statusCounts,
  });
}

export function getRequestEndpointMetricsSnapshot(): RequestEndpointMetricsSnapshot {
  return {
    sinceStartedAt: new Date(sinceStartedAtMs).toISOString(),
    totalRequests,
    trackedEndpointCount: trackedEndpoints.size,
    overflowedUniqueEndpointCount: overflowedEndpointKeys.size,
    overflowedRequestCount,
    endpoints: [...trackedEndpoints.values()]
      .map((metric) => ({
        method: metric.method,
        route: metric.route,
        count: metric.count,
        statusCounts: metric.statusCounts,
        avgDurationMs: Math.round(metric.totalDurationMs / metric.count),
        maxDurationMs: metric.maxDurationMs,
        lastDurationMs: metric.lastDurationMs,
        lastSeenAt: new Date(metric.lastSeenAtMs).toISOString(),
      }))
      .sort(sortEndpointSnapshots),
  };
}

export function resetRequestEndpointMetricsForTests(): void {
  trackedEndpoints.clear();
  overflowedEndpointKeys.clear();
  sinceStartedAtMs = Date.now();
  totalRequests = 0;
  overflowedRequestCount = 0;
  lastOverflowWarnAt = 0;
}
