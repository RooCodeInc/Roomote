import { getInstallationOctokit } from '@roomote/github';
import { getRedis } from '@roomote/redis';

/** Octokit instance type as returned by getInstallationOctokit. */
export type OctokitClient = Awaited<ReturnType<typeof getInstallationOctokit>>;

/** Redis client type as returned by getRedis. */
export type RedisClient = ReturnType<typeof getRedis>;
