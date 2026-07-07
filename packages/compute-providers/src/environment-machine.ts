import crypto from 'node:crypto';

import {
  type EnvironmentConfig,
  type NamedPort,
  INTERNAL_PORTS,
  LEGACY_SANDBOX_GUI_NAMED_PORT_NAME,
  SANDBOX_SERVER_NAMED_PORT,
  assertNoReservedEnvironmentPorts,
  mergeNamedPortsByName,
} from '@roomote/types';

const NON_USER_FACING_PORT_NAMES = new Set([
  SANDBOX_SERVER_NAMED_PORT.name,
  'EDITOR',
  LEGACY_SANDBOX_GUI_NAMED_PORT_NAME,
]);

export interface MachineRoutingInfo {
  machineDomain?: string;
  machineDomains?: Record<string, string>;
  primaryPortName?: string;
  sandboxServerUrl?: string;
}

type MachineRoutingParams = {
  proxyPorts?: Record<string, number>;
  explicitPrimaryPortName?: string;
} & (
  | {
      machineDomains: Record<string, string>;
      namedPorts?: never;
      domainFn?: never;
    }
  | {
      namedPorts: NamedPort[];
      domainFn: (port: number) => string;
      machineDomains?: never;
    }
);

export function getNamedPortsForEnvironment(params: {
  ports?: NamedPort[];
}): NamedPort[] {
  assertNoReservedEnvironmentPorts({ ports: params.ports });

  return mergeNamedPortsByName([SANDBOX_SERVER_NAMED_PORT], params.ports ?? []);
}

function buildMachineDomains(
  namedPorts: NamedPort[],
  domainFn: (port: number) => string,
  proxyPorts?: Record<string, number>,
): Record<string, string> {
  const machineDomains: Record<string, string> = {};

  for (const { name, port: appPort, proxied } of namedPorts) {
    const key = name.toUpperCase();
    const exposedPort =
      proxied === false || INTERNAL_PORTS.has(key)
        ? appPort
        : (proxyPorts?.[key] ?? appPort);

    machineDomains[key] = domainFn(exposedPort);
  }

  return machineDomains;
}

export function buildMachineRoutingInfo(
  params: MachineRoutingParams,
): MachineRoutingInfo {
  const machineDomains =
    'namedPorts' in params && params.namedPorts
      ? buildMachineDomains(
          params.namedPorts,
          params.domainFn,
          params.proxyPorts,
        )
      : (params.machineDomains ?? {});

  const hasDomains = Object.keys(machineDomains).length > 0;
  let primaryPortName = params.explicitPrimaryPortName;
  let machineDomain: string | undefined;

  if (primaryPortName && machineDomains[primaryPortName]) {
    machineDomain = machineDomains[primaryPortName];
  }

  if (!primaryPortName && 'namedPorts' in params && params.namedPorts) {
    const firstUserPort = params.namedPorts.find(
      ({ name }) => !NON_USER_FACING_PORT_NAMES.has(name.toUpperCase()),
    );

    if (firstUserPort) {
      primaryPortName = firstUserPort.name.toUpperCase();
      machineDomain = machineDomains[primaryPortName];
    }
  }

  if (!primaryPortName && hasDomains) {
    const firstUserPortName = Object.keys(machineDomains).find(
      (portName) => !NON_USER_FACING_PORT_NAMES.has(portName),
    );

    if (firstUserPortName) {
      primaryPortName = firstUserPortName;
      machineDomain = machineDomains[firstUserPortName];
    }
  }

  return {
    machineDomain,
    machineDomains: hasDomains ? machineDomains : undefined,
    primaryPortName,
    sandboxServerUrl: machineDomains[SANDBOX_SERVER_NAMED_PORT.name],
  };
}

export function generateProxyPorts(
  namedPorts: NamedPort[] | undefined,
): Record<string, number> {
  if (!namedPorts?.length) {
    return {};
  }

  const proxiedPorts = namedPorts.filter(
    ({ name, proxied }) =>
      proxied !== false && !INTERNAL_PORTS.has(name.toUpperCase()),
  );

  if (proxiedPorts.length === 0) {
    return {};
  }

  let multiplexPort: number;

  do {
    multiplexPort = 49152 + Math.floor(Math.random() * 16383);
  } while (namedPorts.some((port) => port.port === multiplexPort));

  const proxyPorts: Record<string, number> = {};

  for (const { name } of proxiedPorts) {
    proxyPorts[name.toUpperCase()] = multiplexPort;
  }

  return proxyPorts;
}

export function getExposedPorts(
  namedPorts: NamedPort[] | undefined,
  proxyPorts: Record<string, number>,
): number[] {
  if (!namedPorts?.length) {
    return [];
  }

  const exposedSet = new Set<number>();

  for (const { name, port, proxied } of namedPorts) {
    const key = name.toUpperCase();

    if (INTERNAL_PORTS.has(key) || proxied === false) {
      exposedSet.add(port);
      continue;
    }

    exposedSet.add(proxyPorts[key] ?? port);
  }

  return [...exposedSet];
}

export function resolveAuthBypassValue(
  config?: Pick<EnvironmentConfig, 'auth_bypass_header'>,
): string | undefined {
  const setting = config?.auth_bypass_header;

  if (setting === false) {
    return undefined;
  }

  if (setting === true || setting === undefined) {
    return crypto.randomUUID();
  }

  return typeof setting === 'string' ? setting : undefined;
}

export function resolveAuthBypassHeaderName(
  config?: Pick<EnvironmentConfig, 'auth_bypass_header_name'>,
): string | undefined {
  return config?.auth_bypass_header_name?.toLowerCase() ?? undefined;
}
