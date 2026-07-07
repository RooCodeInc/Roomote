import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOMOTE_LOGO_FILENAME = 'roomote-logo.png';

export async function GET() {
  const logo = await readFile(
    path.join(process.cwd(), 'public', ROOMOTE_LOGO_FILENAME),
  );

  return new Response(logo, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="${ROOMOTE_LOGO_FILENAME}"`,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
