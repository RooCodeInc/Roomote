import fs from 'fs';

import { execa } from 'execa';
import ora from 'ora';

type PublicUrlResolution = {
  autoNgrok: boolean;
  publicUrl: string;
};

type NgrokTunnel = {
  config?: {
    addr?: string;
  };
  public_url?: string;
};

const NGROK_INSPECT_API_PORTS = Array.from(
  { length: 11 },
  (_, index) => 4040 + index,
);

export class NgrokService {
  private static readonly WEB_TUNNEL_NAME = 'roomote-web-ngrok';
  private static readonly TUNNEL_POLL_INTERVAL_MS = 500;
  private static readonly TUNNEL_POLL_TIMEOUT_MS = 15_000;

  static async checkInstalled(_verbose: boolean): Promise<void> {
    const ngrokCheck = ora('Checking ngrok installation').start();

    try {
      await execa('ngrok', ['version']);
      ngrokCheck.succeed();
    } catch (_error) {
      ngrokCheck.fail();

      throw new Error(
        'Please install ngrok manually:\n' + this.getInstallInstructions(),
      );
    }
  }

  static async checkConfig(verbose: boolean): Promise<void> {
    const configCheck = ora('Checking ngrok configuration').start();

    try {
      try {
        await execa('ngrok', ['config', 'check'], {
          ...(verbose && { stdio: 'pipe' }),
        });
      } catch (_error) {
        await this.addAuthToken(verbose);
      }

      const { stdout } = await execa('ngrok', ['config', 'check'], {
        ...(verbose && { stdio: 'pipe' }),
      });

      const configPath = stdout.match(/Valid configuration file at (.+)/);

      if (!configPath || !configPath[1]) {
        await this.addAuthToken(verbose);
      } else {
        const config = fs.readFileSync(configPath[1], 'utf-8');

        if (!config.includes('authtoken:') || config.match(/authtoken:\s*$/m)) {
          await this.addAuthToken(verbose);
        } else {
          const authtokenMatch = config.match(/authtoken:\s*(.+)/);
          const configAuthtoken = authtokenMatch?.[1]?.trim();

          if (
            process.env.NGROK_AUTH_TOKEN &&
            configAuthtoken !== process.env.NGROK_AUTH_TOKEN
          ) {
            await this.addAuthToken(verbose);
          }
        }
      }

      configCheck.succeed();
    } catch (error) {
      configCheck.fail();

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      throw new Error(
        'ngrok configuration is invalid or missing auth token.\n' +
          '\n' +
          'To configure ngrok:\n' +
          '1. Sign up for a free account at https://ngrok.com\n' +
          '2. Get your auth token from https://dashboard.ngrok.com/get-started/your-authtoken\n' +
          '3. Run: ngrok config add-authtoken <your-token>\n' +
          '   Or set the NGROK_AUTH_TOKEN environment variable\n' +
          '\n' +
          errorMessage,
      );
    }
  }

  static async resolvePublicUrl({
    port,
    verbose,
  }: {
    port: number;
    verbose: boolean;
  }): Promise<PublicUrlResolution> {
    const configuredUrl = process.env.ROOMOTE_PUBLIC_URL?.trim();

    if (configuredUrl) {
      const publicUrl = this.normalizePublicUrl(configuredUrl);

      if (this.isNgrokUrl(publicUrl)) {
        await this.checkInstalled(verbose);
        await this.checkConfig(verbose);

        await this.ensureManagedWebTunnel({
          port,
          publicUrl,
          verbose,
        });

        return {
          autoNgrok: true,
          publicUrl,
        };
      }

      return {
        autoNgrok: false,
        publicUrl,
      };
    }

    throw new Error(
      'ROOMOTE_PUBLIC_URL is required for local Roomote callbacks.',
    );
  }

  private static async ensureManagedWebTunnel({
    port,
    publicUrl,
    verbose,
  }: {
    port: number;
    publicUrl: string;
    verbose: boolean;
  }): Promise<void> {
    const existingTunnel = await this.fetchTunnelForPort(port);
    const existingPublicUrl = existingTunnel?.public_url
      ? this.normalizePublicUrl(existingTunnel.public_url)
      : undefined;

    if (existingPublicUrl === publicUrl) {
      const spinner = ora('Checking configured ngrok web tunnel').start();
      spinner.succeed(`Reusing ${publicUrl}`);
      return;
    }

    await this.startWebTunnel({
      port,
      publicUrl,
      verbose,
    });

    await this.waitForPublicWebUrl(port, publicUrl);
  }

  private static async startWebTunnel({
    port,
    publicUrl,
    verbose,
  }: {
    port: number;
    publicUrl?: string;
    verbose: boolean;
  }): Promise<void> {
    const tunnelLabel = publicUrl ? ` ${publicUrl}` : '';
    const startTunnel = ora(`Starting ngrok web tunnel${tunnelLabel}`).start();

    try {
      await this.deleteStaleTunnelProcess();
      await execa(
        'pm2',
        [
          'start',
          'ngrok',
          '--name',
          this.WEB_TUNNEL_NAME,
          '--',
          'http',
          String(port),
          ...(publicUrl ? [`--url=${new URL(publicUrl).host}`] : []),
          '--log=stdout',
        ],
        {
          ...(verbose && { stdio: 'inherit' }),
        },
      );
      startTunnel.succeed();
    } catch (error) {
      startTunnel.fail();

      throw error;
    }
  }

  private static normalizePublicUrl(value: string): string {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw new Error(
        `ROOMOTE_PUBLIC_URL must be a valid absolute URL. Received: ${value}`,
      );
    }

    if (url.protocol !== 'https:') {
      throw new Error('ROOMOTE_PUBLIC_URL must use https.');
    }

    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    url.search = '';
    url.hash = '';

    return url.origin;
  }

  private static async waitForPublicWebUrl(
    port: number,
    expectedPublicUrl?: string,
  ): Promise<string> {
    const spinner = ora('Resolving ngrok public URL').start();
    const deadline = Date.now() + this.TUNNEL_POLL_TIMEOUT_MS;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const response = await this.fetchTunnelForPort(port);

        if (response?.public_url) {
          const publicUrl = this.normalizePublicUrl(response.public_url);
          if (expectedPublicUrl && publicUrl !== expectedPublicUrl) {
            lastError = new Error(
              `ngrok exposed ${publicUrl}, expected ${expectedPublicUrl}`,
            );
            await new Promise((resolve) =>
              setTimeout(resolve, this.TUNNEL_POLL_INTERVAL_MS),
            );
            continue;
          }

          spinner.succeed(`Using ${publicUrl}`);
          return publicUrl;
        }
      } catch (error) {
        lastError = error;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.TUNNEL_POLL_INTERVAL_MS),
      );
    }

    spinner.fail();
    const details = [
      lastError instanceof Error ? lastError.message : undefined,
      await this.getTunnelLogFailureDetails(),
    ].filter(Boolean);

    throw new Error(
      [
        `Timed out waiting for ngrok to expose a public URL on port ${port}.`,
        ...details,
      ].join('\n\n'),
    );
  }

  private static async deleteStaleTunnelProcess(): Promise<void> {
    try {
      await execa('pm2', ['delete', this.WEB_TUNNEL_NAME]);
    } catch (_error) {
      // The process is absent on a clean start. That is the normal path.
    }
  }

  private static async getTunnelLogFailureDetails(): Promise<string | null> {
    try {
      const { stdout, stderr } = await execa('pm2', [
        'logs',
        this.WEB_TUNNEL_NAME,
        '--lines',
        '60',
        '--nostream',
      ]);
      const logs = [stdout, stderr].filter(Boolean).join('\n').trim();

      if (!logs) {
        return null;
      }

      const endpointAlreadyOnline = logs.match(
        /The endpoint '([^']+)' is already online/,
      );

      if (endpointAlreadyOnline?.[1]) {
        return (
          `ngrok says ${endpointAlreadyOnline[1]} is already online. ` +
          'Stop the existing tunnel in ngrok or set ROOMOTE_PUBLIC_URL to that URL if it already points at this checkout.'
        );
      }

      const errorCode = logs.match(/ERR_NGROK_\d+/)?.[0];

      if (errorCode) {
        return `ngrok failed with ${errorCode}. Recent logs:\n${logs}`;
      }

      return `Recent ngrok logs:\n${logs}`;
    } catch (_error) {
      return null;
    }
  }

  private static async fetchTunnelForPort(
    port: number,
  ): Promise<NgrokTunnel | null> {
    for (const inspectPort of NGROK_INSPECT_API_PORTS) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${inspectPort}/api/tunnels`,
        );

        if (!response.ok) {
          continue;
        }

        const payload = (await response.json()) as {
          tunnels?: NgrokTunnel[];
        };
        const tunnel = payload.tunnels?.find((candidate) => {
          const publicUrl = candidate.public_url;
          const addr = candidate.config?.addr ?? '';

          return (
            publicUrl?.startsWith('https://') &&
            (addr === String(port) || addr.endsWith(`:${port}`))
          );
        });

        if (tunnel) {
          return tunnel;
        }
      } catch (_error) {
        // Different ngrok agents choose different inspect ports when multiple
        // checkouts are running locally. Try the next likely port.
      }
    }

    return null;
  }

  private static isNgrokUrl(value: string): boolean {
    const hostname = new URL(value).hostname;

    return (
      hostname === 'ngrok.app' ||
      hostname.endsWith('.ngrok.app') ||
      hostname === 'ngrok-free.app' ||
      hostname.endsWith('.ngrok-free.app') ||
      hostname === 'ngrok.dev' ||
      hostname.endsWith('.ngrok.dev') ||
      hostname === 'ngrok-free.dev' ||
      hostname.endsWith('.ngrok-free.dev')
    );
  }

  private static async addAuthToken(verbose: boolean): Promise<void> {
    if (!process.env.NGROK_AUTH_TOKEN) {
      throw new Error(
        'No auth token found in ngrok configuration and NGROK_AUTH_TOKEN environment variable is not set.',
      );
    }

    await execa(
      'ngrok',
      ['config', 'add-authtoken', process.env.NGROK_AUTH_TOKEN],
      {
        ...(verbose && { stdio: 'pipe' }),
      },
    );
  }

  private static getInstallInstructions(): string {
    if (process.platform === 'darwin') {
      return '  brew install ngrok\n  OR\n  Download from https://ngrok.com/download\n';
    }

    if (process.platform === 'linux') {
      return (
        '  Download the Linux binary from https://ngrok.com/download\n' +
        '  and place `ngrok` on your PATH (for example `/usr/local/bin/ngrok`).\n'
      );
    }

    return '  Download from https://ngrok.com/download\n';
  }
}
