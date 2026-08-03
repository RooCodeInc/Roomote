import { Redis } from 'ioredis';
import { normalizeMetadataRecord } from './index';
import type { MetadataRecord } from './types';

const CACHE_TTL_SECONDS = 300;
const CACHE_KEY_PREFIX = 'feature-flags:metadata';

export class MetadataCache {
  constructor(private redis: Redis) {}

  async get(
    entityType: 'user' | 'deployment',
    entityId: string,
  ): Promise<MetadataRecord | null> {
    try {
      const cached = await this.redis.get(
        this.getCacheKey(entityType, entityId),
      );
      return cached ? normalizeMetadataRecord(JSON.parse(cached)) : null;
    } catch (error) {
      console.error(
        `[MetadataCache] Error reading from cache: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async set(
    entityType: 'user' | 'deployment',
    entityId: string,
    metadata: MetadataRecord,
  ): Promise<void> {
    try {
      await this.redis.set(
        this.getCacheKey(entityType, entityId),
        JSON.stringify(metadata),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      console.error(
        `[MetadataCache] Error writing to cache: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async invalidate(
    entityType: 'user' | 'deployment',
    entityId: string,
  ): Promise<void> {
    try {
      await this.redis.del(this.getCacheKey(entityType, entityId));
    } catch (error) {
      console.error(
        `[MetadataCache] Error invalidating cache: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getCacheKey(
    entityType: 'user' | 'deployment',
    entityId: string,
  ): string {
    return `${CACHE_KEY_PREFIX}:${entityType}:${entityId}`;
  }
}
