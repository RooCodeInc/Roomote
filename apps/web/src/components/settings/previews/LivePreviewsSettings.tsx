'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isLocalPreviewDomain, type NamedPort } from '@roomote/types';

import { SETTINGS_PATHS } from '@/lib/settings';
import { useTRPC } from '@/trpc/client';
import type {
  PreviewSettingsEnvironmentSummary,
  PreviewSettingsSnapshot,
} from '@/trpc/commands/preview-settings';

import {
  Alert,
  AlertDescription,
  ArrowRight,
  Button,
  Check,
  CopyIconButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ExternalLink,
  Info,
  Input,
  RefreshCw,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Settings,
  Settings2,
  Spinner,
  Switch,
  TriangleAlert,
  VectorSquare,
} from '@/components/system';
import { TaskStatusIndicator } from '@/components/sandbox';
import { Section } from '@/components/settings';
import { PortListEditor } from '@/components/settings/environments/PortListEditor';
import { serializePorts } from '@/components/settings/environments/VisualEnvironmentEditor.model';

const DEFAULT_PREVIEW_PORT: NamedPort = {
  name: 'WEB',
  port: 3000,
  initial_path: '/',
  primary: true,
};

function getPreviewSetupHost(
  runtime: PreviewSettingsSnapshot['effectiveConfig'],
) {
  return (
    runtime.roomotePreviewDomain ??
    runtime.previewProxyHostname ??
    runtime.primaryPreviewDomain
  );
}

function getPreviewExampleDisplay(
  runtime: PreviewSettingsSnapshot['effectiveConfig'],
) {
  if (!runtime.exampleHostname) {
    return 'Unavailable';
  }

  if (!isLocalPreviewDomain(runtime.primaryPreviewDomain)) {
    return runtime.exampleHostname;
  }

  if (!runtime.previewProxyBaseUrl) {
    return runtime.exampleHostname;
  }

  try {
    const baseUrl = new URL(runtime.previewProxyBaseUrl);
    baseUrl.hostname = runtime.exampleHostname;
    return baseUrl.toString().replace(/\/$/, '');
  } catch {
    return runtime.exampleHostname;
  }
}

function getPreviewServingPort(
  runtime: PreviewSettingsSnapshot['effectiveConfig'],
) {
  if (!runtime.previewProxyBaseUrl) {
    return null;
  }

  try {
    const baseUrl = new URL(runtime.previewProxyBaseUrl);

    if (baseUrl.port) {
      return baseUrl.port;
    }

    if (baseUrl.protocol === 'https:') {
      return '443';
    }

    if (baseUrl.protocol === 'http:') {
      return '80';
    }

    return null;
  } catch {
    return null;
  }
}

function getPreviewAccessDescription(params: {
  runtime: PreviewSettingsSnapshot['effectiveConfig'];
  isPrimary: boolean;
}) {
  const previewPort = getPreviewServingPort(params.runtime);
  const portText = previewPort ? ` on port ${previewPort}` : '';

  if (params.isPrimary) {
    return `Available at the default preview URL${portText}.`;
  }

  return `Available at its own preview URL${portText}.`;
}

function setPrimaryPort(
  ports: NamedPort[] | undefined,
  primaryPortIndex: number | null,
) {
  if (!ports) {
    return ports;
  }

  return ports.map((port, index) => {
    if (primaryPortIndex === index) {
      return { ...port, primary: true };
    }

    if (!port.primary) {
      return port;
    }

    const { primary: _primary, ...rest } = port;
    return rest;
  });
}

function EnvironmentPreviewCard({
  environment,
  runtime,
  isSaving,
  onSave,
}: {
  environment: PreviewSettingsEnvironmentSummary;
  runtime: PreviewSettingsSnapshot['effectiveConfig'];
  isSaving: boolean;
  onSave: (input: {
    environmentId: string;
    previewsEnabled: boolean;
    ports: NamedPort[] | undefined;
  }) => void;
}) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [draftPorts, setDraftPorts] = useState<NamedPort[] | undefined>(
    environment.config.ports,
  );

  useEffect(() => {
    setDraftPorts(environment.config.ports);
  }, [environment.config.ports]);

  useEffect(() => {
    if (!draftPorts || draftPorts.length !== 1 || draftPorts[0]?.primary) {
      return;
    }

    setDraftPorts(setPrimaryPort(draftPorts, 0));
  }, [draftPorts]);

  const previewsEnabled = environment.config.previews_enabled !== false;
  const selectedPrimaryPortIndex = draftPorts?.findIndex(
    (port) => port.primary,
  );

  const isDialogDirty = useMemo(
    () =>
      serializePorts(draftPorts) !== serializePorts(environment.config.ports),
    [draftPorts, environment.config.ports],
  );
  const hasEmptyServiceNames = useMemo(
    () => Boolean(draftPorts?.some((port) => port.name.trim().length === 0)),
    [draftPorts],
  );

  const handleToggle = (checked: boolean) => {
    const nextPorts =
      checked &&
      (!environment.config.ports || environment.config.ports.length === 0)
        ? [DEFAULT_PREVIEW_PORT]
        : environment.config.ports;

    setDraftPorts(nextPorts);
    onSave({
      environmentId: environment.id,
      previewsEnabled: checked,
      ports: nextPorts,
    });
  };

  return (
    <>
      <div
        className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
        data-testid={`preview-environment-${environment.id}`}
      >
        <div className="flex min-w-0 items-start gap-3">
          <Switch
            checked={previewsEnabled}
            onCheckedChange={handleToggle}
            disabled={isSaving}
            aria-label={`Toggle previews for ${environment.name}`}
            className="mt-0.5"
          />
          <div className="min-w-0 space-y-1">
            <p className="font-semibold leading-5">
              {environment.name}
              {isSaving ? (
                <Spinner className="relative left-2 top-0.5 inline-flex size-3" />
              ) : null}
            </p>

            {!previewsEnabled ? (
              <p className="text-muted-foreground">Previews disabled.</p>
            ) : environment.config.ports &&
              environment.config.ports?.length > 0 ? (
              <>
                <p>Exposes:</p>
                <ul className="list-disc outside pl-4">
                  {environment.config.ports?.map((port, index) => (
                    <li key={`${port.name}-${port.port}-${index}`}>
                      <span className="capitalize">{port.name}</span> (port{' '}
                      <span className="font-mono">{port.port}</span>).{' '}
                      {port.initial_path && port.initial_path !== '/' && (
                        <>
                          Starts on path{' '}
                          <span className="font-mono">{port.initial_path}</span>
                          .{' '}
                        </>
                      )}
                      {getPreviewAccessDescription({
                        runtime,
                        isPrimary: Boolean(port.primary),
                      })}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-muted-foreground">No ports configured yet</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Configure preview settings for ${environment.name}`}
            onClick={() => setIsDialogOpen(true)}
          >
            <Settings />
          </Button>
        </div>
      </div>

      <Dialog
        open={isDialogOpen}
        onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) {
            setDraftPorts(environment.config.ports);
          }
        }}
      >
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>{environment.name} preview settings</DialogTitle>
            <DialogDescription>
              Choose which ports can be opened in live previews.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <PortListEditor ports={draftPorts} onChange={setDraftPorts} />

            {draftPorts && draftPorts.length > 1 ? (
              <div className="flex gap-2 items-center">
                <p className="text-sm font-medium">
                  Primary service (mapped to 80 in the preview URL):
                </p>
                <Select
                  value={
                    selectedPrimaryPortIndex === undefined ||
                    selectedPrimaryPortIndex < 0
                      ? 'none'
                      : String(selectedPrimaryPortIndex)
                  }
                  onValueChange={(value) =>
                    setDraftPorts(
                      setPrimaryPort(
                        draftPorts,
                        value === 'none' ? null : Number(value),
                      ),
                    )
                  }
                >
                  <SelectTrigger className="w-auto">
                    <SelectValue placeholder="Select a primary port" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {draftPorts.map((port, index) => (
                      <SelectItem
                        key={`${port.name}-${port.port}-${index}`}
                        value={String(index)}
                      >
                        {port.name || `Port ${port.port}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDraftPorts(environment.config.ports);
                setIsDialogOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                onSave({
                  environmentId: environment.id,
                  previewsEnabled,
                  ports: draftPorts,
                });
                setIsDialogOpen(false);
              }}
              disabled={!isDialogDirty || hasEmptyServiceNames || isSaving}
            >
              {isSaving ? <Spinner /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function LivePreviewsSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(trpc.previewSettings.get.queryOptions());
  const [runtimeDraft, setRuntimeDraft] = useState({
    previewProxyBaseUrl: '',
  });
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<'previewProxyBaseUrl', string>>
  >({});
  const deploymentMutation = useMutation(
    trpc.previewSettings.setDeploymentEnabled.mutationOptions({
      onSuccess: (result) => {
        queryClient.setQueryData(trpc.previewSettings.get.queryKey(), result);
        toast.success('Live preview deployment setting updated');
      },
      onError: () => {
        toast.error('Failed to update live preview deployment setting');
      },
    }),
  );
  const runtimeMutation = useMutation(
    trpc.previewSettings.updateRuntimeConfig.mutationOptions({
      onSuccess: (result) => {
        if (!result.success) {
          setFieldErrors(result.fieldErrors);
          toast.error('Fix the preview runtime settings and try again');
          return;
        }

        setFieldErrors({});
        queryClient.setQueryData(
          trpc.previewSettings.get.queryKey(),
          result.snapshot,
        );
        toast.success('Live preview runtime settings updated');
      },
      onError: () => {
        toast.error('Failed to update live preview runtime settings');
      },
    }),
  );
  const environmentMutation = useMutation(
    trpc.previewSettings.updateEnvironmentPreview.mutationOptions({
      onSuccess: async (result, variables) => {
        if (!result.success) {
          toast.error(result.error);
          return;
        }

        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.previewSettings.get.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.environments.list.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.environments.byId.queryKey({
              id: variables.environmentId,
            }),
          }),
        ]);
        toast.success('Environment live preview settings updated');
      },
      onError: () => {
        toast.error('Failed to update environment live preview settings');
      },
    }),
  );
  const effectivePreviewOriginValue =
    settingsQuery.data?.effectiveConfig.previewProxyBaseUrl ?? null;

  useEffect(() => {
    if (effectivePreviewOriginValue === null) {
      return;
    }

    setRuntimeDraft({
      previewProxyBaseUrl: effectivePreviewOriginValue,
    });
    setFieldErrors({});
  }, [effectivePreviewOriginValue]);

  if (settingsQuery.isPending) {
    return (
      <div className="space-y-6">
        <Section icon={Settings2} title="Setup">
          <p className="text-sm text-muted-foreground">
            Loading live preview settings...
          </p>
        </Section>
      </div>
    );
  }

  if (!settingsQuery.data) {
    return (
      <Section icon={RefreshCw} title="Setup and DNS">
        <Alert>
          <AlertDescription>
            Live preview settings are unavailable right now.
          </AlertDescription>
        </Alert>
      </Section>
    );
  }

  const settings = settingsQuery.data;
  const effectivePreviewOrigin = settings.effectiveConfig.previewProxyBaseUrl;
  const displayedPreviewOrigin = effectivePreviewOrigin || '';
  const previewOriginManagedByEnv =
    settings.configSource.previewOriginManagedByEnv;
  const runtimeValidation = settings.effectiveConfig.validation;
  const previewSetupHost = getPreviewSetupHost(settings.effectiveConfig);
  const isLocalSetup = isLocalPreviewDomain(previewSetupHost);
  const isSetupReady = runtimeValidation.status === 'pass';
  const setupStatusText = isSetupReady
    ? 'Preview setup is ready'
    : 'Preview setup needs attention';
  const isRuntimeDirty =
    runtimeDraft.previewProxyBaseUrl !== displayedPreviewOrigin;
  const previewExampleDisplay = getPreviewExampleDisplay(
    settings.effectiveConfig,
  );
  const previewExampleHref = settings.effectiveConfig.exampleHostname
    ? previewExampleDisplay.startsWith('http')
      ? previewExampleDisplay
      : `https://${previewExampleDisplay}`
    : null;
  return (
    <div className="space-y-6">
      <Section icon={Settings2} title="Setup">
        <div className="space-y-5 divide-y">
          <div className="flex items-start gap-4 pb-5">
            <Switch
              checked={settings.deployment.previewsEnabled}
              onCheckedChange={(enabled) =>
                deploymentMutation.mutate({ enabled })
              }
              disabled={deploymentMutation.isPending}
              aria-label="Toggle deployment live previews"
              className="mt-1"
            />
            <div>
              <p className="font-semibold">
                Enable live environment previews
                {deploymentMutation.isPending ? (
                  <Spinner className="relative left-2 top-0.5 inline-flex size-3" />
                ) : null}
              </p>
              <p className="text-sm text-muted-foreground">
                Publish browser-accessible preview URLs to access environments
                within task sandboxes.
              </p>
            </div>
          </div>

          {settings.deployment.previewsEnabled && (
            <div>
              <div className="space-y-6">
                <div className="space-y-2">
                  <h2 className="text-base font-semibold">Status</h2>
                  <div className="flex items-start gap-3">
                    <TaskStatusIndicator
                      compact
                      phase={
                        isSetupReady ? 'waiting_for_prompt' : 'shutting_down'
                      }
                      className="mt-1.5 ml-1.25 mr-0.75"
                    />
                    <div>
                      <p className="text-sm font-medium">{setupStatusText}</p>
                      <p className="text-sm text-muted-foreground">
                        {runtimeValidation.summary}
                      </p>
                    </div>
                  </div>
                </div>

                {runtimeValidation.status === 'fail' &&
                runtimeValidation.details.length > 0 ? (
                  <p className="mt-3 flex items-center gap-2 text-sm text-destructive">
                    <TriangleAlert className="size-4 shrink-0" />
                    <span>{runtimeValidation.details.join(' ')}</span>
                  </p>
                ) : null}

                {settings.overrideState.hasOverrides ? (
                  <Alert>
                    <AlertDescription>
                      Runtime environment variables are currently overriding the
                      saved deployment preview settings.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="space-y-4">
                  <h2 className="text-base font-semibold">Configuration</h2>

                  <div className="flex items-start gap-3">
                    <span className="bg-foreground text-card size-6 flex items-center justify-center rounded-full shrink-0">
                      1
                    </span>
                    <div className="space-y-1 w-full max-w-2xl">
                      <label className="text-sm font-medium block">
                        Set the origin/hostname for previews (include https/s
                        and, if needed, port)
                        {isLocalSetup && (
                          <>
                            <br />
                            Since you&apos;re running in localhost, it&apos;s
                            best not to change this.
                          </>
                        )}
                      </label>
                      <div className="flex items-center gap-2 w-full">
                        <Input
                          className="w-full"
                          value={runtimeDraft.previewProxyBaseUrl}
                          readOnly={previewOriginManagedByEnv}
                          disabled={previewOriginManagedByEnv}
                          onChange={(event) => {
                            setRuntimeDraft((current) => ({
                              ...current,
                              previewProxyBaseUrl: event.target.value,
                            }));
                            if (fieldErrors.previewProxyBaseUrl) {
                              setFieldErrors((current) => ({
                                ...current,
                                previewProxyBaseUrl: undefined,
                              }));
                            }
                          }}
                          aria-label="Preview origin"
                          placeholder="eg: https://preview.example.com or http://previews.acme.ai:4000"
                        />

                        {!previewOriginManagedByEnv && (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() =>
                              runtimeMutation.mutate({
                                previewProxyBaseUrl:
                                  runtimeDraft.previewProxyBaseUrl,
                              })
                            }
                            disabled={
                              previewOriginManagedByEnv ||
                              !isRuntimeDirty ||
                              runtimeMutation.isPending
                            }
                          >
                            {runtimeMutation.isPending ? (
                              <Spinner />
                            ) : (
                              <Check />
                            )}
                            Save
                          </Button>
                        )}
                      </div>

                      {fieldErrors.previewProxyBaseUrl ? (
                        <p className="text-sm text-destructive">
                          {fieldErrors.previewProxyBaseUrl}
                        </p>
                      ) : null}

                      {previewOriginManagedByEnv && (
                        <p className="text-sm text-muted-foreground">
                          <Info className="size-4 inline mr-1" />
                          Currently defined by PREVIEW_PROXY_BASE_URL,
                          can&apos;t be changed here.
                        </p>
                      )}
                    </div>
                  </div>

                  {isLocalSetup ? null : (
                    <div className="flex items-start gap-3">
                      <span className="bg-foreground text-card size-6 flex items-center justify-center rounded-full shrink-0">
                        2
                      </span>
                      <div className="space-y-2 w-full">
                        <p className="text-sm font-medium">
                          Create both of the following DNS records
                        </p>

                        <div className="space-y-1 w-full max-w-2xl">
                          <div className="bg-muted p-3">
                            <div className="flex items-center gap-2">
                              <span className="w-30 font-medium">
                                Base host
                              </span>
                              <span className="w-20 font-mono">CNAME</span>
                              <span className="grow font-mono">
                                {previewSetupHost ?? 'preview.example.com'}
                              </span>
                              <CopyIconButton
                                content={
                                  previewSetupHost ?? 'preview.example.com'
                                }
                                tooltip="Copy base host"
                                aria-label="Copy base host"
                                className="h-7 w-7 shrink-0"
                                iconClassName="size-3.5"
                              />
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-30 font-medium">
                                Wildcard host
                              </span>
                              <span className="w-20 font-mono">CNAME</span>
                              <span className="grow font-mono">
                                *.{previewSetupHost ?? 'preview.example.com'}
                              </span>
                              <CopyIconButton
                                content={`*.${previewSetupHost ?? 'preview.example.com'}`}
                                tooltip="Copy wildcard host"
                                aria-label="Copy wildcard host"
                                className="h-7 w-7 shrink-0"
                                iconClassName="size-3.5"
                              />
                            </div>
                          </div>
                          <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
                            <li>
                              Make sure your SSL certificate covers both the
                              base host and the wildcard host
                            </li>
                            <li>
                              If you need to point to IP addresses, use A/AAAA
                              records instead of CNAME
                            </li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-2 text-sm ">
                  <div className="flex items-start gap-3">
                    <span className="bg-foreground text-card size-6 flex items-center justify-center rounded-full shrink-0">
                      {isLocalSetup ? '2' : '3'}
                    </span>
                    <div className="space-y-2 w-full max-w-2xl">
                      <p className="">Check your configuration</p>
                      <div className="text-sm flex gap-3 items-center bg-muted p-3 font-mono">
                        {previewExampleDisplay}
                      </div>

                      <div className="flex items-center gap-2 mt-3">
                        {!isLocalSetup && (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => settingsQuery.refetch()}
                            disabled={settingsQuery.isFetching}
                          >
                            {settingsQuery.isFetching ? <Spinner /> : <Check />}
                            Check DNS
                          </Button>
                        )}

                        {previewExampleHref ? (
                          <Button asChild variant="outline" size="sm">
                            <Link
                              href={previewExampleHref}
                              target="_blank"
                              className="inline-flex items-center gap-2"
                            >
                              Try opening it
                              <ExternalLink />
                            </Link>
                          </Button>
                        ) : (
                          <Button variant="outline" size="sm" disabled>
                            Try opening it
                            <ExternalLink />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </Section>

      {settings.deployment.previewsEnabled && (
        <Section icon={VectorSquare} title="Environment Preview Settings">
          <div className="space-y-2 divide-y divide-background">
            {settings.environments.length === 0 ? (
              <p>
                You haven&apos;t created any environments yet.{' '}
                <Link
                  href={SETTINGS_PATHS.newEnvironment}
                  className="inline-flex items-center gap-1 text-primary underline hover:no-underline"
                >
                  Create your first
                  <ArrowRight className="size-3" />
                </Link>
                .
              </p>
            ) : (
              settings.environments.map((environment) => (
                <EnvironmentPreviewCard
                  key={environment.id}
                  environment={environment}
                  runtime={settings.effectiveConfig}
                  isSaving={
                    environmentMutation.isPending &&
                    environmentMutation.variables?.environmentId ===
                      environment.id
                  }
                  onSave={(input) => environmentMutation.mutate(input)}
                />
              ))
            )}
          </div>
        </Section>
      )}
    </div>
  );
}
