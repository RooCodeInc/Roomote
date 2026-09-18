'use client';

import { useSearchParams } from 'next/navigation';

import { decodeRecord } from '@/lib';

import { FramedSurface, UserMenu } from '@/components/layout';

type CallbackState = Record<string, string>;

function decodeBase64UrlJson(value: string): CallbackState | undefined {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(atob(normalized));
    return parsed && typeof parsed === 'object'
      ? (parsed as CallbackState)
      : undefined;
  } catch (_error) {
    return undefined;
  }
}

/**
 * Reads the presentation hints (`redirect`, `bg`) from the OAuth `state`
 * parameter. Install flows carry a plain encoded record; account-link flows
 * carry a signed `<base64url payload>.<signature>` state whose payload is
 * decoded here without verification because only cosmetic hints are read.
 * The server verifies the signature before acting on the state.
 */
function readCallbackState(
  encodedState: string | null,
): CallbackState | undefined {
  if (!encodedState) return undefined;

  const decoded = decodeRecord<CallbackState>(encodedState);
  if (decoded) return decoded;

  const [payload, signature, ...rest] = encodedState.split('.');
  if (!payload || !signature || rest.length > 0) return undefined;

  return decodeBase64UrlJson(payload);
}

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const searchParams = useSearchParams();
  const decodedState = readCallbackState(searchParams.get('state'));
  const requestedBackground = searchParams.get('bg') ?? decodedState?.bg;
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
        <UserMenu showPersonalSettings={!redirect.startsWith('/setup')} />
      </div>
      <div className="flex flex-col gap-8">{children}</div>
    </FramedSurface>
  );
}
