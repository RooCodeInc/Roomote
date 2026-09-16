import { NextResponse } from 'next/server';

import { getIosAppConnection } from '@roomote/sdk/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Apple's universal-links manifest. Served without auth and only once an
 * admin has entered the deployment's Apple team and bundle ids, so a build
 * of the iOS app with a matching associated domain opens Session and task
 * links directly.
 */
export async function GET() {
  const connection = await getIosAppConnection();
  if (!connection) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(
    {
      applinks: {
        details: [
          {
            appIDs: [`${connection.teamId}.${connection.bundleId}`],
            components: [{ '/': '/sessions/*' }, { '/': '/task/*' }],
          },
        ],
      },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    },
  );
}
