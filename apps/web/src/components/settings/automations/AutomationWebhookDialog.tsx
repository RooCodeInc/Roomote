'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { automationWebhookConfigSchema } from '@roomote/types';
import { toast } from 'sonner';
import { useTRPC } from '@/trpc/client';
import { useAuthorizedUser } from '@/hooks/useUser';
import { Section } from '@/components/settings';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Skeleton,
  Switch,
  Settings2,
} from '@/components/system';

export function AutomationWebhookDialog({
  automationId,
  name,
  open,
  onOpenChange,
}: {
  automationId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const [remoteCleanup, setRemoteCleanup] = useState<{
    providerEndpointId: string | null;
    callbackUrl: string;
  } | null>(null);
  const query = useQuery(
    trpc.automations.getAutomationWebhook.queryOptions(
      { automationId },
      { enabled: open, refetchInterval: open ? 10_000 : false },
    ),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Granola trigger</DialogTitle>
          <DialogDescription>
            {name}: run when meeting notes become available.
          </DialogDescription>
        </DialogHeader>
        {remoteCleanup ? (
          <div role="alert" className="space-y-2 rounded-md border p-3 text-sm">
            <p className="font-medium">
              Local binding removed. Granola cleanup is still required.
            </p>
            <p>
              Remove the owned webhook in Granola before considering cleanup
              complete. These details remain visible until you close this
              dialog.
            </p>
            <p className="break-all">
              Endpoint:{' '}
              {remoteCleanup.providerEndpointId ??
                'Unknown; locate by callback URL'}
            </p>
            <p className="break-all">Callback: {remoteCleanup.callbackUrl}</p>
          </div>
        ) : null}
        {query.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : query.isError ? (
          <div role="alert" className="space-y-3">
            <p>Could not load this trigger: {query.error.message}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <WebhookSettings
            key={`${automationId}:${query.data?.updatedAt ?? 'new'}`}
            automationId={automationId}
            webhook={query.data ?? null}
            onRemoteCleanup={setRemoteCleanup}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type WebhookView = {
  enabled: boolean;
  status: string;
  events: string[];
  folderIds: string[];
  scopes: string[];
  maxRunsPerDay: number;
  lastError: string | null;
  deliveries: {
    id: string;
    eventType: string;
    noteId: string;
    status: string;
    attempts: number;
    lastError: string | null;
    canRetry: boolean;
    sessionId?: string | null;
  }[];
};

function WebhookSettings({
  automationId,
  webhook,
  onRemoteCleanup,
}: {
  automationId: string;
  webhook: WebhookView | null;
  onRemoteCleanup: (details: {
    providerEndpointId: string | null;
    callbackUrl: string;
  }) => void;
}) {
  const { isAdmin } = useAuthorizedUser();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [events, setEvents] = useState(
    webhook?.events ?? ['note.generated', 'note.access_granted'],
  );
  const [scopes, setScopes] = useState(webhook?.scopes ?? ['workspace']);
  const [folders, setFolders] = useState(webhook?.folderIds.join(', ') ?? '');
  const [cap, setCap] = useState(String(webhook?.maxRunsPerDay ?? 20));
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.automations.getAutomationWebhook.queryKey({
        automationId,
      }),
    });
  const configure = useMutation(
    trpc.automations.configureAutomationWebhook.mutationOptions({
      onSuccess: async () => {
        toast.success('Trigger configuration saved. Check its status below.');
        await refresh();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const remove = useMutation(
    trpc.automations.removeAutomationWebhook.mutationOptions({
      onSuccess: async (result) => {
        if (result.remoteCleanupRequired) {
          onRemoteCleanup(result.remoteCleanupRequired);
          toast.warning(
            'Removed locally only. Remove the orphaned webhook in Granola.',
          );
        } else {
          toast.success('Trigger removed.');
        }
        await refresh();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const retry = useMutation(
    trpc.automations.retryAutomationWebhookDelivery.mutationOptions({
      onSuccess: async () => {
        toast.success('Delivery queued for retry, not yet completed.');
        await refresh();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const busy = configure.isPending || remove.isPending || retry.isPending;
  const locked = !isAdmin || busy;

  return (
    <div className="space-y-4">
      <Section
        icon={Settings2}
        title="Managed webhook"
        action={
          <Badge
            variant={
              webhook?.status === 'active'
                ? 'success'
                : webhook?.status === 'error'
                  ? 'destructive'
                  : 'warning'
            }
          >
            {webhook
              ? `${webhook.status}${!webhook.enabled ? ' (disabled)' : ''}`
              : 'Not configured'}
          </Badge>
        }
      >
        <p className="text-sm text-muted-foreground">
          An admin must approve, bind, edit, or remove this trigger using the
          deployment&apos;s shared Granola connection. Owners can inspect
          deliveries and retry failures.
        </p>
        <p className="text-sm text-muted-foreground">
          This connection may access notes beyond your personal account. Review
          the automation prompt and report destination before enabling it:
          meeting data can be shared with everyone in that destination.
        </p>
        {webhook?.lastError ? (
          <p role="alert" className="break-words text-sm text-destructive">
            {webhook.lastError}
          </p>
        ) : null}
        {webhook?.status === 'pending' || webhook?.status === 'deleting' ? (
          <p role="status" className="text-sm">
            Remote setup or cleanup is pending. This is not confirmation of an
            active subscription. Interrupted setup or cleanup can be retried
            after two minutes; the server checks whether an operation is still
            active.
          </p>
        ) : null}
        <fieldset disabled={locked} className="space-y-4">
          <legend className="sr-only">
            Granola subscription configuration
          </legend>
          <div className="flex items-center gap-2">
            <Switch
              id="granola-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
            <Label htmlFor="granola-enabled">Enable webhook trigger</Label>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Events</p>
            {[
              ['note.generated', 'Note generated'],
              ['note.access_granted', 'Note access granted'],
              ['note.edited', 'Note edited (opt-in; may run frequently)'],
            ].map(([value, label]) => (
              <div key={value} className="flex items-center gap-2">
                <Checkbox
                  id={value}
                  checked={events.includes(value!)}
                  onCheckedChange={(checked) =>
                    setEvents(
                      checked
                        ? [...events, value!]
                        : events.filter((event) => event !== value),
                    )
                  }
                />
                <Label htmlFor={value}>{label}</Label>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Scopes</p>
            {[
              [
                'workspace',
                'Workspace: notes visible to the connected workspace key (default).',
              ],
              [
                'personal',
                'Personal: notes owned by the connected credential holder, not necessarily you.',
              ],
              [
                'public',
                'Public: notes visible to everyone in the Granola workspace.',
              ],
            ].map(([value, label]) => (
              <div key={value} className="flex items-start gap-2">
                <Checkbox
                  id={`scope-${value}`}
                  checked={scopes.includes(value!)}
                  onCheckedChange={(checked) =>
                    setScopes(
                      checked
                        ? value === 'workspace'
                          ? ['workspace']
                          : [
                              ...scopes.filter(
                                (scope) => scope !== 'workspace',
                              ),
                              value!,
                            ]
                        : scopes.filter((scope) => scope !== value),
                    )
                  }
                />
                <Label htmlFor={`scope-${value}`} className="leading-5">
                  {label}
                </Label>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Workspace cannot be combined with personal or public. The
              connected credential must support the selected scopes.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="granola-folders">Folder IDs (optional)</Label>
            <Input
              id="granola-folders"
              value={folders}
              onChange={(event) => setFolders(event.target.value)}
              placeholder="Comma-separated fol_ IDs"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty for all folders within the selected scope.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="granola-cap">Maximum runs per day</Label>
            <Input
              id="granola-cap"
              type="number"
              min={1}
              max={100}
              step={1}
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              1-100 runs; default 20. This is a spend safeguard, not an exact
              dollar budget. Scheduled and manual runs are separate.
            </p>
          </div>
        </fieldset>
        {isAdmin ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            {webhook ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm('Remove this Granola webhook subscription?')
                  )
                    remove.mutate({ automationId });
                }}
              >
                Remove trigger
              </Button>
            ) : null}
            <Button
              disabled={locked}
              onClick={() => {
                const parsed = automationWebhookConfigSchema.safeParse({
                  events,
                  scopes,
                  folderIds: folders
                    .split(',')
                    .map((id) => id.trim())
                    .filter(Boolean),
                  maxRunsPerDay: Number(cap),
                  enabled,
                });
                if (!parsed.success) {
                  toast.error(
                    parsed.error.issues[0]?.message ??
                      'Check the trigger settings.',
                  );
                  return;
                }
                configure.mutate({ automationId, config: parsed.data });
              }}
            >
              {configure.isPending
                ? 'Saving...'
                : webhook
                  ? 'Save trigger'
                  : 'Approve and create trigger'}
            </Button>
          </div>
        ) : null}
        {isAdmin && webhook?.status === 'error' ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              If provider credentials cannot be restored, emergency removal
              forgets only the local binding. You must remove the orphaned
              subscription in Granola. Active runs still block removal.
            </p>
            <Button
              variant="destructive"
              className="h-auto whitespace-normal"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Remove locally without Granola cleanup? This leaves an orphaned webhook in Granola. You must remove that subscription in Granola yourself.',
                  )
                ) {
                  remove.mutate({ automationId, forceLocalRemoval: true });
                }
              }}
            >
              Remove locally without Granola cleanup
            </Button>
          </div>
        ) : null}
      </Section>
      <Section title="Recent deliveries">
        <p className="text-xs text-muted-foreground">
          Retries remain subject to server eligibility, retry limits, and the
          daily cap. Running or previously executed deliveries cannot be
          replayed. Queued is not completed. Terminal delivery records are
          retained for seven days.
        </p>
        {webhook?.deliveries.length ? (
          <ul className="divide-y">
            {webhook.deliveries.map((delivery) => (
              <li key={delivery.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {delivery.eventType}
                  </span>
                  <Badge
                    variant={
                      delivery.status === 'failed'
                        ? 'destructive'
                        : delivery.status === 'succeeded'
                          ? 'success'
                          : 'secondary'
                    }
                  >
                    {delivery.status}
                  </Badge>
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  Note {delivery.noteId} · {delivery.attempts} attempts
                </p>
                {delivery.sessionId ? (
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={`/sessions/${encodeURIComponent(delivery.sessionId)}`}
                    >
                      View Session
                    </Link>
                  </Button>
                ) : null}
                {delivery.lastError ? (
                  <p className="break-words text-sm text-destructive">
                    {delivery.lastError}
                  </p>
                ) : null}
                {delivery.canRetry ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      busy || webhook.status !== 'active' || !webhook.enabled
                    }
                    onClick={() =>
                      retry.mutate({ automationId, deliveryId: delivery.id })
                    }
                  >
                    Retry delivery
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No deliveries yet.</p>
        )}
      </Section>
    </div>
  );
}
