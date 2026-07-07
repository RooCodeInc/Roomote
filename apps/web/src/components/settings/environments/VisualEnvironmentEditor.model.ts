import {
  COMMAND_DEFAULT_TIMEOUT,
  type Command,
  type EnvironmentConfig,
  type EnvironmentRepositoryConfig,
  type NamedPort,
  type ServiceConfig,
  type ServiceName,
} from '@roomote/types';

import { serviceLabels } from './constants';

export type KeyValueRow = {
  id: string;
  key: string;
  value: string;
};

export type CommandRow = {
  id: string;
  name: string;
  run: string;
  timeout: string;
  detached: boolean;
  continue_on_error: boolean;
  working_dir?: string;
  cwd?: string;
  logfile?: string;
  retries?: number;
  env?: Record<string, string>;
};

export type PortRow = {
  id: string;
  name: string;
  port: string;
  initial_path: string;
  primary: boolean;
  unauthenticated?: boolean;
  proxied?: boolean;
  subdomain?: string;
  wildcard_prefix?: boolean;
  auth_bypass_paths?: string[];
};

type ServiceGroup = {
  id: string;
  label: string;
  services: ServiceName[];
};

export type RepositoryOption = {
  id: string;
  fullName: string;
};

export const SERVICE_GROUPS: ServiceGroup[] = [
  { id: 'aws', label: 'AWS CLI', services: ['aws'] },
  { id: 'clickhouse', label: 'ClickHouse', services: ['clickhouse'] },
  { id: 'mariadb', label: 'MariaDB', services: ['mariadb10'] },
  { id: 'mysql', label: 'MySQL', services: ['mysql8'] },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    services: ['postgres15', 'postgres16', 'postgres17'],
  },
  { id: 'redis', label: 'Redis', services: ['redis6', 'redis7'] },
];

export const SORTED_SERVICE_GROUPS = [...SERVICE_GROUPS].sort((left, right) =>
  left.label.localeCompare(right.label),
);

export function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

export function trimToUndefined(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function optionalTextToUndefined(value: string) {
  return value.trim().length > 0 ? value : undefined;
}

export function updateEnvironmentConfig(
  config: EnvironmentConfig,
  mutate: (draft: EnvironmentConfig) => void,
) {
  const next = structuredClone(config);
  mutate(next);
  return next;
}

export function getServiceName(service: ServiceConfig) {
  return typeof service === 'string' ? service : service.name;
}

export function getServiceVersionLabel(
  group: ServiceGroup,
  serviceName: ServiceName,
) {
  return serviceLabels[serviceName].replace(`${group.label} `, '');
}

export function normalizeKeyValueRecord(
  rows: KeyValueRow[],
  { allowEmptyValues = false }: { allowEmptyValues?: boolean } = {},
) {
  const entries = rows
    .map((row) => [row.key.trim(), row.value] as const)
    .filter(
      ([key, value]) =>
        key.length > 0 && (allowEmptyValues || value.trim().length > 0),
    );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function recordToRows(record?: Record<string, string>): KeyValueRow[] {
  if (!record) {
    return [];
  }

  return Object.entries(record).map(([key, value]) => ({
    id: makeId(),
    key,
    value,
  }));
}

export function serializeKeyValueRecord(record?: Record<string, string>) {
  return JSON.stringify(record ?? {});
}

export function commandsToRows(commands?: Command[]): CommandRow[] {
  if (!commands) {
    return [];
  }

  return commands.map((command) => ({
    id: makeId(),
    name: command.name,
    run: command.run,
    timeout: String(command.timeout ?? COMMAND_DEFAULT_TIMEOUT),
    detached: Boolean(command.detached),
    continue_on_error: Boolean(command.continue_on_error),
    working_dir: command.working_dir,
    cwd: command.cwd,
    logfile: command.logfile,
    retries: command.retries,
    env: command.env,
  }));
}

export function normalizeCommands(rows: CommandRow[]) {
  const commands = rows
    .map((row) => {
      const name = row.name.trim();
      const run = row.run.trim();

      if (!name && !run) {
        return null;
      }

      const timeoutValue = Number(row.timeout);
      const normalized: Command = {
        name,
        run,
        timeout:
          Number.isFinite(timeoutValue) && timeoutValue > 0
            ? timeoutValue
            : COMMAND_DEFAULT_TIMEOUT,
        continue_on_error: row.continue_on_error,
        ...(row.detached ? { detached: true } : {}),
        ...(trimToUndefined(row.working_dir ?? '')
          ? { working_dir: trimToUndefined(row.working_dir ?? '') }
          : {}),
        ...(trimToUndefined(row.cwd ?? '')
          ? { cwd: trimToUndefined(row.cwd ?? '') }
          : {}),
        ...(trimToUndefined(row.logfile ?? '')
          ? { logfile: trimToUndefined(row.logfile ?? '') }
          : {}),
        ...(row.retries !== undefined ? { retries: row.retries } : {}),
        ...(row.env && Object.keys(row.env).length > 0 ? { env: row.env } : {}),
      };

      return normalized;
    })
    .filter((command): command is Command => Boolean(command));

  return commands.length > 0 ? commands : undefined;
}

export function serializeCommands(commands?: Command[]) {
  return JSON.stringify(commands ?? []);
}

export function portsToRows(ports?: NamedPort[]): PortRow[] {
  if (!ports) {
    return [];
  }

  return ports.map((port) => ({
    id: makeId(),
    name: port.name,
    port: String(port.port),
    initial_path: port.initial_path ?? '',
    primary: Boolean(port.primary),
    unauthenticated: port.unauthenticated,
    proxied: port.proxied,
    subdomain: port.subdomain,
    wildcard_prefix: port.wildcard_prefix,
    auth_bypass_paths: port.auth_bypass_paths,
  }));
}

export function normalizePorts(rows: PortRow[]) {
  const ports = rows
    .map((row) => {
      const name = row.name.trim();
      const port = Number(row.port);
      const hasContent = name.length > 0 || row.port.trim().length > 0;

      if (!hasContent) {
        return null;
      }

      const normalized: NamedPort = {
        name,
        port: Number.isFinite(port) ? port : 3000,
        ...(trimToUndefined(row.initial_path)
          ? { initial_path: trimToUndefined(row.initial_path) }
          : {}),
        ...(row.primary ? { primary: true } : {}),
        ...(row.unauthenticated ? { unauthenticated: true } : {}),
        ...(row.proxied === false ? { proxied: false } : {}),
        ...(trimToUndefined(row.subdomain ?? '')
          ? { subdomain: trimToUndefined(row.subdomain ?? '') }
          : {}),
        ...(row.wildcard_prefix ? { wildcard_prefix: true } : {}),
        ...(row.auth_bypass_paths && row.auth_bypass_paths.length > 0
          ? { auth_bypass_paths: row.auth_bypass_paths }
          : {}),
      };

      return normalized;
    })
    .filter((port): port is NamedPort => Boolean(port));

  return ports.length > 0 ? ports : undefined;
}

export function serializePorts(ports?: NamedPort[]) {
  return JSON.stringify(ports ?? []);
}

export function hasRecordEntries(record?: Record<string, string>) {
  return Boolean(record && Object.keys(record).length > 0);
}

function hasCommands(commands?: Command[]) {
  return Boolean(commands && commands.length > 0);
}

export function hasRepositoryContent(repository: EnvironmentRepositoryConfig) {
  return Boolean(
    trimToUndefined(repository.repository) ||
    trimToUndefined(repository.branch ?? '') ||
    hasRecordEntries(repository.tool_versions) ||
    hasCommands(repository.commands),
  );
}

export function hasBasicContent(config: EnvironmentConfig) {
  return Boolean(
    trimToUndefined(config.name) ||
    trimToUndefined(config.initialUrl ?? '') ||
    trimToUndefined(config.description ?? ''),
  );
}
