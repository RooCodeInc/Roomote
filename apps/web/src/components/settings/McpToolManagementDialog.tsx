'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { McpToolAccessMode } from '@roomote/types';

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
  Label,
  RadioGroup,
  RadioGroupItem,
  Spinner,
  Switch,
  ToggleLeft,
  ToggleRight,
  TriangleAlert,
} from '@/components/system';
import {
  useMcpConnectionTools,
  useSetDisabledMcpTools,
} from '@/hooks/mcp-connections';
import { MCP_TOOL_CATALOG_REQUIRES_PERSONAL_CONNECTION } from '@/lib/mcp-tool-errors';
import { SETTINGS_PATHS } from '@/lib/settings';

type McpToolManagementDialogProps = {
  mcpId: string | null;
  integrationName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function splitToolNameParts(name: string): string[] {
  return name.split(/[-_\s]+/).filter((part) => part.length > 0);
}

function titleCaseToolNamePart(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

function prettifyToolName(
  name: string,
  integrationName: string | null,
): string {
  const nameParts = splitToolNameParts(name);
  const integrationParts = integrationName
    ? splitToolNameParts(integrationName)
    : [];
  const hasIntegrationPrefix =
    integrationParts.length > 0 &&
    integrationParts.every(
      (part, index) => nameParts[index]?.toLowerCase() === part.toLowerCase(),
    );
  const displayParts = hasIntegrationPrefix
    ? nameParts.slice(integrationParts.length)
    : nameParts;

  return (displayParts.length > 0 ? displayParts : nameParts)
    .map(titleCaseToolNamePart)
    .join(' ');
}

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
}: McpToolManagementDialogProps) {
  const toolsQuery = useMcpConnectionTools(open ? mcpId : null);
  const setDisabledTools = useSetDisabledMcpTools();
  const [disabledToolNames, setDisabledToolNames] = useState<string[]>([]);
  const [toolAccessMode, setToolAccessMode] =
    useState<McpToolAccessMode | null>(null);
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
  const initialToolAccessMode = toolsQuery.data?.toolAccessMode ?? null;

  useEffect(() => {
    if (!open) {
      lastSyncedToolStateKey.current = null;
      return;
    }

    if (!open || !mcpId || toolsQuery.status !== 'success') {
      return;
    }

    const nextToolStateKey = `${mcpId}\n${initialToolAccessMode ?? ''}\n${initialDisabledToolNamesKey}`;

    if (lastSyncedToolStateKey.current === nextToolStateKey) {
      return;
    }

    lastSyncedToolStateKey.current = nextToolStateKey;
    setDisabledToolNames(initialDisabledToolNames);
    setToolAccessMode(initialToolAccessMode);
  }, [
    initialDisabledToolNames,
    initialDisabledToolNamesKey,
    initialToolAccessMode,
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
      normalizedDisabledToolNames.join('\n') ||
    initialToolAccessMode !== toolAccessMode;
  const loadedTools = toolsQuery.data?.tools ?? [];
  const hasLoadedTools =
    !toolsQuery.isPending &&
    !toolsQuery.isError &&
    toolsQuery.data != null &&
    loadedTools.length > 0;
  const showBulkToolActions = loadedTools.length > 3;
  const isToolAvailableInSelectedMode = (tool: (typeof loadedTools)[number]) =>
    toolAccessMode !== 'read_only' || tool.availableInReadOnly !== false;
  const availableTools = loadedTools.filter(isToolAvailableInSelectedMode);
  const hasEnabledTools = availableTools.some(
    (tool) => !normalizedDisabledToolNames.includes(tool.name),
  );

  const handleToggle = (toolName: string, enabled: boolean) => {
    setDisabledToolNames((current) => {
      const next = new Set(current);

      if (enabled) {
        next.delete(toolName);
      } else {
        next.add(toolName);
      }

      return Array.from(next);
    });
  };

  const handleEnableAllTools = () => {
    const availableToolNames = new Set(availableTools.map((tool) => tool.name));
    setDisabledToolNames((current) =>
      current.filter((toolName) => !availableToolNames.has(toolName)),
    );
  };

  const handleDisableAllTools = () => {
    setDisabledToolNames((current) =>
      Array.from(
        new Set([...current, ...availableTools.map((tool) => tool.name)]),
      ),
    );
  };

  const handleSave = () => {
    if (!mcpId) {
      return;
    }

    setDisabledTools.mutate(
      {
        mcpId,
        disabledTools: normalizedDisabledToolNames,
        ...(toolAccessMode ? { toolAccessMode } : {}),
      },
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
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>
            Manage {integrationName ?? 'integration'} tools
          </DialogTitle>
          <DialogDescription>
            {initialToolAccessMode
              ? 'Choose the deployment access level and manage individual MCP tools.'
              : 'Enable or disable MCP tools for this integration.'}
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
              {toolAccessMode ? (
                <div className="space-y-3 border-b pb-4">
                  <div className="space-y-1">
                    <Label>Access level</Label>
                    <p className="text-sm text-muted-foreground">
                      This setting applies to every Roomote task and automation
                      in this deployment.
                    </p>
                  </div>
                  <RadioGroup
                    value={toolAccessMode}
                    disabled={setDisabledTools.isPending}
                    onValueChange={(value) => {
                      if (value === 'read_only' || value === 'read_write') {
                        setToolAccessMode(value);
                      }
                    }}
                    className="space-y-3"
                  >
                    <div className="flex items-start gap-3">
                      <RadioGroupItem
                        id="mcp-tool-access-read-only"
                        value="read_only"
                        className="mt-1"
                      />
                      <div className="space-y-1">
                        <Label htmlFor="mcp-tool-access-read-only">
                          Read only (recommended)
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          Allow searching and reading content, while blocking
                          changes.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <RadioGroupItem
                        id="mcp-tool-access-read-write"
                        value="read_write"
                        className="mt-1"
                      />
                      <div className="space-y-1">
                        <Label htmlFor="mcp-tool-access-read-write">
                          Read and write
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          Allow tasks and unattended automations to create,
                          update, move, and comment on accessible content.
                        </p>
                      </div>
                    </div>
                  </RadioGroup>
                  {toolAccessMode === 'read_write' ? (
                    <Alert variant="warning">
                      <TriangleAlert />
                      <AlertDescription>
                        Read and write access remains limited to pages and data
                        sources explicitly shared with the deployment&apos;s
                        Notion internal integration.
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </div>
              ) : null}
              {loadedTools.map((tool, index) => {
                const available = isToolAvailableInSelectedMode(tool);
                const enabled =
                  available && !normalizedDisabledToolNames.includes(tool.name);
                const switchId = `mcp-tool-${mcpId ?? 'unknown'}-${index}`;

                return (
                  <div
                    key={tool.name}
                    className="flex min-w-0 items-start gap-4"
                  >
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex min-w-0 items-center gap-4">
                        <Switch
                          id={switchId}
                          checked={enabled}
                          aria-label={`${enabled ? 'Disable' : 'Enable'} ${tool.name}`}
                          disabled={setDisabledTools.isPending || !available}
                          onCheckedChange={(nextEnabled) =>
                            handleToggle(tool.name, nextEnabled)
                          }
                        />
                        <Label
                          htmlFor={switchId}
                          className="min-w-0 truncate text-sm text-foreground"
                        >
                          {prettifyToolName(tool.name, integrationName)}
                        </Label>
                      </div>
                      {!available ? (
                        <p className="pl-12 text-sm text-muted-foreground">
                          Requires read and write access.
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {hasLoadedTools ? (
          <DialogFooter className="md:justify-between">
            {showBulkToolActions ? (
              <div className="flex items-center gap-4 justify-start">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-0!"
                  disabled={
                    setDisabledTools.isPending ||
                    availableTools.every((tool) =>
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
                    availableTools.every(
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
