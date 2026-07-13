import {
  CODE_SERVER_NAMED_PORT,
  SANDBOX_SERVER_NAMED_PORT,
  type NamedPort,
} from '@roomote/types';

import {
  buildMachineRoutingInfo,
  getNamedPortsForEnvironment,
} from '../environment-machine';

const originalTrpcUrl = process.env.R_TRPC_URL;
const originalRoomoteAppUrl = process.env.R_APP_URL;

describe('getNamedPortsForEnvironment', () => {
  beforeEach(() => {
    delete process.env.R_TRPC_URL;
    delete process.env.R_APP_URL;
  });

  afterAll(() => {
    if (originalTrpcUrl === undefined) {
      delete process.env.R_TRPC_URL;
    } else {
      process.env.R_TRPC_URL = originalTrpcUrl;
    }

    if (originalRoomoteAppUrl === undefined) {
      delete process.env.R_APP_URL;
    } else {
      process.env.R_APP_URL = originalRoomoteAppUrl;
    }
  });

  it('does not infer callback surfaces from local controller callback URLs', () => {
    process.env.R_TRPC_URL = 'http://localhost:3001';

    const namedPorts = getNamedPortsForEnvironment({});

    expect(namedPorts).toContainEqual(SANDBOX_SERVER_NAMED_PORT);
    expect(namedPorts).not.toContainEqual({
      name: 'API',
      port: 3001,
    });
  });

  it('includes configured environment ports alongside the sandbox server', () => {
    const namedPorts = getNamedPortsForEnvironment({
      ports: [
        { name: 'WEB', port: 3000 },
        { name: 'API', port: 3001 },
      ],
    });

    expect(namedPorts).toContainEqual(SANDBOX_SERVER_NAMED_PORT);
    expect(namedPorts).toContainEqual({
      name: 'WEB',
      port: 3000,
    });
    expect(namedPorts).toContainEqual({
      name: 'API',
      port: 3001,
    });
  });
});

describe('buildMachineRoutingInfo', () => {
  it('derives domains and the primary port from named ports', () => {
    const namedPorts: NamedPort[] = [
      SANDBOX_SERVER_NAMED_PORT,
      CODE_SERVER_NAMED_PORT,
      { name: 'WEB', port: 3000 },
      { name: 'API', port: 3001 },
    ];

    const routingInfo = buildMachineRoutingInfo({
      namedPorts,
      domainFn: (port) => `https://port-${port}.vercel.run`,
    });

    expect(routingInfo).toEqual({
      machineDomain: 'https://port-3000.vercel.run',
      machineDomains: {
        SANDBOX_SERVER: 'https://port-4200.vercel.run',
        EDITOR: 'https://port-0.vercel.run',
        WEB: 'https://port-3000.vercel.run',
        API: 'https://port-3001.vercel.run',
      },
      primaryPortName: 'WEB',
      sandboxServerUrl: 'https://port-4200.vercel.run',
    });
  });

  it('derives a primary port name from provided machineDomains', () => {
    const routingInfo = buildMachineRoutingInfo({
      machineDomains: {
        SANDBOX_SERVER: 'https://sandbox.localhost',
        EDITOR: 'https://editor.localhost',
        WEB: 'https://web.localhost',
        API: 'https://api.localhost',
      },
    });

    expect(routingInfo).toEqual({
      machineDomain: 'https://web.localhost',
      machineDomains: {
        SANDBOX_SERVER: 'https://sandbox.localhost',
        EDITOR: 'https://editor.localhost',
        WEB: 'https://web.localhost',
        API: 'https://api.localhost',
      },
      primaryPortName: 'WEB',
      sandboxServerUrl: 'https://sandbox.localhost',
    });
  });

  it('keeps internal-only domains without inventing a primary user port', () => {
    const routingInfo = buildMachineRoutingInfo({
      namedPorts: [SANDBOX_SERVER_NAMED_PORT, CODE_SERVER_NAMED_PORT],
      domainFn: (port) => `https://port-${port}.vercel.run`,
    });

    expect(routingInfo).toEqual({
      machineDomain: undefined,
      machineDomains: {
        SANDBOX_SERVER: 'https://port-4200.vercel.run',
        EDITOR: 'https://port-0.vercel.run',
      },
      primaryPortName: undefined,
      sandboxServerUrl: 'https://port-4200.vercel.run',
    });
  });
});
