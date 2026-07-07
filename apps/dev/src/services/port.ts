import { createConnection } from 'net';

import ora from 'ora';

export class PortService {
  private static readonly REQUIRED_PORTS = [13000, 13001, 13002, 7060, 18081];
  private static readonly PORT_POLL_INTERVAL_MS = 500;
  private static readonly PORT_POLL_TIMEOUT_MS = 15_000;

  static async checkPorts(): Promise<void> {
    const spinner = ora('Checking port availability').start();

    const portsInUse = await this.getPortsInUse();

    if (portsInUse.length > 0) {
      spinner.text = `Waiting for ports to become available: ${portsInUse.join(', ')}`;
      const timedOut = await this.waitForPortsToFree(portsInUse);

      if (timedOut.length > 0) {
        const portList = timedOut.join(', ');

        throw new Error(
          `The following required ports are already in use: ${portList}\n` +
            'Please stop any services running on these ports before starting the development environment.\n' +
            'Required ports:\n' +
            '  - Port 13000: @roomote/web (Next.js app)\n' +
            '  - Port 13001: @roomote/api (API server)\n' +
            '  - Port 13002: @roomote/bullmq (BullMQ dashboard)\n' +
            '  - Port 18081: @roomote/preview-proxy (Preview proxy server)',
        );
      }
    }

    spinner.succeed();
  }

  private static async getPortsInUse(): Promise<number[]> {
    const results = await Promise.all(
      this.REQUIRED_PORTS.map(async (port) => ({
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
