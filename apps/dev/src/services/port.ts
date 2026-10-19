import { createConnection } from 'net';

import ora from 'ora';

export class PortService {
  private static readonly PORT_POLL_INTERVAL_MS = 500;
  private static readonly PORT_POLL_TIMEOUT_MS = 15_000;

  private static getRequiredPorts() {
    return [
      {
        port: Number(process.env.ROOMOTE_WEB_PORT || 13000),
        description: '@roomote/web (Next.js app)',
      },
      {
        port: Number(process.env.ROOMOTE_API_PORT || 13001),
        description: '@roomote/api (API server)',
      },
      {
        port: Number(process.env.ROOMOTE_BULLMQ_PORT || 13002),
        description: '@roomote/bullmq (BullMQ dashboard)',
      },
      {
        port: Number(process.env.ROOMOTE_PREVIEW_PROXY_PORT || 18081),
        description: '@roomote/preview-proxy (Preview proxy server)',
      },
    ];
  }

  static async checkPorts(): Promise<void> {
    const spinner = ora('Checking port availability').start();
    const requiredPorts = this.getRequiredPorts();
    const portsInUse = await this.getPortsInUse(
      requiredPorts.map(({ port }) => port),
    );

    if (portsInUse.length > 0) {
      spinner.text = `Waiting for ports to become available: ${portsInUse.join(', ')}`;
      const timedOut = await this.waitForPortsToFree(portsInUse);

      if (timedOut.length > 0) {
        const portList = timedOut.join(', ');

        throw new Error(
          `The following required ports are already in use: ${portList}\n` +
            'Please stop any services running on these ports before starting the development environment.\n' +
            'Required ports:\n' +
            requiredPorts
              .map(
                ({ port, description }) => `  - Port ${port}: ${description}`,
              )
              .join('\n'),
        );
      }
    }

    spinner.succeed();
  }

  private static async getPortsInUse(ports: number[]): Promise<number[]> {
    const results = await Promise.all(
      ports.map(async (port) => ({
        port,
        inUse: await this.checkPort(port),
      })),
    );

    return results.filter((r) => r.inUse).map((r) => r.port);
  }

  private static async waitForPortsToFree(ports: number[]): Promise<number[]> {
    const deadline = Date.now() + this.PORT_POLL_TIMEOUT_MS;
    let remaining = [...ports];

    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.PORT_POLL_INTERVAL_MS),
      );

      const stillInUse = await Promise.all(
        remaining.map(async (port) => ({
          port,
          inUse: await this.checkPort(port),
        })),
      );

      remaining = stillInUse.filter((r) => r.inUse).map((r) => r.port);
    }

    if (remaining.length > 0) {
      remaining.forEach((port) => console.info(`🚨 Port ${port}: IN USE`));
    }

    return remaining;
  }

  private static async checkPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const connection = createConnection({ port, host: 'localhost' });

      connection.on('connect', () => {
        connection.destroy();
        resolve(true); // Port is in use.
      });

      connection.on('error', () => {
        resolve(false); // Port is available.
      });

      connection.setTimeout(5_000, () => {
        connection.destroy();
        resolve(false); // Timeout, assume port is available.
      });
    });
  }
}
