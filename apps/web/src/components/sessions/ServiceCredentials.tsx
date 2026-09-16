'use client';

import { useEffect, useRef, useState } from 'react';
import {
  serviceCredentialCreateSchema,
  type ServiceCredentialPendingMetadata,
  type ServiceCredentialApprovals,
} from '@roomote/types';
import { toast } from 'sonner';
import {
  Button,
  Check,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
} from '@/components/system';

import {
  INTEGRATION_KEY_DIALOG_HASH,
  notifyIntegrationKeysChanged,
} from './integration-key-dialog';

export function ServiceCredentials({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [integrationName, setIntegrationName] = useState('integration');
  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) setIntegrationName('integration');
    if (!nextOpen && window.location.hash === INTEGRATION_KEY_DIALOG_HASH) {
      const url = new URL(window.location.href);
      url.hash = '';
      window.history.replaceState(window.history.state, '', url);
    }
  }
  useEffect(() => {
    const handleHash = () => {
      if (window.location.hash === INTEGRATION_KEY_DIALOG_HASH) setOpen(true);
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [sessionId]);
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        size="lg"
        className="ph-no-capture ph-mask ph-no-recording sentry-block"
      >
        <DialogHeader>
          <DialogTitle>
            Add API key integration for {integrationName}
          </DialogTitle>
          <DialogDescription>
            The key is encrypted in our deployment database and never sent to
            the provider. Manage in Settings → Integrations.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <ServiceCredentialsForm
            key={sessionId}
            sessionId={sessionId}
            onCancel={() => handleOpenChange(false)}
            onIntegrationNameChange={setIntegrationName}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ServiceCredentialsForm({
  sessionId,
  onCancel,
  onIntegrationNameChange,
}: {
  sessionId: string;
  onCancel: () => void;
  onIntegrationNameChange: (name: string) => void;
}) {
  const [pending, setPending] = useState<ServiceCredentialPendingMetadata[]>(
    [],
  );
  const [selectedRef, setSelectedRef] = useState('');
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        onIntegrationNameChange(data.pending[0]?.label ?? 'integration');
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
  }, [endpoint, onIntegrationNameChange]);

  return (
    <div className="space-y-4">
      {loading ? <Skeleton className="h-24 w-full" /> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
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
                  onIntegrationNameChange(
                    pending.find(
                      (item) => item.pendingRef === event.target.value,
                    )?.label ?? 'integration',
                  );
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
                  visibility: new FormData(event.currentTarget).get(
                    'visibility',
                  ),
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
                  await response.json();
                  notifyIntegrationKeysChanged();
                  toast.success('Integration saved.');
                  onCancel();
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
                <div className="space-y-2">
                  <Label id="service-credential-visibility-label">
                    Who can use this integration?
                  </Label>
                  <RadioGroup
                    key={selected.pendingRef}
                    name="visibility"
                    defaultValue={selected.visibility}
                    aria-labelledby="service-credential-visibility-label"
                    className="grid grid-cols-2 gap-3"
                  >
                    <Label className="flex cursor-pointer items-center gap-2 rounded-md border p-3 font-normal">
                      <RadioGroupItem value="owner" />
                      Only me
                    </Label>
                    <Label className="flex cursor-pointer items-center gap-2 rounded-md border p-3 font-normal">
                      <RadioGroupItem value="deployment" />
                      Everyone in this deployment
                    </Label>
                  </RadioGroup>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={onCancel}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy}>
                    <Check />
                    Save
                  </Button>
                </div>
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
