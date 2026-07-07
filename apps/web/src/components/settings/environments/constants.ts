import type { ServiceName } from '@roomote/types';

export const serviceLabels: Record<ServiceName, string> = {
  redis6: 'Redis 6',
  redis7: 'Redis 7',
  postgres15: 'PostgreSQL 15',
  postgres16: 'PostgreSQL 16',
  postgres17: 'PostgreSQL 17',
  mysql8: 'MySQL 8',
  mariadb10: 'MariaDB 10',
  clickhouse: 'ClickHouse',
  codeserver: 'Code Server',
  aws: 'AWS CLI',
};
