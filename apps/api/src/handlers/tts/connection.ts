import { areCuratedIntegrationsDisabled, Env } from '@roomote/env';
import {
  and,
  db,
  deploymentMcpEnablements,
  eq,
  isNull,
  mcpConnections,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { isMcpConnectionElevenLabsConfig } from '@roomote/types';

type ElevenLabsCredentials = {
  apiKey: string;
  voiceId: string;
};

/**
 * Resolves narration TTS credentials for the deployment.
 *
 * The admin-configured ElevenLabs integration (Settings → Integrations) is
 * the primary source; the `R_ELEVENLABS_*` environment variables remain an
 * operator fallback. Returns undefined when neither is configured — the
 * feature is off and the endpoint 404s.
 *
 * The integration is credential-only: this control-plane resolver is its
 * single consumer, and the connection is deliberately excluded from agent
 * MCP config delivery, so the key never travels toward a task sandbox.
 */
export async function resolveElevenLabsCredentials(): Promise<
  ElevenLabsCredentials | undefined
> {
  if (!areCuratedIntegrationsDisabled(Env.R_CURATED_INTEGRATIONS_DISABLED)) {
    const connection = await db.query.mcpConnections.findFirst({
      where: and(
        eq(mcpConnections.mcpId, 'elevenlabs'),
        isNull(mcpConnections.userId),
        eq(mcpConnections.enabled, true),
        eq(mcpConnections.authStatus, 'authenticated'),
      ),
    });

    if (connection && isMcpConnectionElevenLabsConfig(connection.authConfig)) {
      const enablement = await db.query.deploymentMcpEnablements.findFirst({
        where: eq(deploymentMcpEnablements.mcpId, 'elevenlabs'),
      });

      if (enablement?.enabled !== false) {
        const apiKey = decrypt(connection.authConfig.encryptedApiKey).trim();
        const voiceId = connection.authConfig.voiceId.trim();

        if (apiKey && voiceId) {
          return { apiKey, voiceId };
        }
      }
    }
  }

  if (Env.R_ELEVENLABS_API_KEY && Env.R_ELEVENLABS_VOICE_ID) {
    return {
      apiKey: Env.R_ELEVENLABS_API_KEY,
      voiceId: Env.R_ELEVENLABS_VOICE_ID,
    };
  }

  return undefined;
}
