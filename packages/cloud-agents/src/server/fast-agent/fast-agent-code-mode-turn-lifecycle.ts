import { formatErrorForLog } from '@roomote/types';

import { mountFastAgentIntegrationOnCodeModeServer } from './fast-agent-native-tool-bridge';
import type { FastAgentIntegration } from './fast-agent-integration-broker';

type ActiveCodeModeTurnState = {
  directory: string;
  mcpCapability: string;
  mountedIntegrationIds: Set<string>;
};

type CodeModeTurnState =
  | { phase: 'inactive' }
  | (ActiveCodeModeTurnState & { phase: 'awaiting-server' })
  | (ActiveCodeModeTurnState & {
      phase: 'server-bound';
      serverUrl: string;
    });

type MountCodeModeIntegration =
  typeof mountFastAgentIntegrationOnCodeModeServer;

type FastAgentCodeModeTurnLifecycleOptions = {
  logger?: Pick<Console, 'info' | 'warn'>;
  mountIntegration?: MountCodeModeIntegration;
};

type FastAgentCodeModeTurnRuntime = {
  codeModeIntegrationsActive: boolean;
  directory: string;
  mcpCapability: string;
};

/** Owns the code-mode integration state that is valid only for one Fast turn. */
export class FastAgentCodeModeTurnLifecycle {
  private state: CodeModeTurnState = { phase: 'inactive' };
  private readonly logger: Pick<Console, 'info' | 'warn'>;
  private readonly mountIntegration: MountCodeModeIntegration;

  constructor(options: FastAgentCodeModeTurnLifecycleOptions = {}) {
    this.logger = options.logger ?? console;
    this.mountIntegration =
      options.mountIntegration ?? mountFastAgentIntegrationOnCodeModeServer;
  }

  get active(): boolean {
    return this.state.phase !== 'inactive';
  }

  configure(
    runtime: FastAgentCodeModeTurnRuntime,
    integrations: FastAgentIntegration[],
  ): void {
    this.state = runtime.codeModeIntegrationsActive
      ? {
          phase: 'awaiting-server',
          directory: runtime.directory,
          mcpCapability: runtime.mcpCapability,
          mountedIntegrationIds: new Set(
            integrations.map((integration) => integration.id),
          ),
        }
      : { phase: 'inactive' };
  }

  bindServer(serverUrl: string): void {
    if (this.state.phase === 'inactive') return;
    this.state = {
      ...this.state,
      phase: 'server-bound',
      serverUrl,
    };
  }

  /**
   * Live-mount integrations connected after this turn's config was written.
   * A failed mount remains attempted for this turn; regenerated config mounts
   * it durably at the next turn boundary.
   */
  async mountNewlyConnected(
    integrations: FastAgentIntegration[],
  ): Promise<void> {
    if (this.state.phase === 'inactive') return;
    if (this.state.phase === 'awaiting-server') {
      this.logger.warn(
        '[Fast Agent] Skipping mid-turn code-mode mount: the OpenCode server is not bound yet.',
      );
      return;
    }

    const state = this.state;
    for (const integration of integrations) {
      if (state.mountedIntegrationIds.has(integration.id)) continue;
      state.mountedIntegrationIds.add(integration.id);
      try {
        const mounted = await this.mountIntegration({
          serverUrl: state.serverUrl,
          directory: state.directory,
          mcpCapability: state.mcpCapability,
          integrationId: integration.id,
        });
        if (mounted) {
          this.logger.info(
            `[Fast Agent] Mounted integration ${integration.id} on the code-mode server mid-turn (server=${state.serverUrl} directory=${state.directory}).`,
          );
        } else {
          this.logger.warn(
            `[Fast Agent] Code-mode server rejected the mid-turn mount of integration ${integration.id}; it becomes callable next turn.`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `[Fast Agent] Failed to mount integration ${integration.id} on the code-mode server mid-turn: ${formatErrorForLog(error)}`,
        );
      }
    }
  }
}
