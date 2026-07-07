import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveTeamsBotRuntimeCredentials } from '@roomote/db/server';

import { Env, authorize } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import {
  buildTeamsAppManifest,
  buildTeamsAppPackage,
} from '@/lib/server/teams-app-package';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  await bootstrapWebRuntimeEnv();

  const authResult = await authorize();

  if (!authResult.success) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const credentials = await resolveTeamsBotRuntimeCredentials();

  if (!credentials.botAppId) {
    return new Response(JSON.stringify({ error: 'teams_bot_not_configured' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
  }

  const appUrl = Env.ROOMOTE_PUBLIC_URL ?? Env.ROOMOTE_APP_URL;
  const [colorIcon, outlineIcon] = await Promise.all([
    readFile(path.join(process.cwd(), 'public', 'teams-app-icon-color.png')),
    readFile(path.join(process.cwd(), 'public', 'teams-app-icon-outline.png')),
  ]);

  const packageZip = buildTeamsAppPackage({
    manifestJson: buildTeamsAppManifest({
      botAppId: credentials.botAppId,
      appUrl,
    }),
    colorIcon,
    outlineIcon,
  });

  return new Response(new Uint8Array(packageZip), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="roomote-teams-app.zip"',
      'Cache-Control': 'no-store',
    },
  });
}
