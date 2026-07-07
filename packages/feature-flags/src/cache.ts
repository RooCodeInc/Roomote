import { Redis } from 'ioredis';
import { normalizeMetadataRecord } from './index';
import type { MetadataRecord } from './types';

const CACHE_TTL_SECONDS = 300; // 5 minutes
const CACHE_KEY_PREFIX = 'feature-flags:metadata';

export class MetadataCache {
  constructor(private redis: Redis) {}

  /**
   * Get cached metadata for a user or deployment
   */
  async get(
    entityType: 'user' | 'deployment',
    entityId: string,
  ): Promise<MetadataRecord | null> {
    try {
      const key = this.getCacheKey(entityType, entityId);
      const cached = await this.redis.get(key);

      if (!cached) {
        return null;
      }

      return normalizeMetadataRecord(JSON.parse(cached));
    } catch (error) {
      console.error(
        `[MetadataCache] Error reading from cache: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Set cached metadata for a user or deployment
   */
  async set(
    entityType: 'user' | 'deployment',
    entityId: string,
    metadata: MetadataRecord,
  ): Promise<void> {
    try {
      const key = this.getCacheKey(entityType, entityId);
      await this.redis.set(
        key,
        JSON.stringify(metadata),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      console.error(
        `[MetadataCache] Error writing to cache: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Invalidate cached metadata for a user or deployment
   */
  async invalidate(
    entityType: 'user' | 'deployment',
    entityId: string,
  ): Promise<void> {
    try {
      const key = this.getCacheKey(entityType, entityId);
      await this.redis.del(key);
    } catch (error) {
      console.error(
        `[MetadataCache] Error invalidating cache: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Generate cache key for an entity
   */
  private getCacheKey(
    entityType: 'user' | 'deployment',
    entityId: string,
  ): string {
    return `${CACHE_KEY_PREFIX}:${entityType}:${entityId}`;
  }
}
