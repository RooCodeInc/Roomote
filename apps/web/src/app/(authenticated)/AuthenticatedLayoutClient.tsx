'use client';

import { zIndex } from '@/lib';
import { useRedirectToSignIn } from '@/hooks/useSignInRedirect';
import { useUser } from '@/hooks/useUser';

import { NavbarHeader, SideNav, FramedSurface } from '@/components/layout';
import { CommandPaletteProvider } from '@/components/layout/CommandPaletteContext';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { McpOAuthResultFeedback } from '@/components/layout/McpOAuthResultFeedback';
import { ManagedAccessBanner } from './ManagedAccessBanner';

export default function AuthenticatedLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthenticatedLayoutShell>{children}</AuthenticatedLayoutShell>;
}

function AuthenticatedLayoutShell({ children }: { children: React.ReactNode }) {
  const { authStatus, isSignedIn } = useUser();

  useRedirectToSignIn(authStatus === 'signed-out');

  if (!isSignedIn) {
    return null;
  }

  return (
    <CommandPaletteProvider>
      <McpOAuthResultFeedback />
      <div className="flex h-effective-viewport min-h-0 flex-col bg-card">
        <div className="mx-2 rounded-b-2xl overflow-clip">
          <ManagedAccessBanner />
        </div>
        <div
          className={`md:hidden sticky top-0 ${zIndex('NAV_HEADER')} w-full bg-card`}
        >
          <NavbarHeader />
        </div>

        <div className="flex min-h-0 flex-1">
          <SideNav />

          <FramedSurface variant="basic">{children}</FramedSurface>
        </div>
      </div>
      <CommandPalette />
    </CommandPaletteProvider>
  );
}
