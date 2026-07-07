import { execa } from 'execa';

import { withAptLock } from '../commands/setup/package-manager';

import type { ServiceDefinition } from './types';
import { SERVICE_CONFIG } from './constants';

const MISSING_AWS_CLI_MESSAGE =
  'AWS CLI is not installed in this worker image. Rebuild and republish the worker base image from apps/worker/Dockerfile before using the aws managed service.';

const AWS_CLI_VERSION_CHECK_COMMAND = `command -v aws >/dev/null 2>&1 && aws --version | grep -q '^aws-cli/2' && aws --version || echo "not_installed"`;

const AWS_CLI_INSTALL_COMMAND = `ARCH="$(dpkg --print-architecture)" && \
case "$ARCH" in \
  amd64) AWS_ARCH="x86_64" ;; \
  arm64) AWS_ARCH="aarch64" ;; \
  *) echo "Unsupported architecture for AWS CLI: $ARCH" >&2; exit 1 ;; \
esac && \
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-\${AWS_ARCH}.zip" -o /tmp/awscliv2.zip && \
rm -rf /tmp/aws && \
unzip -q /tmp/awscliv2.zip -d /tmp && \
sudo /tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli --update && \
rm -rf /tmp/aws /tmp/awscliv2.zip && \
aws --version | grep -q '^aws-cli/2'`;

export function createAwsService(): ServiceDefinition {
  return {
    defaultPort: SERVICE_CONFIG.aws.defaultPort,

    async install(executor) {
      const versionResult = await executor.execute({
        name: 'Check installed AWS CLI version',
        run: AWS_CLI_VERSION_CHECK_COMMAND,
        timeout: 30,
        continue_on_error: true,
      });

      if (versionResult.stdout?.includes('not_installed')) {
        await withAptLock(() =>
          executor.execute({
            name: 'Install AWS CLI prerequisites',
            run: 'sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl unzip',
            timeout: 180,
            continue_on_error: false,
          }),
        );

        await executor.execute({
          name: 'Install AWS CLI',
          run: AWS_CLI_INSTALL_COMMAND,
          timeout: 180,
          continue_on_error: false,
        });

        const installedVersionResult = await executor.execute({
          name: 'Verify installed AWS CLI version',
          run: AWS_CLI_VERSION_CHECK_COMMAND,
          timeout: 30,
          continue_on_error: true,
        });

        if (installedVersionResult.stdout?.includes('not_installed')) {
          throw new Error(MISSING_AWS_CLI_MESSAGE);
        }
      }
    },

    async start(_executor, _port) {
      // AWS CLI is a CLI tool, no server to start.
    },

    async healthCheck(_port) {
      try {
        const result = await execa('aws', ['--version'], { timeout: 5000 });
        return /^aws-cli\/2/u.test(result.stdout.trim());
      } catch {
        return false;
      }
    },

    getConnectionInfo(_port) {
      return {
        connectionString: 'aws-cli',
        envVars: {
          // No additional env vars needed - AWS credentials should be
          // configured separately via AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, etc.
        },
      };
    },
  };
}
