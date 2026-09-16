'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Pencil,
  Plus,
  Plug,
  Skeleton,
  Trash2,
} from '@/components/system';

import type { IntegrationItem } from './integration-card';
import { IntegrationListRow } from './integration-card';
import { Section } from './Section';

const endpoint = '/api/account/integrations';
const readOnly: CredentialEgressMethod[] = ['GET', 'HEAD'];
type IntegrationView = 'shared' | 'personal';

function describeExpiry(secret: ServiceCredentialMetadata) {
  return secret.expiresAt
    ? `expires ${new Date(secret.expiresAt).toLocaleDateString()}`
    : 'kept until revoked';
}

/**
 * API keys available to the user for HTTPS services. Metadata only: the key
 * is never returned, so nothing here can be copied out.
 */
export function useYourIntegrations(view: IntegrationView = 'shared'): {
  items: IntegrationItem[];
  isLoading: boolean;
  error: string | null;
  openAddDialog: () => void;
  dialogs: ReactNode;
} {
  const [secrets, setSecrets] = useState<ServiceCredentialMetadata[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] =
    useState<ServiceCredentialMetadata | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(`${endpoint}?view=${view}`, {
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
    },
    [view],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const active = (secrets ?? []).filter((secret) => {
    const isLive =
      !secret.revokedAt &&
      (!secret.expiresAt || new Date(secret.expiresAt).getTime() > Date.now());
    const isInView =
      view === 'shared'
        ? secret.visibility === 'deployment'
        : secret.visibility === 'owner' && !secret.ownerName;
    return isLive && isInView;
  });

  const updateVisibility = async (
    secret: ServiceCredentialMetadata,
    visibility: ServiceCredentialVisibility,
  ) => {
    setBusyRef(secret.secretRef);
    try {
      const response = await fetch(endpoint, {
        method: 'PATCH',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secretRef: secret.secretRef, visibility }),
      });
      if (!response.ok) throw new Error('Unavailable');
      toast.success(`Updated ${secret.label}.`);
      setConfiguring(null);
      await load();
    } catch {
      toast.error('Could not update the integration. Try again.');
    } finally {
      setBusyRef(null);
    }
  };

  const remove = async (secret: ServiceCredentialMetadata) => {
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
      toast.success(`${secret.label} removed.`);
      await load();
    } catch {
      toast.error('Could not remove the integration. Try again.');
    } finally {
      setBusyRef(null);
    }
  };

  const items = useMemo<IntegrationItem[]>(
    () =>
      active.map((secret) => ({
        id: `api-key-${secret.secretRef}`,
        name: secret.label,
        description: `${secret.origin} · ${secret.allowedMethods.join(', ')} · ${describeExpiry(secret)}`,
        icon: <KeyRound className="size-4" />,
        enabled: true,
        isMcpBased: false,
        isPending: busyRef === secret.secretRef,
        status:
          view === 'shared' && secret.ownerName
            ? `Owned by ${secret.ownerName}`
            : undefined,
        configureAction:
          view === 'shared' && secret.canManage
            ? {
                label: 'Configure',
                ariaLabel: `Configure ${secret.label}`,
                onAction: () => setConfiguring(secret),
                isPending: busyRef === secret.secretRef,
                icon: <Pencil />,
              }
            : undefined,
        removeAction: secret.canManage
          ? {
              label: 'Remove',
              ariaLabel: `Remove ${secret.label}`,
              onAction: () => void remove(secret),
              isPending: busyRef === secret.secretRef,
              icon: <Trash2 />,
              confirmationDescription:
                'This API-key integration and its stored key will be permanently removed. This cannot be undone.',
            }
          : undefined,
      })),
    // `active` is derived from the latest fetch and intentionally rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [secrets, busyRef, view],
  );

  const dialogs = (
    <>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent
          size="xl"
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
              visibility={view === 'personal' ? 'owner' : undefined}
              onSaved={async () => {
                setAdding(false);
                await load();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={configuring != null}
        onOpenChange={(open) => {
          if (!open) setConfiguring(null);
        }}
      >
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>
              Configure {configuring?.label ?? 'integration'}
            </DialogTitle>
            <DialogDescription>
              Control who can use this API-key integration. The stored key is
              never returned to the browser.
            </DialogDescription>
          </DialogHeader>
          {configuring ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="integration-config-visibility">
                  Who can use this integration?
                </Label>
                <select
                  id="integration-config-visibility"
                  defaultValue={configuring.visibility}
                  disabled={busyRef != null}
                  className="h-9 w-full rounded-md border bg-card px-3 text-sm"
                  onChange={(event) =>
                    void updateVisibility(
                      configuring,
                      event.target.value as ServiceCredentialVisibility,
                    )
                  }
                >
                  <option value="deployment">
                    Everyone in this deployment
                  </option>
                  <option value="owner">Only me</option>
                </select>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );

  return {
    items,
    isLoading: secrets === null && !error,
    error,
    openAddDialog: () => setAdding(true),
    dialogs,
  };
}

export function YourIntegrations() {
  const { items, isLoading, error, openAddDialog, dialogs } =
    useYourIntegrations();

  return (
    <div>
      <Button variant="outline" size="sm" onClick={openAddDialog}>
        Add integration
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {isLoading ? <Skeleton className="h-16 w-full" /> : null}
      {!isLoading && items.length === 0 && !error ? (
        <p className="text-sm text-muted-foreground">No integrations yet.</p>
      ) : null}
      {items.map((item) => (
        <IntegrationListRow key={item.id} item={item} />
      ))}
      {dialogs}
    </div>
  );
}

export function PersonalIntegrations() {
  const { items, isLoading, error, openAddDialog, dialogs } =
    useYourIntegrations('personal');

  return (
    <Section
      icon={Plug}
      title="Personal integrations"
      action={
        <Button variant="outline" size="sm" onClick={openAddDialog}>
          <Plus />
          Add personal integration
        </Button>
      }
    >
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div role="table" aria-label="Personal integrations">
        <div role="rowgroup" className="divide-y divide-background">
          {isLoading ? <Skeleton className="h-16 w-full" /> : null}
          {items.map((item) => (
            <IntegrationListRow key={item.id} item={item} stackDescription />
          ))}
          {!isLoading && items.length === 0 && !error ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No personal integrations yet.
            </p>
          ) : null}
        </div>
      </div>
      {dialogs}
    </Section>
  );
}

function AddIntegrationForm({
  onSaved,
  visibility,
}: {
  onSaved: () => Promise<void>;
  visibility?: ServiceCredentialVisibility;
}) {
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
          visibility: visibility ?? form.get('visibility'),
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
        {visibility === undefined ? (
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
        ) : null}
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
