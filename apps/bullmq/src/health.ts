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
