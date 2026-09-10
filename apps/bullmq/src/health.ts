export function resolveBullMqHealth(redisStatus: string | undefined): {
  status: 'ok' | 'error';
  httpStatus: 200 | 503;
} {
  const healthy = redisStatus === 'ready';

  return {
    status: healthy ? 'ok' : 'error',
    httpStatus: healthy ? 200 : 503,
  };
}

export async function readBullMqQueueHealth<T>(
  redisStatus: string | undefined,
  readQueueCounts: () => Promise<T>,
): Promise<{
  status: 'ok' | 'error';
  httpStatus: 200 | 503;
  queueCounts: T | null;
}> {
  const health = resolveBullMqHealth(redisStatus);

  return {
    ...health,
    queueCounts: health.status === 'ok' ? await readQueueCounts() : null,
  };
}
