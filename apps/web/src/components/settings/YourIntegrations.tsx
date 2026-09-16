'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  integrationCreateSchema,
  CREDENTIAL_EGRESS_METHODS,
  type CredentialEgressMethod,
  type ServiceCredentialMetadata,
  type ServiceCredentialVisibility,
} from '@roomote/types';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  KeyRound,
  Label,
  Skeleton,
} from '@/components/system';

import { Section } from './Section';

const endpoint = '/api/account/integrations';
const readOnly: CredentialEgressMethod[] = ['GET', 'HEAD'];

function describeExpiry(secret: ServiceCredentialMetadata) {
  return secret.expiresAt
    ? `expires ${new Date(secret.expiresAt).toLocaleDateString()}`
    : 'kept until revoked';
}

/**
 * API keys available to the user for HTTPS services. Metadata only: the key
 * is never returned, so nothing here can be copied out.
 */
export function YourIntegrations() {
  const [secrets, setSecrets] = useState<ServiceCredentialMetadata[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(endpoint, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      if (!response.ok) throw new Error('Unavailable');
      const data = (await response.json()) as {
        secrets: ServiceCredentialMetadata[];
      };
      if (signal?.aborted) return;
      setSecrets(data.secrets);
      setError(null);
    } catch {
      if (!signal?.aborted) setError('Integrations are unavailable.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const active = (secrets ?? []).filter(
    (secret) =>
      !secret.revokedAt &&
      (!secret.expiresAt || new Date(secret.expiresAt).getTime() > Date.now()),
  );

  return (
    <Section
      icon={KeyRound}
      title="Your integrations"
      action={
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          Add integration
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        API keys for services you use. Choose whether each integration is only
        for you or available to everyone in this deployment. Roomote keeps the
        key server-side and sends it only to the approved service.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {secrets === null && !error ? <Skeleton className="h-16 w-full" /> : null}
      {secrets !== null && active.length === 0 && !error ? (
        <p className="text-sm text-muted-foreground">No integrations yet.</p>
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
                  {secret.origin} · {secret.allowedMethods.join(', ')} ·{' '}
                  {describeExpiry(secret)}
                </p>
                {secret.sharedBy ? (
                  <p className="text-xs text-muted-foreground">
                    Shared by {secret.sharedBy}
                  </p>
                ) : null}
              </div>
              {secret.canManage ? (
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Visibility for ${secret.label}`}
                    value={secret.visibility}
                    disabled={busyRef !== null}
                    className="h-9 rounded-md border bg-card px-3 text-sm"
                    onChange={async (event) => {
                      const visibility = event.target
                        .value as ServiceCredentialVisibility;
                      setBusyRef(secret.secretRef);
                      try {
                        const response = await fetch(endpoint, {
                          method: 'PATCH',
                          cache: 'no-store',
                          credentials: 'same-origin',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            secretRef: secret.secretRef,
                            visibility,
                          }),
                        });
                        if (!response.ok) throw new Error('Unavailable');
                        toast.success(`Updated ${secret.label}.`);
                        await load();
                      } catch {
                        toast.error(
                          'Could not update the integration. Try again.',
                        );
                      } finally {
                        setBusyRef(null);
                      }
                    }}
                  >
                    <option value="deployment">Everyone</option>
                    <option value="owner">Only me</option>
                  </select>
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
                          body: JSON.stringify({
                            secretRef: secret.secretRef,
                          }),
                        });
                        if (!response.ok) throw new Error('Unavailable');
                        toast.success(`Revoked ${secret.label}.`);
                        await load();
                      } catch {
                        toast.error(
                          'Could not revoke the integration. Try again.',
                        );
                      } finally {
                        setBusyRef(null);
                      }
                    }}
                  >
                    {busyRef === secret.secretRef ? 'Revoking…' : 'Revoke'}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent
          size="lg"
          className="ph-no-capture ph-mask ph-no-recording sentry-block"
        >
          <DialogHeader>
            <DialogTitle>Add integration</DialogTitle>
            <DialogDescription>
              The key is stored encrypted and only ever sent to the origin you
              name here. Approve a least-privilege, disposable key.
            </DialogDescription>
          </DialogHeader>
          {adding ? (
            <AddIntegrationForm
              onSaved={async () => {
                setAdding(false);
                await load();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function AddIntegrationForm({ onSaved }: { onSaved: () => Promise<void> }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [headerName, setHeaderName] = useState('authorization');
  const [methods, setMethods] = useState<CredentialEgressMethod[]>(readOnly);
  return (
    <form
      ref={formRef}
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = new FormData(event.currentTarget);
        const lifetime = String(form.get('lifetimeHours') ?? '').trim();
        const parsed = integrationCreateSchema.safeParse({
          label: form.get('label'),
          origin: form.get('origin'),
          headerName: String(form.get('headerName') ?? '')
            .trim()
            .toLowerCase(),
          headerPrefix:
            headerName === 'authorization' ? form.get('headerPrefix') : '',
          allowedMethods: methods,
          visibility: form.get('visibility'),
          ...(lifetime ? { lifetimeHours: Number(lifetime) } : {}),
          secret: form.get('secret'),
        });
        if (!parsed.success || /[^\x21-\x7e]/.test(parsed.data.secret)) {
          setError(
            'Check the fields: an HTTPS origin, a header name, at least one method, an optional lifetime in hours, and a key of 8 to 4096 printable characters.',
          );
          return;
        }
        setBusy(true);
        setError(null);
        try {
          // Keep the credential out of component state and telemetry.
          const request = fetch(endpoint, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed.data),
          });
          formRef.current?.reset();
          const response = await request;
          if (!response.ok) throw new Error('Unavailable');
          toast.success('Integration saved.');
          await onSaved();
        } catch {
          setError(
            'Could not save the integration. Check the origin is a public HTTPS address and try again.',
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy} className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="integration-label">Name</Label>
          <Input id="integration-label" name="label" required maxLength={80} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="integration-origin">Service origin</Label>
          <Input
            id="integration-origin"
            name="origin"
            required
            placeholder="https://api.example.com"
            inputMode="url"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="integration-header">
              Header that carries the key
            </Label>
            <Input
              id="integration-header"
              name="headerName"
              required
              value={headerName}
              onChange={(event) => setHeaderName(event.target.value)}
            />
          </div>
          {headerName.trim().toLowerCase() === 'authorization' ? (
            <div className="space-y-1">
              <Label htmlFor="integration-prefix">Scheme</Label>
              <select
                id="integration-prefix"
                name="headerPrefix"
                defaultValue="Bearer "
                className="h-9 w-full rounded-md border bg-card px-3 text-sm"
              >
                <option value="Bearer ">Bearer</option>
                <option value="Token ">Token</option>
                <option value="Basic ">Basic</option>
                <option value="">None</option>
              </select>
            </div>
          ) : null}
        </div>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Allowed methods</legend>
          <div className="flex flex-wrap gap-3">
            {CREDENTIAL_EGRESS_METHODS.map((method) => (
              <label key={method} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={methods.includes(method)}
                  onChange={(event) =>
                    setMethods((current) =>
                      event.target.checked
                        ? [...current, method]
                        : current.filter((item) => item !== method),
                    )
                  }
                />
                {method}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="space-y-1">
          <Label htmlFor="integration-lifetime">
            Lifetime in hours (leave empty to keep until revoked)
          </Label>
          <Input
            id="integration-lifetime"
            name="lifetimeHours"
            type="number"
            min={1}
            max={8760}
            inputMode="numeric"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="integration-visibility">
            Who can use this integration?
          </Label>
          <select
            id="integration-visibility"
            name="visibility"
            defaultValue="deployment"
            className="h-9 w-full rounded-md border bg-card px-3 text-sm"
          >
            <option value="deployment">Everyone in this deployment</option>
            <option value="owner">Only me</option>
          </select>
          <p className="text-sm text-muted-foreground">
            Anyone in this deployment can make requests with a shared
            integration. The API key always stays server-side.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="integration-secret">API key</Label>
          <Input
            id="integration-secret"
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
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={busy}>
          Save integration
        </Button>
      </fieldset>
    </form>
  );
}
