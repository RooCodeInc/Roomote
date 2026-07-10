import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Env } from '@/lib/server';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import {
  buildTeamsAppManifest,
  buildTeamsAppPackage,
} from '@/lib/server/teams-app-package';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Microsoft app (client) IDs are GUIDs. The bot app ID is caller-provided
 * during setup (before anything is saved), so validate the shape instead of
 * trusting arbitrary input.
 */
const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Unauthenticated setup-flow variant of `GET /api/teams/app-package`.
 *
 * The setup flow collects the Microsoft credentials before they are saved
 * (and, in bootstrap mode, before any user can sign in), so this route builds
 * the Teams app package from the caller-supplied bot app ID rather than the
 * stored credentials. The package only contains information the caller
 * already has: the app ID they typed plus this deployment's public URL.
 */
export async function GET(request: Request) {
  await bootstrapWebRuntimeEnv();

  const searchParams = new URL(request.url).searchParams;
  const botAppId = searchParams.get('botAppId')?.trim();
  const botName = searchParams.get('botName')?.trim() || undefined;

  if (!botAppId || !GUID_PATTERN.test(botAppId)) {
    return new Response(JSON.stringify({ error: 'invalid_bot_app_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const appUrl = Env.ROOMOTE_PUBLIC_URL ?? Env.ROOMOTE_APP_URL;
  const [colorIcon, outlineIcon] = await Promise.all([
    readFile(path.join(process.cwd(), 'public', 'teams-app-icon-color.png')),
    readFile(path.join(process.cwd(), 'public', 'teams-app-icon-outline.png')),
  ]);

  const packageZip = buildTeamsAppPackage({
    manifestJson: buildTeamsAppManifest({ botAppId, appUrl, botName }),
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
