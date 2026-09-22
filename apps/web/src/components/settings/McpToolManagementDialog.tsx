'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  Alert,
  AlertDescription,
  BasicTooltip,
  Button,
  Check,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  ToggleLeft,
  ToggleRight,
} from '@/components/system';
import {
  useMcpConnectionTools,
  useSetDisabledMcpTools,
} from '@/hooks/mcp-connections';
import { useIntegrationToolApprovalsExperiment } from '@/hooks/useIntegrationToolApprovalsExperiment';

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
  const approvalsExperiment = useIntegrationToolApprovalsExperiment();
  const setDisabledTools = useSetDisabledMcpTools();
  const [disabledToolNames, setDisabledToolNames] = useState<string[]>([]);
  const lastSyncedToolStateKey = useRef<string | null>(null);

  const initialDisabledToolNames = useMemo(
    () =>
      (toolsQuery.data?.tools ?? [])
        .filter((tool) => !tool.enabled)
        .map((tool) => tool.name)
        .sort((left, right) => left.localeCompare(right)),
    [toolsQuery.data?.tools],
  );
  const initialDisabledToolNamesKey = useMemo(
    () => initialDisabledToolNames.join('\n'),
    [initialDisabledToolNames],
  );

  useEffect(() => {
    if (!open) {
      lastSyncedToolStateKey.current = null;
      return;
    }
    if (!mcpId || toolsQuery.status !== 'success') return;

    const nextToolStateKey = `${mcpId}\n${initialDisabledToolNamesKey}`;
    if (lastSyncedToolStateKey.current === nextToolStateKey) return;

    lastSyncedToolStateKey.current = nextToolStateKey;
    setDisabledToolNames(initialDisabledToolNames);
  }, [
    initialDisabledToolNames,
    initialDisabledToolNamesKey,
    mcpId,
    open,
    toolsQuery.status,
  ]);

  const normalizedDisabledToolNames = useMemo(
    () =>
      [...disabledToolNames].sort((left, right) => left.localeCompare(right)),
    [disabledToolNames],
  );
  const isDirty =
    initialDisabledToolNames.join('\n') !==
    normalizedDisabledToolNames.join('\n');
  const loadedTools = toolsQuery.data?.tools ?? [];
  const hasLoadedTools =
    !toolsQuery.isPending &&
    !toolsQuery.isError &&
    toolsQuery.data != null &&
    loadedTools.length > 0;
  const legacyAvailability =
    !approvalsExperiment.isLoading &&
    !approvalsExperiment.enabled &&
    isAdmin !== false;
  const showBulkToolActions = loadedTools.length > 3;
  const hasEnabledTools = loadedTools.some(
    (tool) => !normalizedDisabledToolNames.includes(tool.name),
  );

  const handleToggle = (toolName: string, enabled: boolean) => {
    setDisabledToolNames((current) => {
      const next = new Set(current);
      if (enabled) next.delete(toolName);
      else next.add(toolName);
      return Array.from(next);
    });
  };

  const handleEnableAllTools = () => {
    const availableToolNames = new Set(loadedTools.map((tool) => tool.name));
    setDisabledToolNames((current) =>
      current.filter((toolName) => !availableToolNames.has(toolName)),
    );
  };

  const handleDisableAllTools = () => {
    setDisabledToolNames((current) =>
      Array.from(
        new Set([...current, ...loadedTools.map((tool) => tool.name)]),
      ),
    );
  };

  const handleSave = () => {
    if (!mcpId) return;
    setDisabledTools.mutate(
      { mcpId, disabledTools: normalizedDisabledToolNames },
      {
        onSuccess: () => {
          toast.success('Tool availability updated.');
          onOpenChange(false);
        },
        onError: (error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : 'Failed to update tool availability.',
          );
        },
      },
    );
  };

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
          {toolsQuery.isPending ? (
            <div className="flex min-h-32 items-center justify-center">
              <Spinner />
            </div>
          ) : null}

          {!toolsQuery.isPending && toolsQuery.isError ? (
            <Alert variant="light" className="bg-card dark:bg-foreground/10">
              <AlertDescription className="block">
                <McpToolLoadErrorMessage
                  integrationName={integrationName}
                  message={
                    toolsQuery.error instanceof Error
                      ? toolsQuery.error.message
                      : 'Failed to load tools for this integration.'
                  }
                />
              </AlertDescription>
            </Alert>
          ) : null}

          {!toolsQuery.isPending &&
          !toolsQuery.isError &&
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
                isToolEnabled={(toolName) =>
                  !normalizedDisabledToolNames.includes(toolName)
                }
                onToggleTool={handleToggle}
                toggleDisabled={setDisabledTools.isPending}
              />
            </div>
          ) : null}
        </div>

        {legacyAvailability && hasLoadedTools ? (
          <DialogFooter className="md:justify-between">
            {showBulkToolActions ? (
              <div className="flex items-center justify-start gap-4">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-0!"
                  disabled={
                    setDisabledTools.isPending ||
                    loadedTools.every((tool) =>
                      normalizedDisabledToolNames.includes(tool.name),
                    )
                  }
                  onClick={handleDisableAllTools}
                >
                  <ToggleLeft />
                  Disable all
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-0!"
                  disabled={
                    setDisabledTools.isPending ||
                    loadedTools.every(
                      (tool) =>
                        !normalizedDisabledToolNames.includes(tool.name),
                    )
                  }
                  onClick={handleEnableAllTools}
                >
                  <ToggleRight />
                  Enable all
                </Button>
              </div>
            ) : (
              <div />
            )}
            <div className="flex flex-col-reverse gap-2 md:flex-row">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <BasicTooltip
                content={
                  !hasEnabledTools &&
                  'Enable at least one tool to save. To remove the integration, click on the × in the list.'
                }
              >
                <Button
                  type="button"
                  disabled={
                    !mcpId ||
                    setDisabledTools.isPending ||
                    !isDirty ||
                    !hasEnabledTools
                  }
                  onClick={handleSave}
                >
                  {setDisabledTools.isPending ? <Spinner /> : <Check />}
                  Save changes
                </Button>
              </BasicTooltip>
            </div>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
