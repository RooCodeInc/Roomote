import { Env } from '@/lib/server/env';
import { jsonOk, withApiV1Auth } from '@/lib/server/api-v1';
import { resolveVoiceOpenAiKey } from '@/lib/server/voice';
import { getIosAppPushConfigured } from '@/lib/server/ios-app-connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiV1Auth(async ({ auth }) => {
  const [voiceKey, push] = await Promise.all([
    resolveVoiceOpenAiKey().catch(() => undefined),
    getIosAppPushConfigured().catch(() => false),
  ]);
  return jsonOk({
    user: {
      id: auth.userId,
      name: auth.name,
      email: auth.primaryEmail,
      imageUrl: auth.resource.imageUrl || null,
      isAdmin: auth.isAdmin,
    },
    deployment: {
      appUrl: Env.R_APP_URL,
      features: {
        voice: Boolean(voiceKey),
        push,
      },
    },
  });
});
