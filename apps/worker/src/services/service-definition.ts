import type { ServiceName } from '@roomote/types';

import type { ServiceDefinition } from './types';
import { createRedisService } from './redis';
import { createPostgresService } from './postgres';
import { createMysqlService } from './mysql';
import { createMariadbService } from './mariadb';
import { createClickhouseService } from './clickhouse';
import { createAwsService } from './aws';

/**
 * Creates a service definition for the given service name.
 */
export function getServiceDefinition(
  serviceName: ServiceName,
): ServiceDefinition {
  switch (serviceName) {
    case 'redis6':
      return createRedisService('6');
    case 'redis7':
      return createRedisService('7');
    case 'postgres15':
      return createPostgresService('15');
    case 'postgres16':
      return createPostgresService('16');
    case 'postgres17':
      return createPostgresService('17');
    case 'mysql8':
      return createMysqlService('8');
    case 'mariadb10':
      return createMariadbService('10');
    case 'clickhouse':
      return createClickhouseService();
    case 'codeserver':
      throw new Error('Code Server service is unavailable in Roomote');
    case 'aws':
      return createAwsService();
    default: {
      const _exhaustiveCheck: never = serviceName;
      throw new Error(`Unknown service: ${serviceName}`);
    }
  }
}
