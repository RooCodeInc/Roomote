'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { Section } from '@/components/settings';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  KeyRound,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/components/system';

function timestamp(value: number | null) {
  return value === null
    ? 'Not recorded'
    : new Date(value * 1000).toLocaleString();
}

export function ConnectedMcpClients({
  userId,
  userLabel = 'your account',
}: {
  userId?: string;
  userLabel?: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<{
    grantId?: string;
    name: string;
  } | null>(null);
  const query = useQuery(trpc.mcpAuthorizations.list.queryOptions({ userId }));
  const onSuccess = async () => {
    setPending(null);
    toast.success('MCP access revoked');
    await queryClient.invalidateQueries({
      queryKey: trpc.mcpAuthorizations.list.queryKey(),
    });
  };
  const onError = (error: { message: string }) => toast.error(error.message);
  const revoke = useMutation(
    trpc.mcpAuthorizations.revoke.mutationOptions({ onSuccess, onError }),
  );
  const revokeAll = useMutation(
    trpc.mcpAuthorizations.revokeAll.mutationOptions({ onSuccess, onError }),
  );
  const busy = revoke.isPending || revokeAll.isPending;

  return (
    <Section
      icon={KeyRound}
      title="Connected MCP clients"
      action={
        query.data?.length ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPending({ name: 'all MCP clients' })}
          >
            Revoke all
          </Button>
        ) : undefined
      }
    >
      <p className="text-sm text-muted-foreground">
        Clients authorized to access Roomote as {userLabel}. Revoking access
        stops subsequent requests and requires reconnecting the client.
      </p>
      {query.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : query.isError ? (
        <div className="space-y-2">
          <ErrorState
            title="Could not load MCP clients"
            description="Try again to check connected clients."
          />
          <Button variant="outline" onClick={() => query.refetch()}>
            Try again
          </Button>
        </div>
      ) : !query.data?.length ? (
        <EmptyState
          title="No connected MCP clients"
          description="Clients appear here after you authorize them to connect to Roomote."
        />
      ) : (
        <div className="divide-y">
          {query.data.map((grant) => (
            <div
              key={grant.grantId}
              className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words text-sm font-medium">
                    {grant.clientName}
                  </span>
                  <Badge variant="secondary">
                    {grant.status === 'pending'
                      ? 'Awaiting token exchange'
                      : 'Active'}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Authorized: {timestamp(grant.authorizedAt)} · Expires:{' '}
                  {timestamp(grant.expiresAt)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Last request: {timestamp(grant.lastUsedAt)} · Last token
                  exchange: {timestamp(grant.lastTokenAt)}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  setPending({ grantId: grant.grantId, name: grant.clientName })
                }
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Revoke {pending?.name}?</DialogTitle>
            <DialogDescription>
              This removes access to {userLabel}. Requests already accepted may
              finish. The client must reconnect through browser consent to
              regain access.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!pending) return;
                if (pending.grantId)
                  revoke.mutate({ userId, grantId: pending.grantId });
                else revokeAll.mutate({ userId });
              }}
            >
              {busy ? 'Revoking…' : 'Revoke access'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

export function UserMcpClients() {
  const trpc = useTRPC();
  const users = useQuery(trpc.accessPolicy.get.queryOptions());
  const [selected, setSelected] = useState('');
  if (users.isPending) return <Skeleton className="h-20 w-full" />;
  if (users.isError)
    return <ErrorState title="Could not load users’ MCP clients" />;
  const user =
    users.data.users.find((entry) => entry.id === selected) ??
    users.data.users[0];
  if (!user) return null;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="mcp-client-user" className="text-sm font-medium">
          MCP authorization owner
        </label>
        <Select value={user.id} onValueChange={setSelected}>
          <SelectTrigger id="mcp-client-user" className="w-full sm:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {users.data.users.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name} ({entry.email})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ConnectedMcpClients
        key={user.id}
        userId={user.id}
        userLabel={`${user.name} (${user.email})`}
      />
    </div>
  );
}
