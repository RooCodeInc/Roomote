'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isLocalPreviewDomain } from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import type { PreviewSettingsSnapshot } from '@/trpc/commands/preview-settings';

import {
  Alert,
  AlertDescription,
  Button,
  Check,
  CopyIconButton,
  ExternalLink,
  Info,
  Input,
  Skeleton,
  Spinner,
  TriangleAlert,
} from '@/components/system';
import { TaskStatusIndicator } from '@/components/sandbox';

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

/**
 * Admin-only live preview infrastructure setup: runtime status, preview origin
 * configuration, DNS records, and a DNS check. Rendered inside the task page's
 * preview pane when the preview runtime is not ready.
 */
export function PreviewRuntimeSetup() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(trpc.previewSettings.get.queryOptions());
  const [runtimeDraft, setRuntimeDraft] = useState({
    previewProxyBaseUrl: '',
  });
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<'previewProxyBaseUrl', string>>
  >({});
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
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!settingsQuery.data) {
    return (
      <Alert>
        <AlertDescription>
          Live preview settings are unavailable right now.
        </AlertDescription>
      </Alert>
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
      <div className="space-y-2">
        <h2 className="text-base font-semibold">Status</h2>
        <div className="flex items-start gap-3">
          <TaskStatusIndicator
            compact
            phase={isSetupReady ? 'waiting_for_prompt' : 'shutting_down'}
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
            Runtime environment variables are currently overriding the saved
            deployment preview settings.
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
              Set the origin/hostname for previews (include https/s and, if
              needed, port)
              {isLocalSetup && (
                <>
                  <br />
                  Since you&apos;re running in localhost, it&apos;s best not to
                  change this.
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
                      previewProxyBaseUrl: runtimeDraft.previewProxyBaseUrl,
                    })
                  }
                  disabled={
                    previewOriginManagedByEnv ||
                    !isRuntimeDirty ||
                    runtimeMutation.isPending
                  }
                >
                  {runtimeMutation.isPending ? <Spinner /> : <Check />}
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
                Currently defined by PREVIEW_PROXY_BASE_URL, can&apos;t be
                changed here.
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
                    <span className="w-30 font-medium">Base host</span>
                    <span className="w-20 font-mono">CNAME</span>
                    <span className="grow font-mono">
                      {previewSetupHost ?? 'preview.example.com'}
                    </span>
                    <CopyIconButton
                      content={previewSetupHost ?? 'preview.example.com'}
                      tooltip="Copy base host"
                      aria-label="Copy base host"
                      className="h-7 w-7 shrink-0"
                      iconClassName="size-3.5"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-30 font-medium">Wildcard host</span>
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
                    Make sure your SSL certificate covers both the base host and
                    the wildcard host
                  </li>
                  <li>
                    If you need to point to IP addresses, use A/AAAA records
                    instead of CNAME
                  </li>
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2 text-sm">
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
  );
}
