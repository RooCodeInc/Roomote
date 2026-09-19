'use client';

import type { FormEvent, ReactNode } from 'react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { MCP_INTEGRATIONS } from '@roomote/types';

import {
  useAsanaConnection,
  useDisconnectMcp,
  useGranolaConnection,
  useNotionConnection,
  useRipplingConnection,
  useSaveAsanaConnection,
  useSaveGranolaConnection,
  useSaveNotionConnection,
  useSaveRipplingConnection,
  useSaveXConnection,
  useSaveStripeConnection,
  useStripeConnection,
  useXConnection,
  type useEffectiveMcpIntegrations,
} from '@/hooks/mcp-connections';
import {
  saveAsanaConnectionSchema,
  saveGranolaConnectionSchema,
  saveNotionConnectionSchema,
  saveRipplingConnectionSchema,
  saveXConnectionSchema,
  saveStripeConnectionSchema,
} from '@/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Pencil,
  Spinner,
  Wrench,
} from '@/components/system';
import type { IntegrationItem } from './integration-card';
import { McpIcon } from './McpIcon';

type McpIntegrationDefinition = (typeof MCP_INTEGRATIONS)[number];
type EffectiveIntegration = NonNullable<
  ReturnType<typeof useEffectiveMcpIntegrations>['data']
>[number];
type CredentialIntegrationId =
  | 'asana'
  | 'notion'
  | 'rippling'
  | 'granola'
  | 'stripe'
  | 'x';

type CredentialConnection = {
  data?: { authStatus?: string | null } | null;
  isPending: boolean;
};

type CredentialMutation<Input> = {
  isPending: boolean;
  mutate: (
    input: Input,
    options: {
      onSuccess: () => void;
      onError: (error: { message: string }) => void;
    },
  ) => void;
};

function useAsanaCredentialMutation(): CredentialMutation<{
  accessToken: string;
}> {
  const mutation = useSaveAsanaConnection();
  return {
    isPending: mutation.isPending,
    mutate: (input, options) =>
      mutation.mutate(input, {
        onSuccess: options.onSuccess,
        onError: options.onError,
      }),
  };
}

function useNotionCredentialMutation(): CredentialMutation<{
  internalIntegrationSecret: string;
}> {
  const mutation = useSaveNotionConnection();
  return {
    isPending: mutation.isPending,
    mutate: (input, options) =>
      mutation.mutate(input, {
        onSuccess: options.onSuccess,
        onError: options.onError,
      }),
  };
}

function useRipplingCredentialMutation(): CredentialMutation<{
  apiToken: string;
}> {
  const mutation = useSaveRipplingConnection();
  return {
    isPending: mutation.isPending,
    mutate: (input, options) =>
      mutation.mutate(input, {
        onSuccess: options.onSuccess,
        onError: options.onError,
      }),
  };
}

function useGranolaCredentialMutation(): CredentialMutation<{
  apiKey: string;
}> {
  const mutation = useSaveGranolaConnection();
  return {
    isPending: mutation.isPending,
    mutate: (input, options) =>
      mutation.mutate(input, {
        onSuccess: options.onSuccess,
        onError: options.onError,
      }),
  };
}

function useXCredentialMutation(): CredentialMutation<{
  bearerToken: string;
}> {
  const mutation = useSaveXConnection();
  return {
    isPending: mutation.isPending,
    mutate: (input, options) =>
      mutation.mutate(input, {
        onSuccess: options.onSuccess,
        onError: options.onError,
      }),
  };
}

function useStripeCredentialMutation(): CredentialMutation<{
  apiKey: string;
}> {
  const mutation = useSaveStripeConnection();
  return {
    isPending: mutation.isPending,
    mutate: (input, options) =>
      mutation.mutate(input, {
        onSuccess: options.onSuccess,
        onError: options.onError,
      }),
  };
}

type CredentialDefinition<Input> = {
  id: CredentialIntegrationId;
  fieldId: string;
  fieldLabel: string;
  inputType?: 'text' | 'password';
  fieldPlaceholder?: string;
  help: ReactNode;
  blankHelp: string;
  dialogDescription: ReactNode;
  requiredMessage: string;
  connectedMessage: string;
  updatedMessage: string;
  canManageTools: boolean;
  requireConnectionAuthentication?: boolean;
  parse: (
    secret: string,
  ) => { success: true; data: Input } | { success: false; errors?: string[] };
  getCredential: (input: Input) => string;
};

type CredentialRuntime = {
  id: CredentialIntegrationId;
  item: IntegrationItem;
  dialog: ReactNode;
};

type AdminConfiguredIntegrationItemOptions = {
  integration: McpIntegrationDefinition;
  connection?: { authStatus?: string | null };
  orgEnabled: boolean;
  status?: string;
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

export function buildAdminConfiguredIntegrationItem({
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
  status,
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
    status,
    configureAction: canConfigure
      ? {
          label: 'Configure',
          ariaLabel: `Configure ${integration.name}`,
          onAction: openDialog,
          isPending: isPending || (dialogOpen && connectionPending),
          icon: <Pencil />,
        }
      : null,
    manageToolsAction:
      canManageTools &&
      enabled &&
      integration.serverMode !== 'native' &&
      integration.serverMode !== 'credential_only'
        ? {
            label: 'Manage available tools',
            ariaLabel: `Manage ${integration.name} tools`,
            onAction: openToolDialog,
            isPending: false,
            icon: <Wrench />,
          }
        : undefined,
    removeAction:
      canConfigure && enabled
        ? {
            label: 'Remove',
            ariaLabel: `Remove ${integration.name}`,
            onAction: disconnectIntegration,
            isPending,
          }
        : undefined,
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
      canManageTools &&
      enabled &&
      integration.serverMode !== 'native' &&
      integration.serverMode !== 'credential_only'
        ? {
            label: 'Manage tools',
            ariaLabel: `Manage ${integration.name} tools`,
            onAction: openToolDialog,
            isPending: false,
            icon: <Wrench className="size-4" />,
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

function AdminConfiguredIntegrationDialog({
  integrationName,
  open,
  onOpenChange,
  isEditing,
  isPending,
  isLoading,
  description,
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
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? 'Edit' : 'Connect'} {integrationName}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner size="sm" />
            Loading connection settings...
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
                {isEditing ? 'Save changes' : `Connect ${integrationName}`}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SecretField({
  definition,
  value,
  errors,
  formError,
  allowBlank,
  onChange,
}: {
  definition: CredentialDefinition<unknown>;
  value: string;
  errors?: string[];
  formError: string | null;
  allowBlank: boolean;
  onChange: (value: string) => void;
}) {
  const hasError = Boolean(errors?.length);

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={definition.fieldId}>{definition.fieldLabel}</Label>
        <Input
          id={definition.fieldId}
          type={definition.inputType ?? 'password'}
          placeholder={definition.fieldPlaceholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={hasError || undefined}
          aria-describedby={
            hasError ? `${definition.fieldId}-error` : undefined
          }
          data-invalid={hasError ? 'true' : undefined}
          className="mt-2 w-full border-border/70 bg-background data-[invalid=true]:border-destructive"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
        />
        {definition.help}
        {allowBlank ? (
          <p className="text-sm text-muted-foreground">
            {definition.blankHelp}
          </p>
        ) : null}
        {errors?.length ? (
          <p
            id={`${definition.fieldId}-error`}
            className="text-sm text-destructive"
            role="alert"
          >
            {errors[0]}
          </p>
        ) : null}
      </div>
      {formError ? (
        <p className="text-sm text-destructive">{formError}</p>
      ) : null}
    </>
  );
}

function useCredentialIntegration<Input>({
  definition,
  integration,
  summary,
  orgEnabled,
  highlightedIntegrationId,
  isAdmin,
  disconnectPending,
  disconnectingMcpId,
  useConnection,
  useSave,
  openToolDialog,
  disconnectIntegration,
}: {
  definition: CredentialDefinition<Input>;
  integration: McpIntegrationDefinition;
  summary?: EffectiveIntegration;
  orgEnabled: boolean;
  highlightedIntegrationId: string;
  isAdmin: boolean;
  disconnectPending: boolean;
  disconnectingMcpId?: string;
  useConnection: (enabled: boolean) => CredentialConnection;
  useSave: () => CredentialMutation<Input>;
  openToolDialog: () => void;
  disconnectIntegration: () => void;
}): CredentialRuntime {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState('');
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const summaryConnected = summary?.authStatus === 'authenticated';
  const connection = useConnection(isAdmin && (summaryConnected || open));
  const save = useSave();
  const isConnected =
    summaryConnected &&
    (!definition.requireConnectionAuthentication ||
      connection.data?.authStatus === 'authenticated');

  useEffect(() => {
    if (!open || (connection.isPending && isConnected)) {
      return;
    }

    setSecret('');
    setFieldErrors([]);
    setFormError(null);
  }, [connection.isPending, isConnected, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setFieldErrors([]);
    setFormError(null);

    if (nextOpen) {
      setSecret('');
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = definition.parse(secret);

    if (!parsed.success) {
      setFieldErrors(parsed.errors ?? []);
      return;
    }

    if (!isConnected && definition.getCredential(parsed.data).length === 0) {
      setFieldErrors([definition.requiredMessage]);
      return;
    }

    setFieldErrors([]);
    setFormError(null);
    save.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(
          isConnected ? definition.updatedMessage : definition.connectedMessage,
        );
        handleOpenChange(false);
      },
      onError: (error) => setFormError(error.message),
    });
  };

  return {
    id: definition.id,
    item: buildAdminConfiguredIntegrationItem({
      integration,
      connection: summary,
      orgEnabled,
      highlightedIntegrationId,
      savePending: save.isPending,
      disconnectPending,
      disconnectingMcpId,
      dialogOpen: open,
      connectionPending: connection.isPending,
      canConfigure: isAdmin,
      canManageTools: isAdmin && definition.canManageTools,
      openDialog: () => setOpen(true),
      openToolDialog,
      disconnectIntegration,
    }),
    dialog: (
      <AdminConfiguredIntegrationDialog
        integrationName={integration.name}
        open={open}
        onOpenChange={handleOpenChange}
        isEditing={isConnected}
        isPending={save.isPending}
        isLoading={isConnected && connection.isPending}
        description={definition.dialogDescription}
        onSubmit={handleSubmit}
      >
        <SecretField
          definition={definition as CredentialDefinition<unknown>}
          value={secret}
          errors={fieldErrors}
          formError={formError}
          allowBlank={isConnected}
          onChange={(value) => {
            setSecret(value);
            setFieldErrors([]);
            setFormError(null);
          }}
        />
      </AdminConfiguredIntegrationDialog>
    ),
  };
}

const credentialDefinitions = {
  asana: {
    id: 'asana',
    fieldId: 'asana-access-token',
    fieldLabel: 'Asana Access Token',
    inputType: 'text',
    fieldPlaceholder: '0/1234567890abcdef...',
    help: (
      <p className="text-sm text-muted-foreground">
        Works with both Personal Access Tokens and Service Account tokens.
        Generate a PAT in Asana at{' '}
        <a
          href="https://app.asana.com/0/my-apps"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline hover:no-underline"
        >
          app.asana.com/0/my-apps
        </a>
        .
      </p>
    ),
    blankHelp: 'Leave blank to keep the existing token.',
    dialogDescription:
      'Store the workspace Asana access token for Roomote tasks. Secrets stay encrypted server-side.',
    requiredMessage: 'Access token is required',
    connectedMessage: 'Asana connected for this deployment.',
    updatedMessage: 'Asana connection updated for this deployment.',
    canManageTools: true,
    getCredential: (input) => input.accessToken ?? '',
    parse: (secret: string) => {
      const result = saveAsanaConnectionSchema.safeParse({
        accessToken: secret,
      });
      return result.success
        ? ({ success: true, data: result.data } as const)
        : ({
            success: false,
            errors: result.error.flatten().fieldErrors.accessToken,
          } as const);
    },
  },
  notion: {
    id: 'notion',
    fieldId: 'notion-internal-integration-secret',
    fieldLabel: 'Internal integration secret',
    fieldPlaceholder: 'ntn_...',
    help: (
      <p className="text-sm text-muted-foreground">
        Create an internal integration in{' '}
        <a
          href="https://www.notion.so/profile/integrations/internal"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline hover:no-underline"
        >
          Notion integrations
        </a>
        . In Notion, choose its read, update, insert, and comment capabilities,
        then share only the approved pages or data sources with it. Roomote
        cannot access anything that has not been shared with this connection.
      </p>
    ),
    blankHelp: 'Leave blank to keep the existing secret.',
    dialogDescription: (
      <>
        Store a Notion internal integration secret for this deployment. Notion
        controls the connection&apos;s capabilities and limits it to pages and
        data sources explicitly shared with that integration; the secret stays
        encrypted server-side.
      </>
    ),
    requiredMessage: 'Internal integration secret is required',
    connectedMessage: 'Notion connected for this deployment.',
    updatedMessage: 'Notion connection updated for this deployment.',
    canManageTools: false,
    requireConnectionAuthentication: true,
    getCredential: (input) => input.internalIntegrationSecret ?? '',
    parse: (secret: string) => {
      const result = saveNotionConnectionSchema.safeParse({
        internalIntegrationSecret: secret,
      });
      return result.success
        ? ({ success: true, data: result.data } as const)
        : ({
            success: false,
            errors:
              result.error.flatten().fieldErrors.internalIntegrationSecret,
          } as const);
    },
  },
  rippling: {
    id: 'rippling',
    fieldId: 'rippling-api-token',
    fieldLabel: 'API token',
    help: (
      <p className="text-sm text-muted-foreground">
        Create a company-wide token in Rippling&apos;s API Tokens app with
        workers.read and the user, department, team, employment type, and work
        location read scopes needed for the roster. Roomote validates the token
        before storing it.
      </p>
    ),
    blankHelp: 'Leave blank to keep and revalidate the existing token.',
    dialogDescription: (
      <>
        Connect Rippling&apos;s read-only HRIS API so Memory can maintain the
        employee roster and authoritative reporting structure. The token stays
        encrypted on the control plane and is never sent to agents.
      </>
    ),
    requiredMessage: 'API token is required',
    connectedMessage: 'Rippling connected for this deployment.',
    updatedMessage: 'Rippling connection updated for this deployment.',
    canManageTools: false,
    requireConnectionAuthentication: true,
    getCredential: (input) => input.apiToken ?? '',
    parse: (secret: string) => {
      const result = saveRipplingConnectionSchema.safeParse({
        apiToken: secret,
      });
      return result.success
        ? ({ success: true, data: result.data } as const)
        : ({
            success: false,
            errors: result.error.flatten().fieldErrors.apiToken,
          } as const);
    },
  },
  granola: {
    id: 'granola',
    fieldId: 'granola-api-key',
    fieldLabel: 'Granola API Key',
    fieldPlaceholder: 'Enter your Granola API key',
    help: (
      <>
        <p className="text-sm text-muted-foreground">
          We strongly recommend a Granola workspace API key. Workspace keys can
          read public notes and spaces where &quot;Allow Granola API
          access&quot; is enabled. New spaces enable API access by default, so
          admins should review space settings before connecting.
        </p>
        <p className="text-sm text-muted-foreground">
          You can also use a personal API key with Public notes selected and
          Personal notes left unchecked.
        </p>
      </>
    ),
    blankHelp: 'Leave blank to keep the existing API key.',
    dialogDescription:
      'Store a Granola API key for this deployment. The secret stays encrypted server-side.',
    requiredMessage: 'API key is required',
    connectedMessage: 'Granola connected for this deployment.',
    updatedMessage: 'Granola connection updated for this deployment.',
    canManageTools: true,
    getCredential: (input) => input.apiKey ?? '',
    parse: (secret: string) => {
      const result = saveGranolaConnectionSchema.safeParse({ apiKey: secret });
      return result.success
        ? ({ success: true, data: result.data } as const)
        : ({
            success: false,
            errors: result.error.flatten().fieldErrors.apiKey,
          } as const);
    },
  },
  x: {
    id: 'x',
    fieldId: 'x-bearer-token',
    fieldLabel: 'X App-only Bearer Token',
    fieldPlaceholder: 'AAAAAAAAAAAAAAAAAAAAA...',
    help: (
      <p className="text-sm text-muted-foreground">
        Generate it at{' '}
        <a
          href="https://console.x.com/"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline hover:no-underline"
        >
          console.x.com
        </a>{' '}
        under Apps, in your app&apos;s Keys and tokens tab. App-only bearer
        tokens give read-only access to public X data; posting and other account
        actions stay unavailable. Access depends on your X API plan.
      </p>
    ),
    blankHelp: 'Leave blank to keep the existing token.',
    dialogDescription:
      'Store the workspace X app-only bearer token for read-only Roomote tasks. Secrets stay encrypted server-side.',
    requiredMessage: 'Bearer token is required',
    connectedMessage: 'X connected for this deployment.',
    updatedMessage: 'X connection updated for this deployment.',
    canManageTools: true,
    getCredential: (input) => input.bearerToken ?? '',
    parse: (secret: string) => {
      const result = saveXConnectionSchema.safeParse({ bearerToken: secret });
      return result.success
        ? ({ success: true, data: result.data } as const)
        : ({
            success: false,
            errors: result.error.flatten().fieldErrors.bearerToken,
          } as const);
    },
  },
  stripe: {
    id: 'stripe',
    fieldId: 'stripe-restricted-api-key',
    fieldLabel: 'Stripe Restricted API Key',
    fieldPlaceholder: 'rk_...',
    help: (
      <p className="text-sm text-muted-foreground">
        Create a restricted key in the{' '}
        <a
          href="https://dashboard.stripe.com/apikeys"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline hover:no-underline"
        >
          Stripe Dashboard
        </a>{' '}
        with only the read permissions Roomote needs. Start with a sandbox or
        test-mode key before connecting live data.
      </p>
    ),
    blankHelp: 'Leave blank to keep the existing restricted key.',
    dialogDescription:
      'Store a deployment-wide Stripe restricted API key. The key stays encrypted server-side and the general Stripe write tool starts disabled.',
    requiredMessage: 'Restricted API key is required',
    connectedMessage: 'Stripe connected for this deployment.',
    updatedMessage: 'Stripe connection updated for this deployment.',
    canManageTools: true,
    getCredential: (input) => input.apiKey ?? '',
    parse: (secret: string) => {
      const result = saveStripeConnectionSchema.safeParse({ apiKey: secret });
      return result.success
        ? ({ success: true, data: result.data } as const)
        : ({
            success: false,
            errors: result.error.flatten().fieldErrors.apiKey,
          } as const);
    },
  },
} satisfies {
  [Id in CredentialIntegrationId]: CredentialDefinition<Record<string, string>>;
};

export function useCredentialIntegrations({
  effectiveIntegrations,
  highlightedIntegrationId,
  isAdmin,
  openToolDialog,
}: {
  effectiveIntegrations: readonly EffectiveIntegration[];
  highlightedIntegrationId: string;
  isAdmin: boolean;
  openToolDialog: (integration: McpIntegrationDefinition) => void;
}): {
  itemsById: ReadonlyMap<string, IntegrationItem>;
  dialogs: ReactNode;
} {
  const disconnectMcp = useDisconnectMcp();
  const integrationsById = useMemo(
    () =>
      new Map(
        MCP_INTEGRATIONS.map((integration) => [integration.id, integration]),
      ),
    [],
  );
  const effectiveById = useMemo(
    () => new Map(effectiveIntegrations.map((entry) => [entry.id, entry])),
    [effectiveIntegrations],
  );

  const buildRuntimeOptions = (id: CredentialIntegrationId) => {
    const integration = integrationsById.get(id);
    if (!integration) {
      throw new Error(`Missing MCP integration definition for ${id}`);
    }

    return {
      integration,
      summary: effectiveById.get(id),
      orgEnabled: effectiveById.get(id)?.enabled ?? false,
      highlightedIntegrationId,
      isAdmin,
      disconnectPending: disconnectMcp.isPending,
      disconnectingMcpId: disconnectMcp.variables?.mcpId,
      openToolDialog: () => openToolDialog(integration),
      disconnectIntegration: () =>
        disconnectMcp.mutate(
          { mcpId: id },
          {
            onSuccess: () => toast.success(`${integration.name} removed.`),
            onError: (error) =>
              toast.error(
                error instanceof Error
                  ? error.message
                  : `Failed to remove ${integration.name}.`,
              ),
          },
        ),
    };
  };

  const asana = useCredentialIntegration({
    ...buildRuntimeOptions('asana'),
    definition: credentialDefinitions.asana,
    useConnection: useAsanaConnection,
    useSave: useAsanaCredentialMutation,
  });
  const notion = useCredentialIntegration({
    ...buildRuntimeOptions('notion'),
    definition: credentialDefinitions.notion,
    useConnection: useNotionConnection,
    useSave: useNotionCredentialMutation,
  });
  const rippling = useCredentialIntegration({
    ...buildRuntimeOptions('rippling'),
    definition: credentialDefinitions.rippling,
    useConnection: useRipplingConnection,
    useSave: useRipplingCredentialMutation,
  });
  const granola = useCredentialIntegration({
    ...buildRuntimeOptions('granola'),
    definition: credentialDefinitions.granola,
    useConnection: useGranolaConnection,
    useSave: useGranolaCredentialMutation,
  });
  const x = useCredentialIntegration({
    ...buildRuntimeOptions('x'),
    definition: credentialDefinitions.x,
    useConnection: useXConnection,
    useSave: useXCredentialMutation,
  });
  const stripe = useCredentialIntegration({
    ...buildRuntimeOptions('stripe'),
    definition: credentialDefinitions.stripe,
    useConnection: useStripeConnection,
    useSave: useStripeCredentialMutation,
  });
  const runtimes = [asana, notion, rippling, granola, stripe, x];

  return {
    itemsById: new Map(runtimes.map((runtime) => [runtime.id, runtime.item])),
    dialogs: (
      <>
        {runtimes.map((runtime) => (
          <Fragment key={runtime.id}>{runtime.dialog}</Fragment>
        ))}
      </>
    ),
  };
}
