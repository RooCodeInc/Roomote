'use client';

import { useEffect, useRef, useState } from 'react';
import {
  sessionSecretCreateSchema,
  type SessionSecretMetadata,
  type SessionSecretPendingMetadata,
  type SessionSecretApprovals,
} from '@roomote/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Skeleton,
} from '@/components/system';

export function SessionSecrets({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handleHash = () => {
      if (window.location.hash === '#session-secrets') setOpen(true);
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [sessionId]);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Session secrets
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          size="lg"
          className="ph-no-capture ph-mask ph-no-recording sentry-block"
        >
          <DialogHeader>
            <DialogTitle>Session secrets</DialogTitle>
            <DialogDescription>
              Approve an API key for this Session. Enter it here, never in chat.
            </DialogDescription>
          </DialogHeader>
          {open ? (
            <SessionSecretsForm key={sessionId} sessionId={sessionId} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SessionSecretsForm({ sessionId }: { sessionId: string }) {
  const [pending, setPending] = useState<SessionSecretPendingMetadata[]>([]);
  const [selectedRef, setSelectedRef] = useState('');
  const [secrets, setSecrets] = useState<SessionSecretMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [inputVersion, setInputVersion] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/secrets`;
  const selected = pending.find((item) => item.pendingRef === selectedRef);
  function clearForm() {
    formRef.current?.reset();
    // Also reset the shared secret input's reveal state and retained value.
    setInputVersion((version) => version + 1);
  }
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(endpoint, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Unavailable');
        const data = (await response.json()) as SessionSecretApprovals;
        if (controller.signal.aborted) return;
        setPending(data.pending);
        setSelectedRef(data.pending[0]?.pendingRef ?? '');
        setSecrets(data.secrets);
        setAvailable(true);
      } catch {
        if (!controller.signal.aborted)
          setError(
            "Secret management is unavailable. Sign in as this Session's owner and try again.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [endpoint]);

  async function revoke(secretRef: string) {
    if (busy) return;
    clearForm();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: 'DELETE',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secretRef }),
      });
      if (!response.ok) throw new Error('Unavailable');
      setSecrets((current) =>
        current.map((secret) =>
          secret.secretRef === secretRef
            ? { ...secret, revokedAt: new Date().toISOString() }
            : secret,
        ),
      );
      setNotice('Revoked. Future requests using this API key are denied.');
    } catch {
      setError('Could not revoke the API key. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {loading ? <Skeleton className="h-24 w-full" /> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {available ? (
        <>
          {!managing ? (
            <>
              {pending.length > 1 ? (
                <div className="space-y-1">
                  <Label htmlFor="session-secret-request">
                    Prepared request
                  </Label>
                  <select
                    id="session-secret-request"
                    className="h-9 w-full rounded-md border bg-card px-3 text-sm"
                    value={selectedRef}
                    disabled={busy}
                    onChange={(event) => {
                      clearForm();
                      setSelectedRef(event.target.value);
                      setError(null);
                    }}
                  >
                    {pending.map((item) => (
                      <option key={item.pendingRef} value={item.pendingRef}>
                        {item.label} - {item.origin}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {selected ? (
                <form
                  ref={formRef}
                  className="space-y-3"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (busy) return;
                    if (new Date(selected.expiresAt).getTime() <= Date.now()) {
                      clearForm();
                      setError(
                        'This request has expired. Ask the agent to prepare a new request.',
                      );
                      return;
                    }
                    const parsed = sessionSecretCreateSchema.safeParse({
                      pendingRef: selected.pendingRef,
                      secret: new FormData(event.currentTarget).get('secret'),
                      allowedMethods: selected.allowedMethods,
                    });
                    if (
                      !parsed.success ||
                      /[^\x21-\x7e]/.test(parsed.data.secret)
                    ) {
                      setError(
                        'Enter an API key of 8 to 4096 printable ASCII characters, without spaces.',
                      );
                      return;
                    }
                    setBusy(true);
                    setError(null);
                    setNotice(null);
                    try {
                      // Keep the credential out of conversation state and telemetry.
                      const request = fetch(endpoint, {
                        method: 'POST',
                        cache: 'no-store',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(parsed.data),
                      });
                      clearForm();
                      const response = await request;
                      if (!response.ok) throw new Error('Unavailable');
                      const data = (await response.json()) as {
                        secret: SessionSecretMetadata;
                        resumed: boolean;
                      };
                      setSecrets((current) => [data.secret, ...current]);
                      const remaining = pending.filter(
                        (item) => item.pendingRef !== selected.pendingRef,
                      );
                      setPending(remaining);
                      setSelectedRef(remaining[0]?.pendingRef ?? '');
                      setNotice(
                        data.resumed
                          ? 'API key saved. The Session has been notified without sharing your key.'
                          : 'API key saved. The Session could not be notified. Ask the agent to check list_session_secrets and continue.',
                      );
                    } catch {
                      clearForm();
                      setError(
                        'Could not save the approval. It may have expired or already been used. Reopen Session secrets to refresh, then re-enter the API key.',
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <fieldset disabled={busy} className="space-y-3">
                    <h3 className="break-words text-sm font-medium">
                      Add your {selected.label} API key
                    </h3>
                    <p
                      id="session-secret-destination"
                      className="break-all text-sm text-muted-foreground"
                    >
                      For {new URL(selected.origin).origin} -{' '}
                      {selected.allowedMethods.join(', ')}
                      {selected.allowedMethods.some(
                        (method) => method !== 'GET' && method !== 'HEAD',
                      )
                        ? ' (allows writes)'
                        : ''}
                    </p>
                    <div className="space-y-1">
                      <Label htmlFor="session-secret-value">API key</Label>
                      <Input
                        key={inputVersion}
                        id="session-secret-value"
                        name="secret"
                        secret
                        required
                        minLength={8}
                        maxLength={4096}
                        autoComplete="off"
                        spellCheck={false}
                        className="ph-no-capture ph-mask sentry-mask"
                      />
                    </div>
                    <Button
                      type="submit"
                      disabled={busy}
                      aria-describedby="session-secret-destination"
                    >
                      Allow for this Session
                    </Button>
                  </fieldset>
                </form>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No requests awaiting an API key. Ask the agent to prepare
                  access for the service you need. Do not send your key in chat.
                </p>
              )}
            </>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              clearForm();
              setManaging(!managing);
              setError(null);
              setNotice(null);
            }}
          >
            {managing ? 'Back to pending requests' : 'Manage approved secrets'}
          </Button>
          {managing ? (
            <section aria-label="Approved secrets" className="space-y-3">
              <h3 className="text-sm font-semibold">Approved secrets</h3>
              {secrets.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No approved secrets.
                </p>
              ) : null}
              {secrets.map((secret) => (
                <div
                  key={secret.secretRef}
                  className="space-y-2 rounded-md border p-3 text-sm"
                >
                  <p className="break-all font-medium">
                    {secret.label} (
                    {secret.revokedAt
                      ? 'revoked'
                      : new Date(secret.expiresAt).getTime() <= Date.now()
                        ? 'expired'
                        : 'ready'}
                    )
                  </p>
                  <p className="break-all">{secret.origin}</p>
                  <p>
                    {secret.allowedMethods.join(', ')} requests send your key in
                    the <code>{secret.headerName}</code> header
                    {secret.headerPrefix ? (
                      <>
                        {' '}
                        after <code>
                          {JSON.stringify(secret.headerPrefix)}
                        </code>{' '}
                        (including the space)
                      </>
                    ) : (
                      ' with no prefix'
                    )}
                    .
                  </p>
                  <p>Expires {new Date(secret.expiresAt).toLocaleString()}</p>
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={busy || Boolean(secret.revokedAt)}
                    onClick={() => void revoke(secret.secretRef)}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
