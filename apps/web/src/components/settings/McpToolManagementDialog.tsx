'use client';

import Link from 'next/link';
import { useState } from 'react';

import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Spinner,
} from '@/components/system';
import { useMcpConnectionTools } from '@/hooks/mcp-connections';

import { IntegrationToolApprovalList } from './IntegrationToolApprovalControls';
import { MCP_TOOL_CATALOG_REQUIRES_PERSONAL_CONNECTION } from '@/lib/mcp-tool-errors';
import { SETTINGS_PATHS } from '@/lib/settings';

type McpToolManagementDialogProps = {
  mcpId: string | null;
  integrationName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Admin-only approval policy state is never loaded for non-admin viewers. */
  isAdmin?: boolean;
};

function McpToolLoadErrorMessage({
  integrationName,
  message,
}: {
  integrationName: string | null;
  message: string;
}) {
  if (message !== MCP_TOOL_CATALOG_REQUIRES_PERSONAL_CONNECTION) {
    return message;
  }

  return (
    <>
      MCP servers only list their tools after fully authenticating, by design.
      <br />
      Please first{' '}
      <strong>
        link your {integrationName ?? 'integration'} account in{' '}
        <Link
          href={SETTINGS_PATHS.personal}
          target="_blank"
          rel="noopener noreferrer"
          className="inline text-primary underline hover:no-underline"
        >
          personal settings
        </Link>
      </strong>{' '}
      (or someone else&apos;s) and try again here.
    </>
  );
}

export function McpToolManagementDialog({
  mcpId,
  integrationName,
  open,
  onOpenChange,
  isAdmin,
}: McpToolManagementDialogProps) {
  const toolsQuery = useMcpConnectionTools(open ? mcpId : null);
  const [retryError, setRetryError] = useState<{
    mcpId: string;
    message: string;
  } | null>(null);
  const activeRetryError = retryError?.mcpId === mcpId ? retryError : null;
  const hasLoadError = toolsQuery.isError || activeRetryError !== null;
  const errorMessage =
    toolsQuery.error instanceof Error
      ? toolsQuery.error.message
      : 'Failed to load tools for this integration.';
  const retryTools = async () => {
    if (!open || !mcpId || toolsQuery.isFetching) return;
    const error = { mcpId, message: errorMessage };
    setRetryError(error);
    try {
      await toolsQuery.refetch();
    } finally {
      setRetryError((current) => (current === error ? null : current));
    }
  };
  const loadedTools = toolsQuery.data?.tools ?? [];
  const hasLoadedTools =
    !toolsQuery.isPending &&
    !hasLoadError &&
    toolsQuery.data != null &&
    loadedTools.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>
            Manage tools for {integrationName ?? 'integration'}
          </DialogTitle>
          <DialogDescription>
            Choose how the model can use tools from this integration.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          {toolsQuery.isPending && !activeRetryError ? (
            <div className="flex min-h-32 items-center justify-center">
              <Spinner />
            </div>
          ) : null}

          {hasLoadError ? (
            <Alert variant="light" className="bg-card dark:bg-foreground/10">
              <AlertDescription className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1 wrap-anywhere">
                  <McpToolLoadErrorMessage
                    integrationName={integrationName}
                    message={activeRetryError?.message ?? errorMessage}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Retry loading integration tools"
                  aria-busy={toolsQuery.isFetching}
                  disabled={toolsQuery.isFetching}
                  onClick={() => void retryTools()}
                >
                  {toolsQuery.isFetching ? 'Retrying…' : 'Retry'}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {!toolsQuery.isPending &&
          !hasLoadError &&
          toolsQuery.data?.tools.length === 0 ? (
            <Alert variant="light">
              <AlertDescription>
                No tools are available for this integration.
              </AlertDescription>
            </Alert>
          ) : null}

          {hasLoadedTools ? (
            <div className="space-y-3 py-3">
              <IntegrationToolApprovalList
                integrationId={mcpId}
                integrationName={integrationName}
                scope="deployment"
                canManage={isAdmin !== false}
                open={open}
                tools={loadedTools}
              />
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
