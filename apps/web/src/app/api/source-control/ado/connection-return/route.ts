import { type NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/server/auth-context';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { completeConnectionAttempt } from '@/lib/server/source-control-connection-attempt';

export async function GET(request: NextRequest) {
  const auth = await authorize();
  if (!auth.success || !auth.isAdmin)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const env = await bootstrapWebRuntimeEnv();
  const origin = env.R_PUBLIC_URL ?? env.R_APP_URL;
  try {
    // Better Auth owns OAuth/PKCE and account linking. Linking personal identity
    // is not deployment consent: the admin must still save the selected account
    // in the trusted configuration form, which validates it before inventory sync.
    const result = await completeConnectionAttempt(
      auth,
      {
        provider: 'ado',
        state: request.nextUrl.searchParams.get('state') ?? '',
        reconcile: false,
      },
      async () => ({ success: false as const }),
    );
    return NextResponse.redirect(new URL(result.returnTarget, origin));
  } catch {
    return NextResponse.redirect(
      new URL('/settings/source-control?ado=error', origin),
    );
  }
}
