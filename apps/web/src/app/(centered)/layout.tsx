'use client';

import { useSearchParams } from 'next/navigation';

import { decodeRecord } from '@/lib';

import { FramedSurface, UserMenu } from '@/components/layout';

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const searchParams = useSearchParams();
  const requestedBackground = searchParams.get('bg');
  const encodedState = searchParams.get('state');
  const decodedState = encodedState
    ? decodeRecord<Record<string, string>>(encodedState)
    : undefined;
  const redirect = decodedState?.redirect ?? '';
  const isOnboardingOrigin =
    redirect.startsWith('/setup') || redirect.startsWith('/onboarding');
  const variant =
    requestedBackground === 'background'
      ? 'basic'
      : requestedBackground === 'accent'
        ? 'bold'
        : isOnboardingOrigin
          ? 'bold'
          : 'basic';

  return (
    <FramedSurface
      variant={variant}
      frameClassName="h-effective-viewport min-h-effective-viewport"
      surfaceClassName="relative flex items-center justify-center"
    >
      <div className="absolute top-8 right-8 flex items-center gap-2 animate-enter-down">
        <UserMenu />
      </div>
      <div className="flex flex-col gap-8">{children}</div>
    </FramedSurface>
  );
}
