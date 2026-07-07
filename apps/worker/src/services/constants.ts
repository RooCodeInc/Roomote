import type { ServiceName } from '@roomote/types';

export const SERVICE_CONFIG = {
  redis6: {
    defaultPort: 6379,
    packageName: 'redis-server',
    serverBinary: 'redis-server',
    cliBinary: 'redis-cli',
    dataDir: '/data/services/redis',
  },
  redis7: {
    defaultPort: 6379,
    packageName: 'redis-server',
    serverBinary: 'redis-server',
    cliBinary: 'redis-cli',
    dataDir: '/data/services/redis',
  },
  postgres15: {
    defaultPort: 5432,
    version: '15',
    dataDir: '/data/services/postgres/data',
    logFile: '/data/services/postgres/logfile',
  },
  postgres16: {
    defaultPort: 5432,
    version: '16',
    dataDir: '/data/services/postgres/data',
    logFile: '/data/services/postgres/logfile',
  },
  postgres17: {
    defaultPort: 5432,
    version: '17',
    dataDir: '/data/services/postgres/data',
    logFile: '/data/services/postgres/logfile',
  },
  mysql8: {
    defaultPort: 3306,
    dataDir: '/var/lib/mysql',
    socketPath: '/var/lib/mysql/mysql.sock',
  },
  mariadb10: {
    defaultPort: 3306,
    packageName: 'mariadb-server',
    dataDir: '/data/services/mysql',
    socketPath: '/tmp/mysql.sock',
  },
  clickhouse: {
    defaultPort: 9000,
    httpPort: 8123,
    installDir: '/data/services/clickhouse',
  },
  codeserver: {
    defaultPort: 0, // Legacy compatibility only; unavailable in Roomote.
    logFile: '/tmp/code-server.log',
    userDataDir: '/tmp/codeserver-data',
  },
  aws: {
    defaultPort: 0, // CLI tool, no port needed.
  },
} as const satisfies Record<ServiceName, object>;
