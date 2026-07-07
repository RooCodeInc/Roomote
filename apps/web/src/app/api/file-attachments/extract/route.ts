import { type NextRequest, NextResponse } from 'next/server';

import { extractPromptTextAttachments } from '@roomote/cloud-agents/server';
import { authorize } from '@/lib/server/auth-context';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const authResult = await authorize();

  if (!authResult.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const files = formData
    .getAll('files')
    .filter((value): value is File => value instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ attachmentTexts: [], warnings: [] });
  }

  const extracted = await extractPromptTextAttachments(
    await Promise.all(
      files.map(async (file) => ({
        filename: file.name,
        mimeType: file.type || undefined,
        bytes: await file.arrayBuffer(),
      })),
    ),
  );

  return NextResponse.json(extracted);
}
