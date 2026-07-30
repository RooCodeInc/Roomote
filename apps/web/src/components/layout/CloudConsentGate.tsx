'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { Button } from '@/components/system';
import { useTRPC } from '@/trpc/client';

import { CloudAnalyticsProvider } from './CloudAnalyticsProvider';

const CONSENT_STORAGE_KEY = 'roomote-cookie-consent-choice';
const CONSENT_ACCEPTED_VALUE = 'true';
const CONSENT_REJECTED_VALUE = 'false';

type ConsentChoice =
  | typeof CONSENT_ACCEPTED_VALUE
  | typeof CONSENT_REJECTED_VALUE
  | null;

function readConsentChoice(): ConsentChoice {
  try {
    const value = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return value === CONSENT_ACCEPTED_VALUE || value === CONSENT_REJECTED_VALUE
      ? value
      : null;
  } catch {
    return null;
  }
}

function persistConsentChoice(choice: Exclude<ConsentChoice, null>) {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, choice);
  } catch {
    // The in-memory choice still applies for this page in restricted browsers.
  }
}

function CookieConsentBanner({
  onAccept,
  onDecline,
  visible,
}: {
  onAccept: () => void;
  onDecline: () => void;
  visible: boolean;
}) {
  return (
    <div
      aria-hidden={visible ? 'false' : 'true'}
      aria-label="Cookie preferences"
      aria-live="polite"
      className="border-foreground/10 bg-card fixed right-4 bottom-4 left-4 z-[1000] flex flex-wrap items-center justify-between gap-4 rounded-lg border p-5 font-semibold shadow-2xl md:right-8 md:left-8 md:p-6"
      hidden={!visible}
      role="dialog"
    >
      <div className="flex max-w-[44rem] flex-col gap-1">
        <p className="text-foreground text-base font-bold">
          Like most of the internet, we use cookies.
        </p>
        <p className="text-muted-foreground text-base font-normal">
          Some are essential, others are optional but help us improve your
          experience.
        </p>
      </div>
      <div className="flex w-full flex-row-reverse flex-wrap items-center gap-2 md:w-auto">
        <Button
          className="min-w-48 flex-1 md:flex-none"
          onClick={onDecline}
          type="button"
          variant="outline"
        >
          Refuse non-essential
        </Button>
        <Button
          className="min-w-48 flex-1 md:flex-none"
          onClick={onAccept}
          type="button"
        >
          Accept all
        </Button>
      </div>
    </div>
  );
}

export function CloudConsentGate({
  cookieConsentedAt,
  intercomAppId,
  posthogProjectKey,
  posthogHost,
  userId,
}: {
  cookieConsentedAt: number | null;
  intercomAppId?: string;
  posthogProjectKey?: string;
  posthogHost?: string;
  userId?: string;
}) {
  const trpc = useTRPC();
  const acceptCookieConsent = useMutation(
    trpc.preferences.acceptCookieConsent.mutationOptions(),
  );
  const syncedUserIdRef = useRef<string | null>(null);
  const [localChoice, setLocalChoice] = useState<ConsentChoice>(null);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const databaseConsented = cookieConsentedAt !== null;
  const hasConfiguredIntegration = Boolean(
    intercomAppId?.trim() || posthogProjectKey?.trim(),
  );
  const consentGranted = databaseConsented || localChoice === 'true';

  useEffect(() => {
    setLocalChoice(readConsentChoice());
    setStorageLoaded(true);
  }, []);

  useEffect(() => {
    if (
      !storageLoaded ||
      !hasConfiguredIntegration ||
      databaseConsented ||
      localChoice !== CONSENT_ACCEPTED_VALUE ||
      !userId ||
      syncedUserIdRef.current === userId
    ) {
      return;
    }

    syncedUserIdRef.current = userId;
    acceptCookieConsent.mutate();
  }, [
    acceptCookieConsent,
    databaseConsented,
    hasConfiguredIntegration,
    localChoice,
    storageLoaded,
    userId,
  ]);

  if (!hasConfiguredIntegration) {
    return null;
  }

  const accept = () => {
    persistConsentChoice(CONSENT_ACCEPTED_VALUE);
    setLocalChoice(CONSENT_ACCEPTED_VALUE);

    if (userId && !databaseConsented && syncedUserIdRef.current !== userId) {
      syncedUserIdRef.current = userId;
      acceptCookieConsent.mutate();
    }
  };

  const decline = () => {
    persistConsentChoice(CONSENT_REJECTED_VALUE);
    setLocalChoice(CONSENT_REJECTED_VALUE);
  };

  return (
    <>
      <CloudAnalyticsProvider
        cloudEnabled
        consentGranted={consentGranted}
        intercomAppId={intercomAppId}
        posthogHost={posthogHost}
        posthogProjectKey={posthogProjectKey}
        userId={userId}
      />
      <CookieConsentBanner
        onAccept={accept}
        onDecline={decline}
        visible={storageLoaded && !databaseConsented && localChoice === null}
      />
    </>
  );
}
