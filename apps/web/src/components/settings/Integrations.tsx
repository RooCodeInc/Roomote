'use client';

import type { FormEvent, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import {
  getMcpIntegrationConnectionMode,
  isSelfServeMcpIntegration,
  isDeploymentScopedMcpIntegration,
  MCP_INTEGRATIONS,
} from '@roomote/types';

import {
  useConnectLinear,
  useDisconnectLinear,
  useLinearInstallation,
} from '@/hooks/linear';
import {
  useAsanaConnection,
  useConnectMcp,
  useDisconnectMcp,
  useGrafanaConnection,
  useDeploymentMcpEnablements,
  useSaveAsanaConnection,
  useSaveGrafanaConnection,
  useSaveSnowflakeConnection,
  useSaveVercelConnection,
  useSetDeploymentMcpEnabled,
  useSnowflakeConnection,
  useUserMcpConnections,
  useVercelConnection,
} from '@/hooks/mcp-connections';
import { useAuthorizedUser } from '@/hooks/useUser';
import { SETTINGS_PATHS } from '@/lib/settings';
import {
  saveAsanaConnectionSchema,
  saveGrafanaConnectionSchema,
  saveSnowflakeConnectionSchema,
  saveVercelConnectionSchema,
} from '@/types';

import {
  Alert,
  AlertDescription,
  BasicTooltip,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Info,
  InfoTooltip,
  Input,
  Label,
  LinearLogo,
  Pencil,
  Plus,
  PlugIcon,
  RefreshCw,
  Settings2,
  Spinner,
  Textarea,
  TriangleAlert,
  X,
} from '@/components/system';
import { McpToolManagementDialog } from './McpToolManagementDialog';
import { McpIcon } from './McpIcon';

const DEEP_LINK_ENABLE_DESCRIPTIONS: Record<string, string> = {
  asana:
    'Roomote will be able to inspect workspaces, projects, tasks, teams, and task comments.',
  betterstack:
    'Roomote will be able to inspect monitoring, incidents, and telemetry.',
  braintrust:
    'Roomote will be able to inspect prompts, evaluations, and AI run history.',
  grafana:
    'Roomote will be able to inspect dashboards, alert rules, live alert state, annotations, and data sources.',
  github:
    'Roomote will be able to inspect PRs, issues, and repository context.',
  jira: 'Roomote will be able to inspect Jira issues, workflows, and JQL search results.',
  linear:
    'Roomote will be able to pull issue, project, and roadmap context into tasks.',
  neon: 'Roomote will get database access to inspect schemas and query data.',
  notion:
    'Roomote will be able to read Notion pages and databases for context.',
  pylon:
    'Roomote will be able to inspect customer issues, message history, and account context.',
  posthog:
    'Roomote will be able to inspect analytics, feature flags, and experiments.',
  railway:
    'Roomote will be able to inspect Railway account, project, and service inventory.',
  sentry:
    'Roomote will be able to inspect Sentry issue context and run scheduled Sentry triage through MCP.',
  supabase: 'Roomote will get read-only database access and platform context.',
  supermemory:
    'Roomote will be able to save shared memories and recall context from earlier tasks.',
  vercel:
    'Roomote will be able to inspect Vercel teams, projects, deployments, logs, and domain availability.',
  zero: 'Roomote will be able to authenticate the workspace Zero connection so agents can discover and pay for external capabilities.',
};

type IntegrationItem = {
  id: string;
  name: string;
  description: string;
  icon: ReactNode;
  enabled: boolean;
  isMcpBased: boolean;
  onAction?: () => void;
  isPending: boolean;
  actionLabel?: string;
  status?: ReactNode;
  statusIcon?: ReactNode;
  secondaryAction?: {
    label: string;
    ariaLabel: string;
    onAction: () => void;
    isPending: boolean;
    icon?: ReactNode;
  };
  headerAction?: {
    label: string;
    ariaLabel: string;
    onAction: () => void;
    isPending: boolean;
    icon: ReactNode;
  };
  utilityAction?: {
    label: string;
    ariaLabel: string;
    onAction: () => void;
    isPending: boolean;
    icon: ReactNode;
  };
  highlighted?: boolean;
};

type McpIntegrationDefinition = (typeof MCP_INTEGRATIONS)[number];

type AdminConfiguredIntegrationItemOptions = {
  integration: McpIntegrationDefinition;
  connection?: { authStatus?: string | null };
  orgEnabled: boolean;
  highlightedIntegrationId: string;
  savePending: boolean;
  disconnectPending: boolean;
  disconnectingMcpId?: string;
  dialogOpen: boolean;
  connectionPending: boolean;
  canConfigure: boolean;
  canManageTools: boolean;
  openDialog: () => void;
  openToolDialog: () => void;
  disconnectIntegration: () => void;
};

type SnowflakeFormState = {
  account: string;
  username: string;
  privateKey: string;
  privateKeyPassphrase: string;
  role: string;
};

type SnowflakeConnectionData = {
  authStatus?: 'pending' | 'authenticated' | 'error' | null;
  authMethod?: 'key_pair' | 'password';
  account: string;
  username: string;
  role: string;
};

type AsanaFormState = {
  accessToken: string;
};

type GrafanaFormState = {
  baseUrl: string;
  serviceAccountToken: string;
};

type VercelFormState = {
  accessToken: string;
  defaultTeamIdOrSlug: string;
};

type VercelConnectionData = {
  authStatus?: 'pending' | 'authenticated' | 'error' | null;
  defaultTeamIdOrSlug?: string;
};

type GrafanaConnectionData = {
  authStatus?: 'pending' | 'authenticated' | 'error' | null;
  baseUrl: string;
};

function buildEmptySnowflakeForm(): SnowflakeFormState {
  return {
    account: '',
    username: '',
    privateKey: '',
    privateKeyPassphrase: '',
    role: '',
  };
}

function buildEmptyAsanaForm(): AsanaFormState {
  return {
    accessToken: '',
  };
}

function buildEmptyGrafanaForm(): GrafanaFormState {
  return {
    baseUrl: '',
    serviceAccountToken: '',
  };
}

function buildEmptyVercelForm(): VercelFormState {
  return {
    accessToken: '',
    defaultTeamIdOrSlug: '',
  };
}

function buildSnowflakeForm(
  connection: SnowflakeConnectionData | null | undefined,
): SnowflakeFormState {
  if (!connection) {
    return buildEmptySnowflakeForm();
  }

  return {
    account: connection.account,
    username: connection.username,
    privateKey: '',
    privateKeyPassphrase: '',
    role: connection.role,
  };
}

function getSnowflakeFieldErrors(
  result: ReturnType<typeof saveSnowflakeConnectionSchema.safeParse>,
): Partial<Record<keyof SnowflakeFormState, string[]>> {
  if (result.success) {
    return {};
  }

  const fieldErrors = result.error.flatten().fieldErrors;

  return {
    account: fieldErrors.account,
    username: fieldErrors.username,
    privateKey: fieldErrors.privateKey,
    privateKeyPassphrase: fieldErrors.privateKeyPassphrase,
    role: fieldErrors.role,
  };
}

function getAsanaFieldErrors(
  result: ReturnType<typeof saveAsanaConnectionSchema.safeParse>,
): Partial<Record<keyof AsanaFormState, string[]>> {
  if (result.success) {
    return {};
  }

  const fieldErrors = result.error.flatten().fieldErrors;

  return {
    accessToken: fieldErrors.accessToken,
  };
}

function buildGrafanaForm(
  connection: GrafanaConnectionData | null | undefined,
): GrafanaFormState {
  if (!connection) {
    return buildEmptyGrafanaForm();
  }

  return {
    baseUrl: connection.baseUrl,
    serviceAccountToken: '',
  };
}

function getGrafanaFieldErrors(
  result: ReturnType<typeof saveGrafanaConnectionSchema.safeParse>,
): Partial<Record<keyof GrafanaFormState, string[]>> {
  if (!result.success) {
    const fieldErrors = result.error.flatten().fieldErrors;

    return {
      baseUrl: fieldErrors.baseUrl,
      serviceAccountToken: fieldErrors.serviceAccountToken,
    };
  }

  return {};
}

function buildVercelForm(
  connection: VercelConnectionData | null | undefined,
): VercelFormState {
  if (!connection) {
    return buildEmptyVercelForm();
  }

  return {
    accessToken: '',
    defaultTeamIdOrSlug: connection.defaultTeamIdOrSlug ?? '',
  };
}

function getVercelFieldErrors(
  result: ReturnType<typeof saveVercelConnectionSchema.safeParse>,
): Partial<Record<keyof VercelFormState, string[]>> {
  if (!result.success) {
    const fieldErrors = result.error.flatten().fieldErrors;

    return {
      accessToken: fieldErrors.accessToken,
      defaultTeamIdOrSlug: fieldErrors.defaultTeamIdOrSlug,
    };
  }

  return {};
}

export function sortIntegrationItems<T extends { id: string; name: string }>(
  items: T[],
  highlightedId?: string | null,
) {
  return [...items].sort((left, right) => {
    const leftIsHighlighted =
      highlightedId != null && left.id === highlightedId;
    const rightIsHighlighted =
      highlightedId != null && right.id === highlightedId;

    if (leftIsHighlighted || rightIsHighlighted) {
      return leftIsHighlighted ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

export function splitIntegrationItems<T extends { enabled: boolean }>(
  items: T[],
) {
  return {
    installed: items.filter((item) => item.enabled),
    available: items.filter((item) => !item.enabled),
  };
}

function buildAdminConfiguredIntegrationItem({
  integration,
  connection,
  orgEnabled,
  highlightedIntegrationId,
  savePending,
  disconnectPending,
  disconnectingMcpId,
  dialogOpen,
  connectionPending,
  canConfigure,
  canManageTools,
  openDialog,
  openToolDialog,
  disconnectIntegration,
}: AdminConfiguredIntegrationItemOptions): IntegrationItem {
  const enabled = orgEnabled || connection?.authStatus === 'authenticated';
  const isPending =
    savePending || (disconnectPending && disconnectingMcpId === integration.id);

  return {
    id: integration.id,
    name: integration.name,
    description: integration.description,
    icon: <McpIcon icon={integration.icon} name={integration.name} />,
    enabled,
    highlighted: highlightedIntegrationId === integration.id,
    isMcpBased: true,
    actionLabel: canConfigure
      ? enabled
        ? `Disconnect ${integration.name}`
        : `Configure ${integration.name}`
      : undefined,
    isPending,
    status: undefined,
    headerAction:
      canConfigure && connection != null
        ? {
            label: 'Edit connection',
            ariaLabel: `Edit ${integration.name} connection`,
            onAction: openDialog,
            isPending: isPending || (dialogOpen && connectionPending),
            icon: <Pencil className="size-4" />,
          }
        : undefined,
    secondaryAction:
      canManageTools && enabled && integration.serverMode !== 'native'
        ? {
            label: 'Manage tools',
            ariaLabel: `Manage ${integration.name} tools`,
            onAction: openToolDialog,
            isPending: false,
            icon: <Settings2 className="size-4" />,
          }
        : undefined,
    onAction: canConfigure
      ? () => {
          if (enabled) {
            disconnectIntegration();
            return;
          }

          openDialog();
        }
      : undefined,
  };
}

function IntegrationCard({ item }: { item: IntegrationItem }) {
  const actionLabel = item.onAction
    ? (item.actionLabel ??
      (item.enabled ? `Disable ${item.name}` : `Enable ${item.name}`))
    : undefined;
  const integrationTypeContent = item.isMcpBased
    ? 'MCP-based integration'
    : 'First-class integration';
  const integrationTypeIcon = item.isMcpBased ? PlugIcon : Info;
  const footerActions = [item.secondaryAction, item.headerAction].filter(
    (action): action is NonNullable<IntegrationItem['secondaryAction']> =>
      action != null,
  );
  const iconColumnWidthClass = 'w-[34px]';

  return (
    <Card
      id={`integration-${item.id}`}
      className={`h-full gap-3 ${item.highlighted ? 'border-accent-foreground ring-2 ring-primary/50 bg-primary/5' : ''}`}
      data-highlighted={item.highlighted ? 'true' : undefined}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={`mt-0.5 flex ${iconColumnWidthClass} shrink-0 items-start justify-center`}
            >
              <div className="rounded-xl border border-border/70 bg-muted/30 p-2">
                {item.icon}
              </div>
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-1.5">
                <CardTitle className="text-base">{item.name}</CardTitle>
                <InfoTooltip
                  content={integrationTypeContent}
                  icon={integrationTypeIcon}
                  iconClassName="size-4"
                />
              </div>
              <CardDescription>{item.description}</CardDescription>
            </div>
          </div>

          {item.onAction || item.utilityAction ? (
            <div className="flex items-center gap-1">
              {item.utilityAction ? (
                <BasicTooltip content={item.utilityAction.label}>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={item.utilityAction.ariaLabel}
                    onClick={item.utilityAction.onAction}
                    disabled={item.utilityAction.isPending}
                  >
                    {item.utilityAction.isPending ? (
                      <Spinner size="sm" />
                    ) : (
                      item.utilityAction.icon
                    )}
                  </Button>
                </BasicTooltip>
              ) : null}
              {actionLabel ? (
                <BasicTooltip content={actionLabel}>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={actionLabel}
                    onClick={item.onAction}
                    disabled={item.isPending}
                  >
                    {item.isPending ? (
                      <Spinner size="sm" />
                    ) : item.enabled ? (
                      <X />
                    ) : (
                      <Plus />
                    )}
                  </Button>
                </BasicTooltip>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardHeader>

      {item.status || footerActions.length > 0 ? (
        <CardContent className="p-">
          <div className="flex gap-3 p-0">
            <div
              className={`mt-0.5 ${iconColumnWidthClass} shrink-0`}
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-3">
              {item.status && (
                <div className="flex items-start gap-2">
                  {item.statusIcon ? (
                    <span className="mt-0.5 shrink-0 text-destructive">
                      {item.statusIcon}
                    </span>
                  ) : null}
                  <p className="text-sm text-muted-foreground">{item.status}</p>
                </div>
              )}
              {footerActions.length > 0 ? (
                <div className="flex gap-2">
                  {footerActions.map((action) => (
                    <Button
                      key={action.ariaLabel}
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={action.ariaLabel}
                      onClick={action.onAction}
                      disabled={action.isPending}
                    >
                      {action.isPending ? <Spinner size="sm" /> : action.icon}
                      {action.label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

function IntegrationSection({
  id,
  title,
  items,
}: {
  id: string;
  title: string;
  items: IntegrationItem[];
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-sm font-semibold text-foreground">
        {title}
      </h2>

      <div className="grid gap-4 md:grid-cols-2">
        {items.map((item) => (
          <IntegrationCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

function DeepLinkEnableDialog({
  item,
  open,
  onDismiss,
  onEnable,
}: {
  item: IntegrationItem | null;
  open: boolean;
  onDismiss: () => void;
  onEnable: () => void;
}) {
  if (!item) {
    return null;
  }

  const description = DEEP_LINK_ENABLE_DESCRIPTIONS[item.id];

  if (!description) {
    return null;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onDismiss();
        }
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Enable {item.name}?</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDismiss}>
            Not now
          </Button>
          <Button type="button" disabled={item.isPending} onClick={onEnable}>
            Enable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdminConfiguredIntegrationDialog({
  integrationName,
  open,
  onOpenChange,
  isEditing,
  isPending,
  isLoading,
  description,
  loadingMessage,
  submitLabel,
  onSubmit,
  children,
}: {
  integrationName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isEditing: boolean;
  isPending: boolean;
  isLoading: boolean;
  description: ReactNode;
  loadingMessage?: string;
  submitLabel?: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const dialogTitle = `${isEditing ? 'Edit' : 'Connect'} ${integrationName}`;
  const resolvedLoadingMessage =
    loadingMessage ?? 'Loading connection settings...';
  const resolvedSubmitLabel =
    submitLabel ?? (isEditing ? 'Save changes' : `Connect ${integrationName}`);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner size="sm" />
            {resolvedLoadingMessage}
          </div>
        ) : (
          <form className="space-y-4" onSubmit={onSubmit}>
            {children}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? <Spinner size="sm" /> : null}
                {resolvedSubmitLabel}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SnowflakeConnectionFields({
  form,
  fieldErrors,
  formError,
  allowBlankPrivateKey,
  onFieldChange,
}: {
  form: SnowflakeFormState;
  fieldErrors: Partial<Record<keyof SnowflakeFormState, string[]>>;
  formError: string | null;
  allowBlankPrivateKey: boolean;
  onFieldChange: (field: keyof SnowflakeFormState, value: string) => void;
}) {
  const fieldClassName =
    'mt-2 w-full border-border/70 bg-background data-[invalid=true]:border-destructive';

  return (
    <>
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="snowflake-account">Account identifier</Label>
            <Input
              id="snowflake-account"
              placeholder="xy12345.us-east-1"
              value={form.account}
              onChange={(event) => onFieldChange('account', event.target.value)}
              data-invalid={fieldErrors.account ? 'true' : undefined}
              className={fieldClassName}
              data-1p-ignore
            />
            {fieldErrors.account ? (
              <p className="text-sm text-destructive">
                {fieldErrors.account[0]}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="snowflake-username">Username</Label>
            <Input
              id="snowflake-username"
              placeholder="roomote_user"
              value={form.username}
              onChange={(event) =>
                onFieldChange('username', event.target.value)
              }
              data-invalid={fieldErrors.username ? 'true' : undefined}
              className={fieldClassName}
              data-1p-ignore
            />
            {fieldErrors.username ? (
              <p className="text-sm text-destructive">
                {fieldErrors.username[0]}
              </p>
            ) : null}
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="snowflake-private-key">Private Key (PEM)</Label>
            <Textarea
              id="snowflake-private-key"
              rows={6}
              placeholder="-----BEGIN PRIVATE KEY-----"
              value={form.privateKey}
              onChange={(event) =>
                onFieldChange('privateKey', event.target.value)
              }
              data-invalid={fieldErrors.privateKey ? 'true' : undefined}
              className={fieldClassName}
              data-1p-ignore
            />
            <p className="text-sm text-muted-foreground">
              Paste your PKCS8 PEM-encoded private key. Generate one with
              OpenSSL and assign the public key to your Snowflake user.
            </p>
            {allowBlankPrivateKey ? (
              <p className="text-sm text-muted-foreground">
                Leave blank to keep the existing private key.
              </p>
            ) : null}
            {fieldErrors.privateKey ? (
              <p className="text-sm text-destructive">
                {fieldErrors.privateKey[0]}
              </p>
            ) : null}
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="snowflake-private-key-passphrase">
              Private Key Passphrase (optional)
            </Label>
            <Input
              id="snowflake-private-key-passphrase"
              value={form.privateKeyPassphrase}
              onChange={(event) =>
                onFieldChange('privateKeyPassphrase', event.target.value)
              }
              data-invalid={
                fieldErrors.privateKeyPassphrase ? 'true' : undefined
              }
              className={fieldClassName}
              data-1p-ignore
            />
            <p className="text-sm text-muted-foreground">
              Only needed if your private key is encrypted.
            </p>
            {fieldErrors.privateKeyPassphrase ? (
              <p className="text-sm text-destructive">
                {fieldErrors.privateKeyPassphrase[0]}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="snowflake-role">Role</Label>
            <Input
              id="snowflake-role"
              placeholder="ANALYST"
              value={form.role}
              onChange={(event) => onFieldChange('role', event.target.value)}
              data-invalid={fieldErrors.role ? 'true' : undefined}
              className={fieldClassName}
              data-1p-ignore
            />
            {fieldErrors.role ? (
              <p className="text-sm text-destructive">{fieldErrors.role[0]}</p>
            ) : null}
          </div>
        </div>
      </div>
      {formError ? (
        <p className="text-sm text-destructive">{formError}</p>
      ) : null}
    </>
  );
}

function AsanaConnectionFields({
  form,
  fieldErrors,
  formError,
  allowBlankToken,
  onFieldChange,
}: {
  form: AsanaFormState;
  fieldErrors: Partial<Record<keyof AsanaFormState, string[]>>;
  formError: string | null;
  allowBlankToken: boolean;
  onFieldChange: (field: keyof AsanaFormState, value: string) => void;
}) {
  const fieldClassName =
    'mt-2 w-full border-border/70 bg-background data-[invalid=true]:border-destructive';

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="asana-access-token">Asana Access Token</Label>
        <Input
          id="asana-access-token"
          placeholder="0/1234567890abcdef..."
          value={form.accessToken}
          onChange={(event) => onFieldChange('accessToken', event.target.value)}
          data-invalid={fieldErrors.accessToken ? 'true' : undefined}
          className={fieldClassName}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
        />
        <p className="text-sm text-muted-foreground">
          Works with both Personal Access Tokens and Service Account tokens.
          Generate a PAT in Asana at https://app.asana.com/0/my-apps.
        </p>
        {allowBlankToken ? (
          <p className="text-sm text-muted-foreground">
            Leave blank to keep the existing token.
          </p>
        ) : null}
        {fieldErrors.accessToken ? (
          <p className="text-sm text-destructive">
            {fieldErrors.accessToken[0]}
          </p>
        ) : null}
      </div>
      {formError ? (
        <p className="text-sm text-destructive">{formError}</p>
      ) : null}
    </>
  );
}

function GrafanaConnectionFields({
  form,
  fieldErrors,
  formError,
  allowBlankToken,
  onFieldChange,
}: {
  form: GrafanaFormState;
  fieldErrors: Partial<Record<keyof GrafanaFormState, string[]>>;
  formError: string | null;
  allowBlankToken: boolean;
  onFieldChange: (field: keyof GrafanaFormState, value: string) => void;
}) {
  const fieldClassName =
    'mt-2 w-full border-border/70 bg-background data-[invalid=true]:border-destructive';

  return (
    <>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="grafana-base-url">Grafana URL</Label>
          <Input
            id="grafana-base-url"
            placeholder="https://grafana.example.com"
            value={form.baseUrl}
            onChange={(event) => onFieldChange('baseUrl', event.target.value)}
            data-invalid={fieldErrors.baseUrl ? 'true' : undefined}
            className={fieldClassName}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
          />
          <p className="text-sm text-muted-foreground">
            Use the base URL for the shared Grafana instance that this workspace
            should inspect.
          </p>
          {fieldErrors.baseUrl ? (
            <p className="text-sm text-destructive">{fieldErrors.baseUrl[0]}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="grafana-service-account-token">
            Grafana Service Account Token
          </Label>
          <Input
            id="grafana-service-account-token"
            placeholder="glsa_..."
            value={form.serviceAccountToken}
            onChange={(event) =>
              onFieldChange('serviceAccountToken', event.target.value)
            }
            data-invalid={fieldErrors.serviceAccountToken ? 'true' : undefined}
            className={fieldClassName}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
          />
          <p className="text-sm text-muted-foreground">
            Use a read-only service account token with access to dashboards,
            alerting, data sources, and annotations.
          </p>
          {allowBlankToken ? (
            <p className="text-sm text-muted-foreground">
              Leave blank to keep the existing token.
            </p>
          ) : null}
          {fieldErrors.serviceAccountToken ? (
            <p className="text-sm text-destructive">
              {fieldErrors.serviceAccountToken[0]}
            </p>
          ) : null}
        </div>
      </div>
      {formError ? (
        <p className="text-sm text-destructive">{formError}</p>
      ) : null}
    </>
  );
}

function VercelConnectionFields({
  form,
  fieldErrors,
  formError,
  allowBlankToken,
  onFieldChange,
}: {
  form: VercelFormState;
  fieldErrors: Partial<Record<keyof VercelFormState, string[]>>;
  formError: string | null;
  allowBlankToken: boolean;
  onFieldChange: (field: keyof VercelFormState, value: string) => void;
}) {
  const fieldClassName =
    'mt-2 w-full border-border/70 bg-background data-[invalid=true]:border-destructive';

  return (
    <>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="vercel-access-token">Vercel Access Token</Label>
          <Input
            id="vercel-access-token"
            placeholder="vercel_..."
            value={form.accessToken}
            onChange={(event) =>
              onFieldChange('accessToken', event.target.value)
            }
            data-invalid={fieldErrors.accessToken ? 'true' : undefined}
            className={fieldClassName}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
          />
          <p className="text-sm text-muted-foreground">
            Create a Vercel access token with the minimum scopes needed for the
            shared team or account this workspace should inspect.
          </p>
          {allowBlankToken ? (
            <p className="text-sm text-muted-foreground">
              Leave blank to keep the existing token.
            </p>
          ) : null}
          {fieldErrors.accessToken ? (
            <p className="text-sm text-destructive">
              {fieldErrors.accessToken[0]}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="vercel-default-team">
            Default Team ID or Slug (optional)
          </Label>
          <Input
            id="vercel-default-team"
            placeholder="team_123abc or acme-team"
            value={form.defaultTeamIdOrSlug}
            onChange={(event) =>
              onFieldChange('defaultTeamIdOrSlug', event.target.value)
            }
            data-invalid={fieldErrors.defaultTeamIdOrSlug ? 'true' : undefined}
            className={fieldClassName}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <p className="text-sm text-muted-foreground">
            Optional default team scope for tools like project and deployment
            lookups. Leave blank to let tools work against the token&apos;s
            personal account unless a team is provided in the tool input.
          </p>
          {fieldErrors.defaultTeamIdOrSlug ? (
            <p className="text-sm text-destructive">
              {fieldErrors.defaultTeamIdOrSlug[0]}
            </p>
          ) : null}
        </div>
      </div>
      {formError ? (
        <p className="text-sm text-destructive">{formError}</p>
      ) : null}
    </>
  );
}

export function Integrations() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAdmin } = useAuthorizedUser();
  const deepLinkedIntegrationId = (
    searchParams.get('service') ??
    searchParams.get('highlight') ??
    ''
  ).trim();
  const [dismissedDeepLinkIntegrationId, setDismissedDeepLinkIntegrationId] =
    useState<string | null>(null);
  const [clearedDeepLinkIntegrationId, setClearedDeepLinkIntegrationId] =
    useState<string | null>(null);
  const highlightedIntegrationId =
    clearedDeepLinkIntegrationId === deepLinkedIntegrationId
      ? ''
      : deepLinkedIntegrationId;
  const [isAsanaDialogOpen, setIsAsanaDialogOpen] = useState(false);
  const [asanaForm, setAsanaForm] = useState<AsanaFormState>(
    buildEmptyAsanaForm(),
  );
  const [asanaFieldErrors, setAsanaFieldErrors] = useState<
    Partial<Record<keyof AsanaFormState, string[]>>
  >({});
  const [asanaFormError, setAsanaFormError] = useState<string | null>(null);
  const [isGrafanaDialogOpen, setIsGrafanaDialogOpen] = useState(false);
  const [grafanaForm, setGrafanaForm] = useState<GrafanaFormState>(
    buildEmptyGrafanaForm(),
  );
  const [grafanaFieldErrors, setGrafanaFieldErrors] = useState<
    Partial<Record<keyof GrafanaFormState, string[]>>
  >({});
  const [grafanaFormError, setGrafanaFormError] = useState<string | null>(null);
  const [isSnowflakeDialogOpen, setIsSnowflakeDialogOpen] = useState(false);
  const [snowflakeForm, setSnowflakeForm] = useState<SnowflakeFormState>(
    buildEmptySnowflakeForm(),
  );
  const [snowflakeFieldErrors, setSnowflakeFieldErrors] = useState<
    Partial<Record<keyof SnowflakeFormState, string[]>>
  >({});
  const [snowflakeFormError, setSnowflakeFormError] = useState<string | null>(
    null,
  );
  const [isVercelDialogOpen, setIsVercelDialogOpen] = useState(false);
  const [vercelForm, setVercelForm] = useState<VercelFormState>(
    buildEmptyVercelForm(),
  );
  const [vercelFieldErrors, setVercelFieldErrors] = useState<
    Partial<Record<keyof VercelFormState, string[]>>
  >({});
  const [vercelFormError, setVercelFormError] = useState<string | null>(null);
  const [toolDialogState, setToolDialogState] = useState<{
    mcpId: string;
    integrationName: string;
  } | null>(null);

  const linearInstallation = useLinearInstallation();
  const connectLinear = useConnectLinear(pathname);
  const disconnectLinear = useDisconnectLinear();

  const deploymentEnablements = useDeploymentMcpEnablements();
  const setDeploymentEnabled = useSetDeploymentMcpEnabled();
  const userMcpConnections = useUserMcpConnections();
  const connectMcp = useConnectMcp();
  const disconnectMcp = useDisconnectMcp();
  const saveAsanaConnection = useSaveAsanaConnection();
  const saveGrafanaConnection = useSaveGrafanaConnection();
  const saveSnowflakeConnection = useSaveSnowflakeConnection();
  const saveVercelConnection = useSaveVercelConnection();
  const asanaConnectionSummary = useMemo(() => {
    const connection = (userMcpConnections.data ?? []).find(
      (entry) => entry.mcpId === 'asana',
    );

    return connection;
  }, [userMcpConnections.data]);
  const isAsanaConnected =
    asanaConnectionSummary?.authStatus === 'authenticated';
  const asanaConnection = useAsanaConnection(
    isAdmin && (isAsanaConnected || isAsanaDialogOpen),
  );
  const grafanaConnectionSummary = useMemo(() => {
    const connection = (userMcpConnections.data ?? []).find(
      (entry) => entry.mcpId === 'grafana',
    );

    return connection;
  }, [userMcpConnections.data]);
  const isGrafanaConnected =
    grafanaConnectionSummary?.authStatus === 'authenticated';
  const grafanaConnection = useGrafanaConnection(
    isAdmin && (isGrafanaConnected || isGrafanaDialogOpen),
  );
  const snowflakeConnectionSummary = useMemo(() => {
    const connection = (userMcpConnections.data ?? []).find(
      (entry) => entry.mcpId === 'snowflake',
    );

    return connection;
  }, [userMcpConnections.data]);
  const isSnowflakeConnected =
    snowflakeConnectionSummary?.authStatus === 'authenticated';
  const snowflakeConnection = useSnowflakeConnection(
    isAdmin && (isSnowflakeConnected || isSnowflakeDialogOpen),
  );
  const vercelConnectionSummary = useMemo(() => {
    const connection = (userMcpConnections.data ?? []).find(
      (entry) => entry.mcpId === 'vercel',
    );

    return connection;
  }, [userMcpConnections.data]);
  const isVercelConnected =
    vercelConnectionSummary?.authStatus === 'authenticated';
  const vercelConnection = useVercelConnection(
    isAdmin && (isVercelConnected || isVercelDialogOpen),
  );
  const allowsBlankSnowflakePrivateKey =
    snowflakeConnection.data?.authMethod === 'key_pair';

  useEffect(() => {
    if (!isAsanaDialogOpen) {
      return;
    }

    if (asanaConnection.isPending && isAsanaConnected) {
      return;
    }

    setAsanaFieldErrors({});
    setAsanaFormError(null);
    setAsanaForm(buildEmptyAsanaForm());
  }, [asanaConnection.isPending, isAsanaConnected, isAsanaDialogOpen]);

  useEffect(() => {
    if (!isSnowflakeDialogOpen) {
      return;
    }

    if (snowflakeConnection.isPending && isSnowflakeConnected) {
      return;
    }

    setSnowflakeFieldErrors({});
    setSnowflakeFormError(null);
    setSnowflakeForm(buildSnowflakeForm(snowflakeConnection.data));
  }, [
    isSnowflakeConnected,
    isSnowflakeDialogOpen,
    snowflakeConnection.data,
    snowflakeConnection.isPending,
  ]);

  useEffect(() => {
    if (!isGrafanaDialogOpen) {
      return;
    }

    if (grafanaConnection.isPending && isGrafanaConnected) {
      return;
    }

    setGrafanaFieldErrors({});
    setGrafanaFormError(null);
    setGrafanaForm(buildGrafanaForm(grafanaConnection.data));
  }, [
    grafanaConnection.data,
    grafanaConnection.isPending,
    isGrafanaConnected,
    isGrafanaDialogOpen,
  ]);

  useEffect(() => {
    if (!isVercelDialogOpen) {
      return;
    }

    if (vercelConnection.isPending && isVercelConnected) {
      return;
    }

    setVercelFieldErrors({});
    setVercelFormError(null);
    setVercelForm(buildVercelForm(vercelConnection.data));
  }, [
    isVercelConnected,
    isVercelDialogOpen,
    vercelConnection.data,
    vercelConnection.isPending,
  ]);

  const items = useMemo<IntegrationItem[]>(() => {
    const visibleMcpIntegrations = MCP_INTEGRATIONS;
    const orgEnablementMap = new Map(
      (deploymentEnablements.data ?? []).map((entry) => [
        entry.mcpId,
        entry.enabled,
      ]),
    );
    const userConnectionMap = new Map(
      (userMcpConnections.data ?? []).map((entry) => [entry.mcpId, entry]),
    );
    const openMcpToolDialog = (integration: McpIntegrationDefinition) =>
      setToolDialogState({
        mcpId: integration.id,
        integrationName: integration.name,
      });
    const disconnectAdminConfiguredIntegration = (
      integration: McpIntegrationDefinition,
    ) => {
      disconnectMcp.mutate(
        { mcpId: integration.id },
        {
          onSuccess: () => {
            toast.success(
              `${integration.name} disconnected for this deployment.`,
            );
          },
          onError: (error) =>
            toast.error(
              error instanceof Error
                ? error.message
                : `Failed to disconnect ${integration.name}.`,
            ),
        },
      );
    };

    const baseItems: IntegrationItem[] = [
      {
        id: 'linear',
        name: 'Linear',
        description:
          'Enable Linear so this deployment can route issue context and task entry through it.',
        icon: <LinearLogo className="size-5" />,
        enabled: Boolean(linearInstallation.data),
        highlighted: highlightedIntegrationId === 'linear',
        isMcpBased: false,
        isPending:
          linearInstallation.isPending ||
          connectLinear.isPending ||
          disconnectLinear.isPending,
        onAction: () => {
          if (linearInstallation.data) {
            disconnectLinear.mutate(undefined, {
              onSuccess: () =>
                toast.success('Linear disabled for this deployment.'),
              onError: () =>
                toast.error('Failed to disable Linear. Please try again.'),
            });
            return;
          }

          connectLinear.mutate(undefined, {
            onSuccess: (url) => {
              window.location.href = url;
            },
            onError: () =>
              toast.error('Failed to enable Linear. Please try again.'),
          });
        },
      },
      ...visibleMcpIntegrations
        .filter((integration) => {
          if (integration.id === 'linear') {
            return false;
          }

          const connectionMode = getMcpIntegrationConnectionMode(integration);

          return (
            isSelfServeMcpIntegration(integration) ||
            connectionMode === 'admin_configured'
          );
        })
        .map((integration) => {
          if (integration.id === 'asana') {
            return buildAdminConfiguredIntegrationItem({
              integration,
              connection: userConnectionMap.get(integration.id),
              orgEnabled: orgEnablementMap.get(integration.id) ?? false,
              highlightedIntegrationId,
              savePending: saveAsanaConnection.isPending,
              disconnectPending: disconnectMcp.isPending,
              disconnectingMcpId: disconnectMcp.variables?.mcpId,
              dialogOpen: isAsanaDialogOpen,
              connectionPending: asanaConnection.isPending,
              canConfigure: isAdmin,
              canManageTools: isAdmin,
              openDialog: () => setIsAsanaDialogOpen(true),
              openToolDialog: () => openMcpToolDialog(integration),
              disconnectIntegration: () =>
                disconnectAdminConfiguredIntegration(integration),
            });
          }

          if (integration.id === 'snowflake') {
            return buildAdminConfiguredIntegrationItem({
              integration,
              connection: userConnectionMap.get(integration.id),
              orgEnabled: orgEnablementMap.get(integration.id) ?? false,
              highlightedIntegrationId,
              savePending: saveSnowflakeConnection.isPending,
              disconnectPending: disconnectMcp.isPending,
              disconnectingMcpId: disconnectMcp.variables?.mcpId,
              dialogOpen: isSnowflakeDialogOpen,
              connectionPending: snowflakeConnection.isPending,
              canConfigure: true,
              canManageTools: isAdmin,
              openDialog: () => setIsSnowflakeDialogOpen(true),
              openToolDialog: () => openMcpToolDialog(integration),
              disconnectIntegration: () =>
                disconnectAdminConfiguredIntegration(integration),
            });
          }

          if (integration.id === 'grafana') {
            return buildAdminConfiguredIntegrationItem({
              integration,
              connection: userConnectionMap.get(integration.id),
              orgEnabled: orgEnablementMap.get(integration.id) ?? false,
              highlightedIntegrationId,
              savePending: saveGrafanaConnection.isPending,
              disconnectPending: disconnectMcp.isPending,
              disconnectingMcpId: disconnectMcp.variables?.mcpId,
              dialogOpen: isGrafanaDialogOpen,
              connectionPending: grafanaConnection.isPending,
              canConfigure: isAdmin,
              canManageTools: isAdmin,
              openDialog: () => setIsGrafanaDialogOpen(true),
              openToolDialog: () => openMcpToolDialog(integration),
              disconnectIntegration: () =>
                disconnectAdminConfiguredIntegration(integration),
            });
          }

          if (integration.id === 'vercel') {
            return buildAdminConfiguredIntegrationItem({
              integration,
              connection: userConnectionMap.get(integration.id),
              orgEnabled: orgEnablementMap.get(integration.id) ?? false,
              highlightedIntegrationId,
              savePending: saveVercelConnection.isPending,
              disconnectPending: disconnectMcp.isPending,
              disconnectingMcpId: disconnectMcp.variables?.mcpId,
              dialogOpen: isVercelDialogOpen,
              connectionPending: vercelConnection.isPending,
              canConfigure: isAdmin,
              canManageTools: isAdmin,
              openDialog: () => setIsVercelDialogOpen(true),
              openToolDialog: () => openMcpToolDialog(integration),
              disconnectIntegration: () =>
                disconnectAdminConfiguredIntegration(integration),
            });
          }

          const enabled = orgEnablementMap.get(integration.id) ?? false;
          const isDeploymentScoped =
            isDeploymentScopedMcpIntegration(integration);
          const connection = userConnectionMap.get(integration.id);
          const isConnected = connection?.authStatus === 'authenticated';
          const isConnectPending =
            connectMcp.isPending &&
            connectMcp.variables?.mcpId === integration.id;
          const isSentryMcpIntegration = integration.id === 'sentry';
          const displayId = isSentryMcpIntegration
            ? 'sentry-mcp'
            : integration.id;
          const displayName = integration.name;
          const displayDescription = isSentryMcpIntegration
            ? 'Connect Sentry to bring Sentry issue and project context into tasks.'
            : integration.description;

          return {
            id: displayId,
            name: displayName,
            description: displayDescription,
            icon: <McpIcon icon={integration.icon} name={displayName} />,
            enabled,
            highlighted: highlightedIntegrationId === displayId,
            isMcpBased: true,
            actionLabel:
              !enabled && isDeploymentScoped
                ? `Connect and enable ${displayName}`
                : undefined,
            isPending:
              (!enabled && isDeploymentScoped && isConnectPending) ||
              (setDeploymentEnabled.isPending &&
                setDeploymentEnabled.variables?.mcpId === integration.id),
            status:
              enabled && isDeploymentScoped && !isConnected
                ? 'Connection needs attention. Reconnect it here to keep it available to the workspace.'
                : undefined,
            statusIcon:
              enabled && isDeploymentScoped && !isConnected ? (
                <TriangleAlert className="size-4" />
              ) : undefined,
            secondaryAction:
              isAdmin &&
              enabled &&
              integration.serverMode !== 'native' &&
              (!isDeploymentScoped || isConnected)
                ? {
                    label: 'Manage tools',
                    ariaLabel: `Manage ${displayName} tools`,
                    onAction: () =>
                      setToolDialogState({
                        mcpId: integration.id,
                        integrationName: displayName,
                      }),
                    isPending: false,
                    icon: <Settings2 className="size-4" />,
                  }
                : enabled && isDeploymentScoped && !isConnected
                  ? {
                      label: 'Reconnect account',
                      ariaLabel: `Reconnect ${displayName} workspace account`,
                      onAction: () => {
                        connectMcp.mutate(
                          { mcpId: integration.id, redirectTo: pathname },
                          {
                            onSuccess: (url) => {
                              window.location.href = url;
                            },
                            onError: (error) =>
                              toast.error(
                                error instanceof Error
                                  ? error.message
                                  : `Failed to connect ${displayName}.`,
                              ),
                          },
                        );
                      },
                      isPending: isConnectPending,
                      icon: <RefreshCw className="size-4" />,
                    }
                  : undefined,
            onAction: () => {
              if (!enabled && isDeploymentScoped) {
                connectMcp.mutate(
                  { mcpId: integration.id, redirectTo: pathname },
                  {
                    onSuccess: (url) => {
                      window.location.href = url;
                    },
                    onError: (error) =>
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : `Failed to connect ${displayName}.`,
                      ),
                  },
                );
                return;
              }

              const nextEnabled = !enabled;
              setDeploymentEnabled.mutate(
                { mcpId: integration.id, enabled: nextEnabled },
                {
                  onSuccess: () => {
                    if (
                      nextEnabled &&
                      !isDeploymentScopedMcpIntegration(integration)
                    ) {
                      toast.success(
                        `${displayName} enabled for this deployment. Each team member can now connect their own ${displayName} account from Personal settings.`,
                      );
                      return;
                    }

                    toast.success(
                      `${displayName} ${nextEnabled ? 'enabled' : 'disabled'} for this deployment.`,
                    );
                  },
                  onError: (error) =>
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : `Failed to ${nextEnabled ? 'enable' : 'disable'} ${displayName}.`,
                    ),
                },
              );
            },
          } satisfies IntegrationItem;
        }),
    ];

    return sortIntegrationItems(baseItems, highlightedIntegrationId);
  }, [
    connectLinear,
    connectMcp,
    disconnectLinear,
    disconnectMcp,
    grafanaConnection.isPending,
    linearInstallation.data,
    linearInstallation.isPending,
    isAdmin,
    isGrafanaDialogOpen,
    saveAsanaConnection.isPending,
    saveGrafanaConnection.isPending,
    saveVercelConnection.isPending,
    deploymentEnablements.data,
    pathname,
    setDeploymentEnabled,
    saveSnowflakeConnection.isPending,
    asanaConnection.isPending,
    isAsanaDialogOpen,
    snowflakeConnection.isPending,
    isSnowflakeDialogOpen,
    vercelConnection.isPending,
    isVercelDialogOpen,
    highlightedIntegrationId,
    userMcpConnections.data,
  ]);

  const { installed, available } = splitIntegrationItems(items);
  const visibleMcpIntegrationIds = new Set(
    MCP_INTEGRATIONS.map((integration) => integration.id),
  );
  const hasEnabledMcpIntegration = (deploymentEnablements.data ?? []).some(
    (entry) => entry.enabled && visibleMcpIntegrationIds.has(entry.mcpId),
  );
  const highlightedItem =
    items.find((item) => item.id === highlightedIntegrationId) ?? null;
  const deepLinkDialogItem =
    highlightedItem != null &&
    highlightedItem.onAction != null &&
    !highlightedItem.enabled &&
    DEEP_LINK_ENABLE_DESCRIPTIONS[highlightedItem.id] != null
      ? highlightedItem
      : null;

  useEffect(() => {
    setDismissedDeepLinkIntegrationId(null);
    setClearedDeepLinkIntegrationId(null);
  }, [deepLinkedIntegrationId]);

  const dismissDeepLinkDialog = () => {
    if (deepLinkDialogItem == null) {
      return;
    }

    setDismissedDeepLinkIntegrationId(deepLinkDialogItem.id);
  };

  const clearDeepLinkHighlight = () => {
    if (deepLinkedIntegrationId.length === 0) {
      return;
    }

    setDismissedDeepLinkIntegrationId(deepLinkedIntegrationId);
    setClearedDeepLinkIntegrationId(deepLinkedIntegrationId);

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.delete('service');
    nextSearchParams.delete('highlight');

    const nextSearch = nextSearchParams.toString();
    window.history.replaceState(
      null,
      '',
      nextSearch.length > 0 ? `${pathname}?${nextSearch}` : pathname,
    );
  };

  const handleSnowflakeFieldChange = (
    field: keyof SnowflakeFormState,
    value: string,
  ) => {
    setSnowflakeForm((current) => ({ ...current, [field]: value }));
    setSnowflakeFieldErrors((current) => {
      if (!current[field]) {
        return current;
      }

      return { ...current, [field]: undefined };
    });
    setSnowflakeFormError(null);
  };

  const handleAsanaFieldChange = (
    field: keyof AsanaFormState,
    value: string,
  ) => {
    setAsanaForm((current) => ({ ...current, [field]: value }));
    setAsanaFieldErrors((current) => {
      if (!current[field]) {
        return current;
      }

      return { ...current, [field]: undefined };
    });
    setAsanaFormError(null);
  };

  const handleGrafanaFieldChange = (
    field: keyof GrafanaFormState,
    value: string,
  ) => {
    setGrafanaForm((current) => ({ ...current, [field]: value }));
    setGrafanaFieldErrors((current) => {
      if (!current[field]) {
        return current;
      }

      return { ...current, [field]: undefined };
    });
    setGrafanaFormError(null);
  };

  const handleVercelFieldChange = (
    field: keyof VercelFormState,
    value: string,
  ) => {
    setVercelForm((current) => ({ ...current, [field]: value }));
    setVercelFieldErrors((current) => {
      if (!current[field]) {
        return current;
      }

      return { ...current, [field]: undefined };
    });
    setVercelFormError(null);
  };

  const handleAsanaDialogOpenChange = (open: boolean) => {
    setIsAsanaDialogOpen(open);

    setAsanaFieldErrors({});
    setAsanaFormError(null);

    if (!open) {
      return;
    }

    setAsanaForm(buildEmptyAsanaForm());
  };

  const handleSnowflakeDialogOpenChange = (open: boolean) => {
    setIsSnowflakeDialogOpen(open);

    setSnowflakeFieldErrors({});
    setSnowflakeFormError(null);

    if (!open) {
      return;
    }

    if (!isSnowflakeConnected) {
      setSnowflakeForm(buildEmptySnowflakeForm());
    }
  };

  const handleGrafanaDialogOpenChange = (open: boolean) => {
    setIsGrafanaDialogOpen(open);

    setGrafanaFieldErrors({});
    setGrafanaFormError(null);

    if (!open) {
      return;
    }

    if (!isGrafanaConnected) {
      setGrafanaForm(buildEmptyGrafanaForm());
    }
  };

  const handleVercelDialogOpenChange = (open: boolean) => {
    setIsVercelDialogOpen(open);

    setVercelFieldErrors({});
    setVercelFormError(null);

    if (!open) {
      return;
    }

    if (!isVercelConnected) {
      setVercelForm(buildEmptyVercelForm());
    }
  };

  const handleAsanaSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsed = saveAsanaConnectionSchema.safeParse({
      accessToken: asanaForm.accessToken,
    });
    if (!parsed.success) {
      setAsanaFieldErrors(getAsanaFieldErrors(parsed));
      return;
    }

    if (!isAsanaConnected && parsed.data.accessToken.length === 0) {
      setAsanaFieldErrors({
        accessToken: ['Access token is required'],
      });
      return;
    }

    setAsanaFieldErrors({});
    setAsanaFormError(null);

    saveAsanaConnection.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(
          isAsanaConnected
            ? 'Asana connection updated for this deployment.'
            : 'Asana connected for this deployment.',
        );
        handleAsanaDialogOpenChange(false);
      },
      onError: (error) => {
        setAsanaFormError(error.message);
      },
    });
  };

  const handleSnowflakeSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsed = saveSnowflakeConnectionSchema.safeParse({
      authMethod: 'key_pair',
      account: snowflakeForm.account,
      username: snowflakeForm.username,
      password: '',
      privateKey: snowflakeForm.privateKey,
      privateKeyPassphrase: snowflakeForm.privateKeyPassphrase,
      role: snowflakeForm.role,
    });
    if (!parsed.success) {
      setSnowflakeFieldErrors(getSnowflakeFieldErrors(parsed));
      return;
    }

    if (
      !allowsBlankSnowflakePrivateKey &&
      parsed.data.privateKey.trim().length === 0
    ) {
      setSnowflakeFieldErrors({
        privateKey: ['Private key is required'],
      });
      return;
    }

    setSnowflakeFieldErrors({});
    setSnowflakeFormError(null);

    saveSnowflakeConnection.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(
          isSnowflakeConnected
            ? 'Snowflake connection updated for this deployment.'
            : 'Snowflake connected for this deployment.',
        );
        handleSnowflakeDialogOpenChange(false);
      },
      onError: (error) => {
        setSnowflakeFormError(error.message);
      },
    });
  };

  const handleGrafanaSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsed = saveGrafanaConnectionSchema.safeParse({
      baseUrl: grafanaForm.baseUrl,
      serviceAccountToken: grafanaForm.serviceAccountToken,
    });
    if (!parsed.success) {
      setGrafanaFieldErrors(getGrafanaFieldErrors(parsed));
      return;
    }

    if (!isGrafanaConnected && parsed.data.serviceAccountToken.length === 0) {
      setGrafanaFieldErrors({
        serviceAccountToken: ['Service account token is required'],
      });
      return;
    }

    setGrafanaFieldErrors({});
    setGrafanaFormError(null);

    saveGrafanaConnection.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(
          isGrafanaConnected
            ? 'Grafana connection updated for this deployment.'
            : 'Grafana connected for this deployment.',
        );
        handleGrafanaDialogOpenChange(false);
      },
      onError: (error) => {
        setGrafanaFormError(error.message);
      },
    });
  };

  const handleVercelSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsed = saveVercelConnectionSchema.safeParse({
      accessToken: vercelForm.accessToken,
      defaultTeamIdOrSlug: vercelForm.defaultTeamIdOrSlug,
    });
    if (!parsed.success) {
      setVercelFieldErrors(getVercelFieldErrors(parsed));
      return;
    }

    if (!isVercelConnected && parsed.data.accessToken.length === 0) {
      setVercelFieldErrors({
        accessToken: ['Access token is required'],
      });
      return;
    }

    setVercelFieldErrors({});
    setVercelFormError(null);

    saveVercelConnection.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(
          isVercelConnected
            ? 'Vercel connection updated for this deployment.'
            : 'Vercel connected for this deployment.',
        );
        handleVercelDialogOpenChange(false);
      },
      onError: (error) => {
        setVercelFormError(error.message);
      },
    });
  };

  return (
    <div className="space-y-8">
      <McpToolManagementDialog
        mcpId={toolDialogState?.mcpId ?? null}
        integrationName={toolDialogState?.integrationName ?? null}
        open={toolDialogState != null}
        onOpenChange={(open) => {
          if (!open) {
            setToolDialogState(null);
          }
        }}
      />
      <AdminConfiguredIntegrationDialog
        integrationName="Asana"
        open={isAsanaDialogOpen}
        onOpenChange={handleAsanaDialogOpenChange}
        isEditing={isAsanaConnected}
        isPending={saveAsanaConnection.isPending}
        isLoading={isAsanaConnected && asanaConnection.isPending}
        description={
          <>
            Store the workspace Asana access token for Roomote tasks. Secrets
            stay encrypted server-side.
          </>
        }
        onSubmit={handleAsanaSubmit}
      >
        <AsanaConnectionFields
          form={asanaForm}
          fieldErrors={asanaFieldErrors}
          formError={asanaFormError}
          allowBlankToken={isAsanaConnected}
          onFieldChange={handleAsanaFieldChange}
        />
      </AdminConfiguredIntegrationDialog>
      <AdminConfiguredIntegrationDialog
        integrationName="Snowflake"
        open={isSnowflakeDialogOpen}
        onOpenChange={handleSnowflakeDialogOpenChange}
        isEditing={isSnowflakeConnected}
        isPending={saveSnowflakeConnection.isPending}
        isLoading={isSnowflakeConnected && snowflakeConnection.isPending}
        description={
          <>
            Store the workspace Snowflake key pair for Roomote tasks. Secrets
            stay encrypted server-side.
          </>
        }
        onSubmit={handleSnowflakeSubmit}
      >
        <SnowflakeConnectionFields
          form={snowflakeForm}
          fieldErrors={snowflakeFieldErrors}
          formError={snowflakeFormError}
          allowBlankPrivateKey={allowsBlankSnowflakePrivateKey}
          onFieldChange={handleSnowflakeFieldChange}
        />
      </AdminConfiguredIntegrationDialog>
      <AdminConfiguredIntegrationDialog
        integrationName="Grafana"
        open={isGrafanaDialogOpen}
        onOpenChange={handleGrafanaDialogOpenChange}
        isEditing={isGrafanaConnected}
        isPending={saveGrafanaConnection.isPending}
        isLoading={isGrafanaConnected && grafanaConnection.isPending}
        description={
          <>
            Store the workspace Grafana URL and service account token for
            read-only Roomote tasks. Secrets stay encrypted server-side.
          </>
        }
        onSubmit={handleGrafanaSubmit}
      >
        <GrafanaConnectionFields
          form={grafanaForm}
          fieldErrors={grafanaFieldErrors}
          formError={grafanaFormError}
          allowBlankToken={isGrafanaConnected}
          onFieldChange={handleGrafanaFieldChange}
        />
      </AdminConfiguredIntegrationDialog>
      <AdminConfiguredIntegrationDialog
        integrationName="Vercel"
        open={isVercelDialogOpen}
        onOpenChange={handleVercelDialogOpenChange}
        isEditing={isVercelConnected}
        isPending={saveVercelConnection.isPending}
        isLoading={isVercelConnected && vercelConnection.isPending}
        description={
          <>
            Store the workspace Vercel access token for Roomote tasks. Secrets
            stay encrypted server-side.
          </>
        }
        onSubmit={handleVercelSubmit}
      >
        <VercelConnectionFields
          form={vercelForm}
          fieldErrors={vercelFieldErrors}
          formError={vercelFormError}
          allowBlankToken={isVercelConnected}
          onFieldChange={handleVercelFieldChange}
        />
      </AdminConfiguredIntegrationDialog>
      <DeepLinkEnableDialog
        item={deepLinkDialogItem}
        open={
          deepLinkDialogItem != null &&
          dismissedDeepLinkIntegrationId !== deepLinkDialogItem.id
        }
        onDismiss={clearDeepLinkHighlight}
        onEnable={() => {
          if (deepLinkDialogItem == null) {
            return;
          }

          dismissDeepLinkDialog();
          deepLinkDialogItem.onAction?.();
        }}
      />
      {hasEnabledMcpIntegration ? (
        <Alert variant="light">
          <Info />
          <AlertDescription>
            <p>
              User-linked MCP integrations appear in{' '}
              <Link
                href={SETTINGS_PATHS.personal}
                className="inline text-primary underline hover:no-underline"
              >
                personal settings.
              </Link>{' '}
              Workspace-scoped integrations connect and turn on from this page.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      <IntegrationSection
        id="installed-integrations"
        title="Enabled"
        items={installed}
      />
      <IntegrationSection
        id="available-integrations"
        title="Available"
        items={available}
      />
    </div>
  );
}
