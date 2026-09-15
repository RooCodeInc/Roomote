'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { SessionSecretMetadata } from '@roomote/types';

import { Button, KeyRound, Skeleton } from '@/components/system';

import { Section } from './Section';

const endpoint = '/api/account/integrations';

/**
 * Session secrets the user saved for every Session they own. Metadata only:
 * the key itself is never returned, so nothing here can be copied out.
 */
export function SavedIntegrations() {
  const [secrets, setSecrets] = useState<SessionSecretMetadata[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(endpoint, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      if (!response.ok) throw new Error('Unavailable');
      const data = (await response.json()) as {
        secrets: SessionSecretMetadata[];
      };
      if (signal?.aborted) return;
      setSecrets(data.secrets);
      setError(null);
    } catch {
      if (!signal?.aborted) setError('Saved integrations are unavailable.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const active = (secrets ?? []).filter(
    (secret) =>
      !secret.revokedAt && new Date(secret.expiresAt).getTime() > Date.now(),
  );

  return (
    <Section icon={KeyRound} title="Saved integrations">
      <p className="text-sm text-muted-foreground">
        API keys you approved in a Session and chose to keep. Every Session you
        own, and every coding task launched from one, can use them until they
        expire or you revoke them here. Keys are never shown.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {secrets === null && !error ? <Skeleton className="h-16 w-full" /> : null}
      {secrets !== null && active.length === 0 && !error ? (
        <p className="text-sm text-muted-foreground">
          No saved integrations. When an agent asks you to approve a key in a
          Session, tick “Save integration” to keep it for future Sessions.
        </p>
      ) : null}
      {active.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {active.map((secret) => (
            <li
              key={secret.secretRef}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm font-medium">{secret.label}</p>
                <p className="break-all text-xs text-muted-foreground">
                  {secret.origin} · {secret.allowedMethods.join(', ')} · expires{' '}
                  {new Date(secret.expiresAt).toLocaleDateString()}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busyRef !== null}
                onClick={async () => {
                  setBusyRef(secret.secretRef);
                  try {
                    const response = await fetch(endpoint, {
                      method: 'DELETE',
                      cache: 'no-store',
                      credentials: 'same-origin',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ secretRef: secret.secretRef }),
                    });
                    if (!response.ok) throw new Error('Unavailable');
                    toast.success(`Revoked ${secret.label}.`);
                    await load();
                  } catch {
                    toast.error('Could not revoke the integration. Try again.');
                  } finally {
                    setBusyRef(null);
                  }
                }}
              >
                {busyRef === secret.secretRef ? 'Revoking…' : 'Revoke'}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
