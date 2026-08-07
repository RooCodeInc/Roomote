'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';

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
  Lock,
  Pencil,
  Plus,
  RadioGroup,
  RadioGroupItem,
  ServerCog,
  Skeleton,
  Switch,
  Trash2,
  Wrench,
  X,
} from '@/components/system';
import { Loading } from '@/components/layout';
import { Section } from '@/components/settings';
import type { CustomMcpServerListEntry } from '@/trpc/commands/custom-mcp-servers';
import { useTRPC } from '@/trpc/client';

type Transport = 'remote' | 'stdio';
type AuthType = 'none' | 'static_headers' | 'oauth';

interface ServerFormValues {
  name: string;
  transport: Transport;
  url: string;
  authType: AuthType;
  headers: { name: string; value: string }[];
  manualClientId: string;
  manualClientSecret: string;
  oauthResourceIndicatorDisabled: boolean;
  stdioCommand: string;
  stdioArgs: string;
  stdioEnv: { name: string; value: string }[];
}

type ListedServer = Omit<CustomMcpServerListEntry, 'createdAt' | 'updatedAt'>;

const EMPTY_FORM: ServerFormValues = {
  name: '',
  transport: 'remote',
  url: '',
  authType: 'none',
  headers: [],
  manualClientId: '',
  manualClientSecret: '',
  oauthResourceIndicatorDisabled: false,
  stdioCommand: '',
  stdioArgs: '',
  stdioEnv: [],
};

function serverToFormValues(server: ListedServer): ServerFormValues {
  return {
    name: server.name,
    transport: server.transport,
    url: server.url ?? '',
    authType: server.authType,
    headers: server.headerNames.map((name) => ({ name, value: '' })),
    manualClientId: '',
    manualClientSecret: '',
    oauthResourceIndicatorDisabled: server.oauthResourceIndicatorDisabled,
    stdioCommand: server.stdioCommand ?? '',
    stdioArgs: server.stdioArgs.join('\n'),
    stdioEnv: server.stdioEnvNames.map((name) => ({ name, value: '' })),
  };
}

function formValuesToInput(values: ServerFormValues) {
  if (values.transport === 'stdio') {
    const args = values.stdioArgs
      .split('\n')
      .map((argument) => argument.trim())
      .filter(Boolean);
    const env = Object.fromEntries(
      values.stdioEnv
        .filter((entry) => entry.name.trim())
        .map((entry) => [entry.name.trim(), entry.value]),
    );

    return {
      transport: 'stdio' as const,
      name: values.name,
      stdio: {
        command: values.stdioCommand,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    };
  }

  const headers = Object.fromEntries(
    values.headers
      .filter((entry) => entry.name.trim())
      .map((entry) => [entry.name.trim(), entry.value]),
  );

  return {
    transport: 'remote' as const,
    name: values.name,
    url: values.url,
    authType: values.authType,
    ...(values.authType === 'static_headers' && Object.keys(headers).length > 0
      ? { headers }
      : {}),
    ...(values.authType === 'oauth'
      ? {
          manualClientId: values.manualClientId || undefined,
          manualClientSecret: values.manualClientSecret || undefined,
          oauthResourceIndicatorDisabled: values.oauthResourceIndicatorDisabled,
        }
      : {}),
  };
}

function KeyValueRows({
  entries,
  onChange,
  namePlaceholder,
  isEdit,
}: {
  entries: { name: string; value: string }[];
  onChange: (entries: { name: string; value: string }[]) => void;
  namePlaceholder: string;
  isEdit: boolean;
}) {
  return (
    <div className="space-y-2">
      {entries.map((entry, index) => (
        <div key={index} className="flex gap-2">
          <div className="flex-1">
            <Input
              className="font-mono"
              placeholder={namePlaceholder}
              value={entry.name}
              onChange={(event) =>
                onChange(
                  entries.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, name: event.target.value }
                      : candidate,
                  ),
                )
              }
              data-1p-ignore
            />
          </div>
          <div className="flex-1">
            <Input
              secret
              className="font-mono"
              placeholder={
                isEdit ? 'Leave blank to keep the existing value' : 'Value'
              }
              value={entry.value}
              onChange={(event) =>
                onChange(
                  entries.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, value: event.target.value }
                      : candidate,
                  ),
                )
              }
              data-1p-ignore
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onChange(
                entries.filter((_, candidateIndex) => candidateIndex !== index),
              )
            }
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => onChange([...entries, { name: '', value: '' }])}
      >
        <Plus />
        Add
      </Button>
    </div>
  );
}

function ServerFormDialog({
  open,
  onOpenChange,
  editingServer,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingServer: ListedServer | null;
  onSaved: () => void;
}) {
  const trpc = useTRPC();
  const isEdit = Boolean(editingServer);

  const form = useForm<ServerFormValues>({ defaultValues: EMPTY_FORM });
  const { watch, setValue, register, reset } = form;

  useEffect(() => {
    if (open) {
      reset(editingServer ? serverToFormValues(editingServer) : EMPTY_FORM);
      setError(null);
    }
  }, [open, editingServer, reset]);

  const [error, setError] = useState<string | null>(null);
  const transport = watch('transport');
  const authType = watch('authType');
  const headers = watch('headers');
  const stdioEnv = watch('stdioEnv');

  const createServer = useMutation(
    trpc.customMcpServers.create.mutationOptions(),
  );
  const updateServer = useMutation(
    trpc.customMcpServers.update.mutationOptions(),
  );

  const isSaving = createServer.isPending || updateServer.isPending;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);

    try {
      const server = formValuesToInput(values);

      if (editingServer) {
        await updateServer.mutateAsync({ id: editingServer.id, server });
      } else {
        await createServer.mutateAsync(server);
      }

      onSaved();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? 'Edit custom MCP server' : 'Add custom MCP server'}
          </DialogTitle>
          <DialogDescription>
            Custom servers are available to agents in every task. Remote servers
            are reached through an authenticated Roomote proxy, so credentials
            stay server-side. Local servers run inside the task sandbox with the
            same privileges as the agent.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              className="font-mono"
              placeholder="e.g. internal-tools"
              disabled={isEdit}
              {...register('name')}
              data-1p-ignore
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, digits, dashes, and underscores. Shown to
              agents as the MCP server name.
            </p>
          </div>

          {!isEdit && (
            <div className="space-y-2">
              <Label>Type</Label>
              <RadioGroup
                value={transport}
                onValueChange={(value) =>
                  setValue('transport', value as Transport)
                }
                className="flex gap-6"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="remote" id="transport-remote" />
                  <Label htmlFor="transport-remote">Remote (HTTP)</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="stdio" id="transport-stdio" />
                  <Label htmlFor="transport-stdio">Local (stdio)</Label>
                </div>
              </RadioGroup>
            </div>
          )}

          {transport === 'remote' ? (
            <>
              <div className="space-y-2">
                <Label>Server URL</Label>
                <Input
                  className="font-mono"
                  placeholder="https://mcp.example.com/mcp"
                  {...register('url')}
                />
              </div>

              <div className="space-y-2">
                <Label>Authentication</Label>
                <RadioGroup
                  value={authType}
                  onValueChange={(value) =>
                    setValue('authType', value as AuthType)
                  }
                  className="flex gap-6"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="none" id="auth-none" />
                    <Label htmlFor="auth-none">None</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="static_headers" id="auth-headers" />
                    <Label htmlFor="auth-headers">Headers</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="oauth" id="auth-oauth" />
                    <Label htmlFor="auth-oauth">OAuth</Label>
                  </div>
                </RadioGroup>
              </div>

              {authType === 'static_headers' && (
                <div className="space-y-2">
                  <Label>Headers</Label>
                  <KeyValueRows
                    entries={headers}
                    onChange={(entries) => setValue('headers', entries)}
                    namePlaceholder="e.g. x-api-key"
                    isEdit={isEdit}
                  />
                  <p className="text-xs text-muted-foreground">
                    Values are encrypted at rest and injected by the proxy; they
                    are never sent to the browser or the task sandbox.
                  </p>
                </div>
              )}

              {authType === 'oauth' && (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    After saving, use Connect to authorize. Servers that support
                    Dynamic Client Registration need no client credentials;
                    otherwise register a client for the callback URL{' '}
                    <code className="font-mono">
                      {typeof window !== 'undefined'
                        ? `${window.location.origin}/api/mcp-oauth/callback`
                        : '/api/mcp-oauth/callback'}
                    </code>{' '}
                    and enter it below.
                  </p>
                  <div className="space-y-2">
                    <Label>Client ID (optional)</Label>
                    <Input
                      className="font-mono"
                      {...register('manualClientId')}
                      data-1p-ignore
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Client secret (optional)</Label>
                    <Input
                      secret
                      className="font-mono"
                      placeholder={
                        isEdit ? 'Leave blank to keep the existing value' : ''
                      }
                      {...register('manualClientSecret')}
                      data-1p-ignore
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={watch('oauthResourceIndicatorDisabled')}
                      onCheckedChange={(checked) =>
                        setValue('oauthResourceIndicatorDisabled', checked)
                      }
                      id="resource-indicator-disabled"
                    />
                    <Label htmlFor="resource-indicator-disabled">
                      Skip RFC 8707 resource indicator (for servers that reject
                      it)
                    </Label>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Command</Label>
                <Input
                  className="font-mono"
                  placeholder="e.g. npx"
                  {...register('stdioCommand')}
                />
              </div>
              <div className="space-y-2">
                <Label>Arguments (one per line)</Label>
                <textarea
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono min-h-20"
                  placeholder={'-y\n@example/mcp-server'}
                  {...register('stdioArgs')}
                />
              </div>
              <div className="space-y-2">
                <Label>Environment variables</Label>
                <KeyValueRows
                  entries={stdioEnv}
                  onChange={(entries) => setValue('stdioEnv', entries)}
                  namePlaceholder="e.g. EXAMPLE_TOKEN"
                  isEdit={isEdit}
                />
                <p className="text-xs text-muted-foreground">
                  Values are encrypted at rest but are visible inside the task
                  sandbox at runtime, like environment-scoped stdio servers. You
                  can reference deployment environment variables with{' '}
                  <code className="font-mono">{'${VAR}'}</code>.
                </p>
              </div>
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? <Loading /> : isEdit ? 'Save' : 'Add server'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CustomToolManagementDialog({
  server,
  open,
  onOpenChange,
  onSaved,
}: {
  server: ListedServer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const trpc = useTRPC();

  const toolsQuery = useQuery(
    trpc.customMcpServers.listTools.queryOptions(
      { id: server?.id ?? '' },
      { enabled: open && Boolean(server), retry: false },
    ),
  );

  const setDisabledTools = useMutation(
    trpc.customMcpServers.setDisabledTools.mutationOptions(),
  );

  const [disabledNames, setDisabledNames] = useState<Set<string>>(new Set());

  const loadedKey = useMemo(
    () =>
      toolsQuery.data
        ? `${server?.id}:${toolsQuery.data.tools.map((tool) => tool.name).join(',')}`
        : null,
    [toolsQuery.data, server?.id],
  );

  useEffect(() => {
    if (loadedKey && toolsQuery.data) {
      setDisabledNames(
        new Set(
          toolsQuery.data.tools
            .filter((tool) => !tool.enabled)
            .map((tool) => tool.name),
        ),
      );
    }
  }, [loadedKey, toolsQuery.data]);

  const save = async () => {
    if (!server) {
      return;
    }

    await setDisabledTools.mutateAsync({
      id: server.id,
      disabledTools: [...disabledNames],
    });
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            Manage tools{server ? ` — ${server.name}` : ''}
          </DialogTitle>
          <DialogDescription>
            Disabled tools are blocked at the Roomote proxy and hidden from
            agents.
          </DialogDescription>
        </DialogHeader>

        {toolsQuery.isPending ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-6 w-full" />
            ))}
          </div>
        ) : toolsQuery.isError ? (
          <p className="text-sm text-destructive">
            {toolsQuery.error instanceof Error
              ? toolsQuery.error.message
              : 'Failed to load tools.'}
          </p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {toolsQuery.data?.tools.map((tool) => (
              <label
                key={tool.name}
                className="flex items-start gap-3 text-sm cursor-pointer"
              >
                <Checkbox
                  checked={!disabledNames.has(tool.name)}
                  onCheckedChange={(checked) => {
                    setDisabledNames((current) => {
                      const next = new Set(current);

                      if (checked === true) {
                        next.delete(tool.name);
                      } else {
                        next.add(tool.name);
                      }

                      return next;
                    });
                  }}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-mono">{tool.name}</span>
                  {tool.description && (
                    <span className="block text-xs text-muted-foreground">
                      {tool.description}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={save}
            disabled={setDisabledTools.isPending || toolsQuery.isPending}
          >
            {setDisabledTools.isPending ? <Loading /> : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CustomMcpServers() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const availability = useQuery(
    trpc.customMcpServers.availability.queryOptions(),
  );
  const serversQuery = useQuery(trpc.customMcpServers.list.queryOptions());

  const deleteServer = useMutation(
    trpc.customMcpServers.delete.mutationOptions(),
  );
  const setEnabled = useMutation(
    trpc.customMcpServers.setEnabled.mutationOptions(),
  );
  const connect = useMutation(trpc.customMcpServers.connect.mutationOptions());

  const [formOpen, setFormOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ListedServer | null>(null);
  const [toolsServer, setToolsServer] = useState<ListedServer | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.customMcpServers.list.queryKey(),
    });

  if (availability.data?.enabled === false) {
    return null;
  }

  const servers = (serversQuery.data ?? []) as ListedServer[];

  const authSummary = (server: ListedServer) => {
    if (server.transport === 'stdio') {
      return <Badge variant="outline">stdio</Badge>;
    }

    if (server.authType === 'static_headers') {
      return (
        <Badge variant="outline">
          <Lock className="size-2 text-muted-foreground" />
          {server.headerNames.length} header
          {server.headerNames.length === 1 ? '' : 's'}
        </Badge>
      );
    }

    if (server.authType === 'oauth') {
      if (server.authStatus === 'authenticated') {
        return <Badge variant="outline">OAuth · connected</Badge>;
      }

      return (
        <Badge variant="destructive">
          OAuth ·{' '}
          {server.authStatus === 'error' ? 'reconnect needed' : 'not connected'}
        </Badge>
      );
    }

    return <Badge variant="outline">no auth</Badge>;
  };

  return (
    <>
      <Section
        icon={ServerCog}
        title="Custom MCP Servers"
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditingServer(null);
              setFormOpen(true);
            }}
          >
            <Plus />
            Add
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">
          Connect MCP servers that are not in the catalog. Available to agents
          in every task; an environment&apos;s own <code>mcpServers</code> entry
          with the same name takes precedence in that environment.
        </p>

        {serversQuery.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No custom MCP servers configured yet.
          </p>
        ) : (
          <table className="w-full">
            <tbody>
              {servers.map((server) => (
                <tr
                  key={server.id}
                  className="text-sm text-left border-b border-border last:border-none"
                >
                  <th className="font-mono py-2">{server.name}</th>
                  <td className="text-muted-foreground font-mono text-xs max-w-64 truncate">
                    {server.transport === 'remote'
                      ? server.url
                      : [server.stdioCommand, ...server.stdioArgs].join(' ')}
                  </td>
                  <td>{authSummary(server)}</td>
                  <td className="text-right py-1">
                    {server.transport === 'remote' &&
                      server.authType === 'oauth' &&
                      server.authStatus !== 'authenticated' && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={connect.isPending}
                          onClick={async () => {
                            const initiateUrl = await connect.mutateAsync({
                              id: server.id,
                              redirectTo: '/settings/integrations',
                            });
                            window.location.href = initiateUrl;
                          }}
                        >
                          Connect
                        </Button>
                      )}
                    {server.transport === 'remote' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        title="Manage tools"
                        onClick={() => setToolsServer(server)}
                      >
                        <Wrench className="size-4" />
                      </Button>
                    )}
                    <Switch
                      checked={server.enabled}
                      onCheckedChange={async (checked) => {
                        await setEnabled.mutateAsync({
                          id: server.id,
                          enabled: checked,
                        });
                        refresh();
                      }}
                      className="mx-2 align-middle"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingServer(server);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={deleteServer.isPending}
                      onClick={async () => {
                        if (
                          confirm(
                            `Delete custom MCP server '${server.name}'? Stored credentials are removed as well.`,
                          )
                        ) {
                          await deleteServer.mutateAsync({ id: server.id });
                          refresh();
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <ServerFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editingServer={editingServer}
        onSaved={() => {
          setFormOpen(false);
          refresh();
        }}
      />

      <CustomToolManagementDialog
        server={toolsServer}
        open={Boolean(toolsServer)}
        onOpenChange={(open) => {
          if (!open) {
            setToolsServer(null);
          }
        }}
        onSaved={refresh}
      />
    </>
  );
}
