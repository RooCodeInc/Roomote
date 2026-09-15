'use client';

import { useEffect, useRef, useState } from 'react';
import {
  serviceCredentialCreateSchema,
  type ServiceCredentialPendingMetadata,
  type ServiceCredentialApprovals,
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

import { INTEGRATION_KEY_DIALOG_HASH } from './integration-key-dialog';

export function ServiceCredentials({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handleHash = () => {
      if (window.location.hash === INTEGRATION_KEY_DIALOG_HASH) setOpen(true);
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [sessionId]);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen && window.location.hash === INTEGRATION_KEY_DIALOG_HASH) {
          const url = new URL(window.location.href);
          url.hash = '';
          window.history.replaceState(window.history.state, '', url);
        }
      }}
    >
      <DialogContent
        size="lg"
        className="ph-no-capture ph-mask ph-no-recording sentry-block"
      >
        <DialogHeader>
          <DialogTitle>Approve API key</DialogTitle>
          <DialogDescription>
            Enter it here, never in chat. It becomes an integration for every
            Session you own; manage it under Settings → Integrations.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <ServiceCredentialsForm key={sessionId} sessionId={sessionId} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ServiceCredentialsForm({ sessionId }: { sessionId: string }) {
  const [pending, setPending] = useState<ServiceCredentialPendingMetadata[]>(
    [],
  );
  const [selectedRef, setSelectedRef] = useState('');
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
        const data = (await response.json()) as ServiceCredentialApprovals;
        if (controller.signal.aborted) return;
        setPending(data.pending);
        setSelectedRef(data.pending[0]?.pendingRef ?? '');
        setAvailable(true);
      } catch {
        if (!controller.signal.aborted)
          setError(
            "API key approval is unavailable. Sign in as this Session's owner and try again.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [endpoint]);

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
          {pending.length > 1 ? (
            <div className="space-y-1">
              <Label htmlFor="service-credential-request">
                Prepared request
              </Label>
              <select
                id="service-credential-request"
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
                const parsed = serviceCredentialCreateSchema.safeParse({
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
                    resumed: boolean;
                  };
                  const remaining = pending.filter(
                    (item) => item.pendingRef !== selected.pendingRef,
                  );
                  setPending(remaining);
                  setSelectedRef(remaining[0]?.pendingRef ?? '');
                  setNotice(
                    data.resumed
                      ? 'Integration saved. The Session has been notified without sharing your key.'
                      : 'Integration saved. The Session could not be notified. Ask the agent to check list_integration_keys and continue.',
                  );
                } catch {
                  clearForm();
                  setError(
                    'Could not save the approval. It may have expired or already been used. Reopen the approval link to refresh, then re-enter the API key.',
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
                  id="service-credential-destination"
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
                <p className="text-sm text-muted-foreground">
                  {selected.lifetimeHours
                    ? `Expires ${selected.lifetimeHours} hours after you save it.`
                    : 'Kept until you revoke it under Settings → Integrations.'}
                </p>
                <div className="space-y-1">
                  <Label htmlFor="service-credential-value">API key</Label>
                  <Input
                    key={inputVersion}
                    id="service-credential-value"
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
                  aria-describedby="service-credential-destination"
                >
                  Save integration
                </Button>
              </fieldset>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              No requests awaiting an API key. Ask the agent to prepare access
              for the service you need. Do not send your key in chat.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
