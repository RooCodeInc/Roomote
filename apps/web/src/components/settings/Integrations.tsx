'use client';

import type { FormEvent, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';

import {
  getMcpIntegrationConnectionMode,
  DEFAULT_OPENAI_REALTIME_VOICE_ID,
  isSelfServeMcpIntegration,
  isDeploymentScopedMcpIntegration,
  MCP_INTEGRATIONS,
  OPENAI_REALTIME_VOICE_OPTIONS,
  type OpenAiRealtimeVoiceId,
} from '@roomote/types';

import {
  useConnectLinear,
  useDisconnectLinear,
  useLinearInstallation,
  useLinearOauthSetup,
} from '@/hooks/linear';
import {
  useConnectMcp,
  useDisconnectMcp,
  useGrafanaConnection,
  useExaConnection,
  useElevenLabsConnection,
  useVoiceConnection,
  useEffectiveMcpIntegrations,
  useSaveGrafanaConnection,
  useSaveExaConnection,
  useRemoveExaApiKey,
  useSaveElevenLabsConnection,
  useSaveVoiceConnection,
  usePreviewVoice,
  useSaveSnowflakeConnection,
  useSaveVercelConnection,
  useSetDeploymentMcpEnabled,
  useSnowflakeConnection,
  useVercelConnection,
} from '@/hooks/mcp-connections';
import { useAuthorizedUser } from '@/hooks/useUser';
import {
  IntegrationListHeader,
  IntegrationListRow,
  IntegrationSection,
  type IntegrationItem,
} from './integration-card';
import { useCustomMcpServers } from './CustomMcpServers';
import { useYourIntegrations } from './YourIntegrations';
import {
  buildAdminConfiguredIntegrationItem,
  useCredentialIntegrations,
} from './CredentialIntegrations';
import {
  saveGrafanaConnectionSchema,
  saveExaConnectionSchema,
  saveElevenLabsConnectionSchema,
  saveVoiceConnectionSchema,
  saveSnowflakeConnectionSchema,
  saveVercelConnectionSchema,
} from '@/types';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  BasicTooltip,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  LinearLogo,
  Pencil,
  Plus,
  Play,
  RefreshCw,
  Settings2,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Skeleton,
  Spinner,
  Textarea,
  Trash2,
  TriangleAlert,
  Wrench,
} from '@/components/system';
import { McpToolManagementDialog } from './McpToolManagementDialog';
import { McpIcon } from './McpIcon';
import { LinearOauthSetupDialog } from './LinearOauthSetupDialog';

const DEEP_LINK_ENABLE_DESCRIPTIONS: Record<string, string> = {
  asana:
    'Roomote will be able to inspect workspaces, projects, tasks, teams, and task comments.',
  betterstack:
    'Roomote will be able to inspect monitoring, incidents, and telemetry.',
  braintrust:
    'Roomote will be able to inspect prompts, evaluations, and AI run history.',
  grafana:
    'Roomote will be able to inspect dashboards, alert rules, live alert state, annotations, and data sources.',
  granola:
    'Roomote will use one deployment-wide Granola connection to browse meeting notes, transcripts, decisions, and action items.',
  exa: 'Roomote will enable Exa with free keyless web search and page fetching. You can add a deployment API key separately for authenticated access and Exa Agent.',
  elevenlabs:
    'Roomote will use one deployment-wide ElevenLabs connection to narrate feature-demo videos. The key stays on the control plane; agents get no ElevenLabs tools.',
  voice:
    'Roomote will use one deployment-wide OpenAI key with GPT-Live access to hold voice calls on Sessions. The key stays on the control plane; agents get no tools from it.',
  github:
    'Roomote will be able to inspect PRs, issues, and repository context.',
  jira: 'Roomote will be able to inspect Jira issues, workflows, and JQL search results.',
  linear:
    'Roomote will be able to pull issue, project, and roadmap context into tasks.',
  monday:
    'Roomote will be able to inspect monday.com boards, items, updates, docs, and workspace context.',
  neon: 'Roomote will get database access to inspect schemas and query data.',
  notion:
    'Roomote will use one deployment-wide Notion internal integration. Notion controls its capabilities and which pages and data sources it can access.',
  rippling:
    "Roomote will keep Memory's employee directory and reporting structure current from one deployment-wide Rippling connection.",
  pylon:
    'Roomote will be able to inspect customer issues, message history, and account context.',
  posthog:
    'Roomote will be able to inspect analytics, feature flags, and experiments.',
  railway:
    'Roomote will be able to inspect Railway account, project, and service inventory.',
  resend:
    'Roomote will be able to inspect and manage shared email infrastructure. Sending, credential creation, automation triggers, and contact mutations start disabled.',
  sentry:
    'Roomote will be able to inspect Sentry issue context and run scheduled Sentry triage through MCP.',
  supabase: 'Roomote will get read-only database access and platform context.',
  supermemory:
    'Roomote will be able to save shared memories and recall context from earlier tasks.',
  vercel:
    'Roomote will be able to inspect Vercel teams, projects, deployments, logs, and domain availability.',
  x: 'Roomote will be able to search public X posts and look up users, trends, and news. The app-only token is read-only; posting and other account actions stay unavailable.',
  zero: 'Roomote will be able to authenticate the workspace Zero connection so agents can discover and pay for external capabilities.',
};

type OauthReadinessStatus = 'ready' | 'missing' | 'partial';

type McpIntegrationDefinition = (typeof MCP_INTEGRATIONS)[number];

function getLinearOauthSetupStatus(
  status: Exclude<OauthReadinessStatus, 'ready'>,
  isAdmin: boolean,
): ReactNode {
  if (!isAdmin) {
    return 'Not configured. Ask an administrator to set it up.';
  }

  return status === 'partial' ? 'Configuration incomplete.' : null;
}

type SnowflakeFormState = {
  account: string;
  username: string;
  privateKey: string;
  privateKeyPassphrase: string;
  role: string;
};

type SnowflakeConnectionData = {
  authStatus?: 'pending' | 'authenticated' | 'error' | null;
  account: string;
  username: string;
  role: string;
};

type ExaFormState = {
  apiKey: string;
};

type ElevenLabsFormState = {
  apiKey: string;
  voiceId: string;
};

type ElevenLabsConnectionData = {
  authStatus?: 'pending' | 'authenticated' | 'error' | null;
  voiceId?: string;
};

type VoiceFormState = {
  apiKey: string;
  voiceId: OpenAiRealtimeVoiceId;
};

type VoiceConnectionData = {
  authStatus?: 'pending' | 'authenticated' | 'error' | null;
  voiceId?: OpenAiRealtimeVoiceId;
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

function buildEmptyExaForm(): ExaFormState {
  return {
    apiKey: '',
  };
}

function buildEmptyVoiceForm(): VoiceFormState {
  return { apiKey: '', voiceId: DEFAULT_OPENAI_REALTIME_VOICE_ID };
}

function buildVoiceForm(
  connection: VoiceConnectionData | null | undefined,
): VoiceFormState {
  return {
    apiKey: '',
    voiceId: connection?.voiceId ?? DEFAULT_OPENAI_REALTIME_VOICE_ID,
  };
}

function buildEmptyElevenLabsForm(): ElevenLabsFormState {
  return {
    apiKey: '',
    voiceId: '',
  };
}

function buildElevenLabsForm(
  connection: ElevenLabsConnectionData | null | undefined,
): ElevenLabsFormState {
  if (!connection) {
    return buildEmptyElevenLabsForm();
  }

  return {
    apiKey: '',
    voiceId: connection.voiceId ?? '',
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

function getExaFieldErrors(
  result: ReturnType<typeof saveExaConnectionSchema.safeParse>,
): Partial<Record<keyof ExaFormState, string[]>> {
  if (result.success) {
    return {};
  }

  return {
    apiKey: result.error.flatten().fieldErrors.apiKey,
  };
}

function getVoiceFieldErrors(
  result: ReturnType<typeof saveVoiceConnectionSchema.safeParse>,
): Partial<Record<keyof VoiceFormState, string[]>> {
  if (result.success) {
    return {};
  }

  const fieldErrors = result.error.flatten().fieldErrors;
  return { apiKey: fieldErrors.apiKey, voiceId: fieldErrors.voiceId };
}

function getElevenLabsFieldErrors(
  result: ReturnType<typeof saveElevenLabsConnectionSchema.safeParse>,
): Partial<Record<keyof ElevenLabsFormState, string[]>> {
  if (result.success) {
    return {};
  }

  const fieldErrors = result.error.flatten().fieldErrors;

  return {
    apiKey: fieldErrors.apiKey,
    voiceId: fieldErrors.voiceId,
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
  title,
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
  title?: string;
  submitLabel?: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const dialogTitle =
    title ?? `${isEditing ? 'Edit' : 'Connect'} ${integrationName}`;
  const resolvedLoadingMessage =
    loadingMessage ?? 'Loading connection settings...';
  const resolvedSubmitLabel =
    submitLabel ?? (isEditing ? 'Save changes' : `Connect ${integrationName}`);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
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

function getFieldErrorAttributes(fieldId: string, errors?: string[]) {
  const hasError = Boolean(errors?.length);

  return {
    'aria-invalid': hasError || undefined,
    'aria-describedby': hasError ? `${fieldId}-error` : undefined,
    'data-invalid': hasError ? 'true' : undefined,
  } as const;
}

function FieldError({
  fieldId,
  errors,
}: {
  fieldId: string;
  errors?: string[];
}) {
  if (!errors?.length) {
    return null;
  }

  return (
    <p
      id={`${fieldId}-error`}
      className="text-sm text-destructive"
      role="alert"
    >
      {errors[0]}
    </p>
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
              {...getFieldErrorAttributes(
                'snowflake-account',
                fieldErrors.account,
              )}
              className={fieldClassName}
              data-1p-ignore
            />
            <FieldError
              fieldId="snowflake-account"
              errors={fieldErrors.account}
            />
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
              {...getFieldErrorAttributes(
                'snowflake-username',
                fieldErrors.username,
              )}
              className={fieldClassName}
              data-1p-ignore
            />
            <FieldError
              fieldId="snowflake-username"
              errors={fieldErrors.username}
            />
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
              {...getFieldErrorAttributes(
                'snowflake-private-key',
                fieldErrors.privateKey,
              )}
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
            <FieldError
              fieldId="snowflake-private-key"
              errors={fieldErrors.privateKey}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="snowflake-private-key-passphrase">
              Private Key Passphrase (optional)
            </Label>
            <Input
              id="snowflake-private-key-passphrase"
              type="password"
              value={form.privateKeyPassphrase}
              onChange={(event) =>
                onFieldChange('privateKeyPassphrase', event.target.value)
              }
              {...getFieldErrorAttributes(
                'snowflake-private-key-passphrase',
                fieldErrors.privateKeyPassphrase,
              )}
              className={fieldClassName}
              data-1p-ignore
            />
            <p className="text-sm text-muted-foreground">
              Only needed if your private key is encrypted.
            </p>
            <FieldError
              fieldId="snowflake-private-key-passphrase"
              errors={fieldErrors.privateKeyPassphrase}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="snowflake-role">Role</Label>
            <Input
              id="snowflake-role"
              placeholder="ANALYST"
              value={form.role}
              onChange={(event) => onFieldChange('role', event.target.value)}
              {...getFieldErrorAttributes('snowflake-role', fieldErrors.role)}
              className={fieldClassName}
              data-1p-ignore
            />
            <FieldError fieldId="snowflake-role" errors={fieldErrors.role} />
          </div>
        </div>
      </div>
      {formError ? (
        <p className="text-sm text-destructive">{formError}</p>
      ) : null}
    </>
  );
}

function ApiKeyConnectionFields({
  fieldId,
  label,
  placeholder,
  form,
  fieldErrors,
  formError,
  allowBlankApiKey,
  help,
  onFieldChange,
}: {
  fieldId: string;
  label: string;
  placeholder: string;
  form: { apiKey: string };
  fieldErrors: { apiKey?: string[] };
  formError: string | null;
  allowBlankApiKey: boolean;
  help: ReactNode;
  onFieldChange: (field: 'apiKey', value: string) => void;
}) {
  const fieldClassName =
    'mt-2 w-full border-border/70 bg-background data-[invalid=true]:border-destructive';

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={fieldId}>{label}</Label>
        <Input
          id={fieldId}
          type="password"
          placeholder={placeholder}
          value={form.apiKey}
          onChange={(event) => onFieldChange('apiKey', event.target.value)}
          {...getFieldErrorAttributes(fieldId, fieldErrors.apiKey)}
          className={fieldClassName}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
        />
        {help}
        {allowBlankApiKey ? (
          <p className="text-sm text-muted-foreground">
            Leave blank to keep the existing API key.
          </p>
        ) : null}
        <FieldError fieldId={fieldId} errors={fieldErrors.apiKey} />
      </div>
      {formError ? (
        <p className="text-sm text-destructive">{formError}</p>
      ) : null}
    </>
  );
}

function ExaConnectionFields(
  props: Omit<
    Parameters<typeof ApiKeyConnectionFields>[0],
    'fieldId' | 'label' | 'placeholder' | 'help'
  >,
) {
  return (
    <ApiKeyConnectionFields
      {...props}
      fieldId="exa-api-key"
      label="Exa API Key"
      placeholder="Enter your Exa API key"
      help={
        <p className="text-sm text-muted-foreground">
          Create a key in the{' '}
          <a
            href="https://dashboard.exa.ai/api-keys"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline hover:no-underline"
          >
            Exa dashboard
          </a>
          . Roomote validates it against Exa before storing it. Exa Agent runs
          are usage-based. Without a key, enabled deployments use Exa&apos;s
          free keyless access, where Exa rate limits apply and Exa Agent is
          unavailable.
        </p>
      }
    />
  );
}

function VoiceConnectionFields({
  form,
  fieldErrors,
  formError,
  allowBlankApiKey,
  onFieldChange,
}: {
  form: VoiceFormState;
  fieldErrors: Partial<Record<keyof VoiceFormState, string[]>>;
  formError: string | null;
  allowBlankApiKey: boolean;
  onFieldChange: (field: keyof VoiceFormState, value: string) => void;
}) {
  const previewVoice = usePreviewVoice();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const selectedVoice = OPENAI_REALTIME_VOICE_OPTIONS.find(
    (option) => option.id === form.voiceId,
  );
  const fieldClassName =
    'mt-2 w-full border-border/70 bg-background data-[invalid=true]:border-destructive';

  useEffect(
    () => () => {
      audioRef.current?.pause();
    },
    [],
  );

  const handlePreview = () => {
    audioRef.current?.pause();
    setPreviewError(null);
    previewVoice.mutate(
      { apiKey: form.apiKey, voiceId: form.voiceId },
      {
        onSuccess: ({ audioBase64, mimeType }) => {
          const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
          audioRef.current = audio;
          void audio.play().catch(() => {
            setPreviewError('Your browser blocked audio playback. Try again.');
          });
        },
        onError: (error) => setPreviewError(error.message),
      },
    );
  };

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="voice-api-key">OpenAI API Key</Label>
        <Input
          id="voice-api-key"
          type="password"
          placeholder="Enter an OpenAI API key with GPT-Live access"
          value={form.apiKey}
          onChange={(event) => onFieldChange('apiKey', event.target.value)}
          {...getFieldErrorAttributes('voice-api-key', fieldErrors.apiKey)}
          className={fieldClassName}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
        />
        {allowBlankApiKey ? (
          <p className="text-sm text-muted-foreground">
            Leave blank to keep the existing API key.
          </p>
        ) : null}
        <FieldError fieldId="voice-api-key" errors={fieldErrors.apiKey} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="voice-selection">Voice</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select
            value={form.voiceId}
            onValueChange={(value) =>
              onFieldChange('voiceId', value as OpenAiRealtimeVoiceId)
            }
          >
            <SelectTrigger
              id="voice-selection"
              className="w-full sm:flex-1"
              {...getFieldErrorAttributes(
                'voice-selection',
                fieldErrors.voiceId,
              )}
            >
              <span>{selectedVoice?.label ?? 'Select a voice'}</span>
            </SelectTrigger>
            <SelectContent>
              {OPENAI_REALTIME_VOICE_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                  {option.recommended ? (
                    <span
                      className="ml-2 text-xs text-muted-foreground"
                      aria-hidden="true"
                    >
                      Recommended
                    </span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            onClick={handlePreview}
            disabled={previewVoice.isPending}
            aria-label={`Preview ${selectedVoice?.label ?? form.voiceId} voice`}
            className="w-full sm:w-auto"
          >
            {previewVoice.isPending ? <Spinner /> : <Play />}
            Preview
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Hear an AI-generated sample. OpenAI currently recommends Marin and
          Cedar for best quality.
        </p>
        <FieldError fieldId="voice-selection" errors={fieldErrors.voiceId} />
        {previewError ? (
          <p
            className="text-sm text-destructive"
            role="status"
            aria-live="polite"
          >
            {previewError}
          </p>
        ) : null}
      </div>
      {formError ? (
        <p className="text-sm text-destructive">{formError}</p>
      ) : null}
    </>
  );
}

function ElevenLabsConnectionFields({
  form,
  fieldErrors,
  formError,
  allowBlankApiKey,
  onFieldChange,
}: {
  form: ElevenLabsFormState;
  fieldErrors: Partial<Record<keyof ElevenLabsFormState, string[]>>;
  formError: string | null;
  allowBlankApiKey: boolean;
  onFieldChange: (field: keyof ElevenLabsFormState, value: string) => void;
}) {
  const fieldClassName =
    'mt-2 w-full border-border/70 bg-background data-[invalid=true]:border-destructive';

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="elevenlabs-api-key">ElevenLabs API Key</Label>
        <Input
          id="elevenlabs-api-key"
          type="password"
          placeholder="Enter your ElevenLabs API key"
          value={form.apiKey}
          onChange={(event) => onFieldChange('apiKey', event.target.value)}
          {...getFieldErrorAttributes('elevenlabs-api-key', fieldErrors.apiKey)}
          className={fieldClassName}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
        />
        <p className="text-sm text-muted-foreground">
          We recommend a key scoped to text-to-speech only, with a credit limit.
          The key is used exclusively by this deployment&apos;s control plane to
          narrate feature-demo videos; it is never sent to agents or task
          sandboxes.
        </p>
        {allowBlankApiKey ? (
          <p className="text-sm text-muted-foreground">
            Leave blank to keep the existing API key.
          </p>
        ) : null}
        <FieldError fieldId="elevenlabs-api-key" errors={fieldErrors.apiKey} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="elevenlabs-voice-id">Voice ID</Label>
        <Input
          id="elevenlabs-voice-id"
          placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
          value={form.voiceId}
          onChange={(event) => onFieldChange('voiceId', event.target.value)}
          {...getFieldErrorAttributes(
            'elevenlabs-voice-id',
            fieldErrors.voiceId,
          )}
          className={fieldClassName}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <p className="text-sm text-muted-foreground">
          The ElevenLabs voice used for narration. Find voice IDs in the
          ElevenLabs voice library.
        </p>
        <FieldError
          fieldId="elevenlabs-voice-id"
          errors={fieldErrors.voiceId}
        />
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
            {...getFieldErrorAttributes(
              'grafana-base-url',
              fieldErrors.baseUrl,
            )}
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
          <FieldError fieldId="grafana-base-url" errors={fieldErrors.baseUrl} />
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
            {...getFieldErrorAttributes(
              'grafana-service-account-token',
              fieldErrors.serviceAccountToken,
            )}
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
          <FieldError
            fieldId="grafana-service-account-token"
            errors={fieldErrors.serviceAccountToken}
          />
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
            {...getFieldErrorAttributes(
              'vercel-access-token',
              fieldErrors.accessToken,
            )}
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
          <FieldError
            fieldId="vercel-access-token"
            errors={fieldErrors.accessToken}
          />
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
            {...getFieldErrorAttributes(
              'vercel-default-team',
              fieldErrors.defaultTeamIdOrSlug,
            )}
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
          <FieldError
            fieldId="vercel-default-team"
            errors={fieldErrors.defaultTeamIdOrSlug}
          />
        </div>
      </div>
      {formError ? (
        <p className="text-sm text-destructive">{formError}</p>
      ) : null}
    </>
  );
}

export function Integrations({
  integrationIds,
  configurationRequest,
  addRequest,
  showCatalog = true,
}: {
  integrationIds?: readonly string[];
  configurationRequest?: {
    integrationId: string;
    sequence: number;
  } | null;
  addRequest?: {
    type: 'catalog' | 'custom-mcp' | 'api-key';
    sequence: number;
  } | null;
  showCatalog?: boolean;
} = {}) {
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
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);
  const [configurationInfoItem, setConfigurationInfoItem] =
    useState<IntegrationItem | null>(null);
  const highlightedIntegrationId =
    clearedDeepLinkIntegrationId === deepLinkedIntegrationId
      ? ''
      : deepLinkedIntegrationId;
  const [isVoiceDialogOpen, setIsVoiceDialogOpen] = useState(false);
  const [voiceForm, setVoiceForm] = useState<VoiceFormState>(
    buildEmptyVoiceForm(),
  );
  const [voiceFieldErrors, setVoiceFieldErrors] = useState<
    Partial<Record<keyof VoiceFormState, string[]>>
  >({});
  const [voiceFormError, setVoiceFormError] = useState<string | null>(null);
  const [isElevenLabsDialogOpen, setIsElevenLabsDialogOpen] = useState(false);
  const [elevenLabsForm, setElevenLabsForm] = useState<ElevenLabsFormState>(
    buildEmptyElevenLabsForm(),
  );
  const [elevenLabsFieldErrors, setElevenLabsFieldErrors] = useState<
    Partial<Record<keyof ElevenLabsFormState, string[]>>
  >({});
  const [elevenLabsFormError, setElevenLabsFormError] = useState<string | null>(
    null,
  );
  const [isExaDialogOpen, setIsExaDialogOpen] = useState(false);
  const [exaForm, setExaForm] = useState<ExaFormState>(buildEmptyExaForm());
  const [exaFieldErrors, setExaFieldErrors] = useState<
    Partial<Record<keyof ExaFormState, string[]>>
  >({});
  const [exaFormError, setExaFormError] = useState<string | null>(null);
  const [isRemoveExaApiKeyDialogOpen, setIsRemoveExaApiKeyDialogOpen] =
    useState(false);
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
  const [isLinearOauthSetupOpen, setIsLinearOauthSetupOpen] = useState(false);

  const linearInstallation = useLinearInstallation();
  const connectLinear = useConnectLinear(
    integrationIds === undefined ? `${pathname}?service=linear` : pathname,
  );
  const disconnectLinear = useDisconnectLinear();

  const effectiveIntegrations = useEffectiveMcpIntegrations();
  const linearOauthStatus = effectiveIntegrations.data?.find(
    (entry) => entry.id === 'linear',
  )?.oauthReadiness;
  const linearOauthUnavailable =
    linearOauthStatus === 'missing' || linearOauthStatus === 'partial';
  const linearOauthSetup = useLinearOauthSetup(
    isAdmin && (linearOauthUnavailable || isLinearOauthSetupOpen),
  );
  const setDeploymentEnabled = useSetDeploymentMcpEnabled();
  const connectMcp = useConnectMcp();
  const disconnectMcp = useDisconnectMcp();
  const saveGrafanaConnection = useSaveGrafanaConnection();
  const saveExaConnection = useSaveExaConnection();
  const removeExaApiKey = useRemoveExaApiKey();
  const saveElevenLabsConnection = useSaveElevenLabsConnection();
  const saveVoiceConnection = useSaveVoiceConnection();
  const saveSnowflakeConnection = useSaveSnowflakeConnection();
  const saveVercelConnection = useSaveVercelConnection();
  const exaConnectionSummary = useMemo(
    () =>
      (effectiveIntegrations.data ?? []).find((entry) => entry.id === 'exa'),
    [effectiveIntegrations.data],
  );
  const isExaConnected = exaConnectionSummary?.authStatus === 'authenticated';
  const exaConnection = useExaConnection(
    isAdmin && (isExaConnected || isExaDialogOpen),
  );
  const voiceConnectionSummary = useMemo(
    () =>
      (effectiveIntegrations.data ?? []).find((entry) => entry.id === 'voice'),
    [effectiveIntegrations.data],
  );
  const isVoiceConnected =
    voiceConnectionSummary?.authStatus === 'authenticated';
  // Always read for admins: it also reports a key provided by the environment,
  // which has no connection row but should show the card as connected.
  const voiceConnection = useVoiceConnection(isAdmin);
  const voiceConfiguredByEnvironment =
    voiceConnection.data?.source === 'environment';
  const elevenLabsConnectionSummary = useMemo(() => {
    const connection = (effectiveIntegrations.data ?? []).find(
      (entry) => entry.id === 'elevenlabs',
    );

    return connection;
  }, [effectiveIntegrations.data]);
  const isElevenLabsConnected =
    elevenLabsConnectionSummary?.authStatus === 'authenticated';
  const elevenLabsConnection = useElevenLabsConnection(
    isAdmin && (isElevenLabsConnected || isElevenLabsDialogOpen),
  );
  const grafanaConnectionSummary = useMemo(() => {
    const connection = (effectiveIntegrations.data ?? []).find(
      (entry) => entry.id === 'grafana',
    );

    return connection;
  }, [effectiveIntegrations.data]);
  const isGrafanaConnected =
    grafanaConnectionSummary?.authStatus === 'authenticated';
  const grafanaConnection = useGrafanaConnection(
    isAdmin && (isGrafanaConnected || isGrafanaDialogOpen),
  );
  const snowflakeConnectionSummary = useMemo(() => {
    const connection = (effectiveIntegrations.data ?? []).find(
      (entry) => entry.id === 'snowflake',
    );

    return connection;
  }, [effectiveIntegrations.data]);
  const isSnowflakeConnected =
    snowflakeConnectionSummary?.authStatus === 'authenticated';
  const snowflakeConnection = useSnowflakeConnection(
    isAdmin && (isSnowflakeConnected || isSnowflakeDialogOpen),
  );
  const vercelConnectionSummary = useMemo(() => {
    const connection = (effectiveIntegrations.data ?? []).find(
      (entry) => entry.id === 'vercel',
    );

    return connection;
  }, [effectiveIntegrations.data]);
  const isVercelConnected =
    vercelConnectionSummary?.authStatus === 'authenticated';
  const vercelConnection = useVercelConnection(
    isAdmin && (isVercelConnected || isVercelDialogOpen),
  );

  useEffect(() => {
    if (!isExaDialogOpen) {
      return;
    }

    if (exaConnection.isPending && isExaConnected) {
      return;
    }

    setExaFieldErrors({});
    setExaFormError(null);
    setExaForm(buildEmptyExaForm());
  }, [exaConnection.isPending, isExaConnected, isExaDialogOpen]);

  useEffect(() => {
    if (!isVoiceDialogOpen) {
      return;
    }

    if (voiceConnection.isPending && isVoiceConnected) {
      return;
    }

    setVoiceFieldErrors({});
    setVoiceFormError(null);
    setVoiceForm(buildVoiceForm(voiceConnection.data));
  }, [
    voiceConnection.data,
    voiceConnection.isPending,
    isVoiceConnected,
    isVoiceDialogOpen,
  ]);

  useEffect(() => {
    if (!isElevenLabsDialogOpen) {
      return;
    }

    if (elevenLabsConnection.isPending && isElevenLabsConnected) {
      return;
    }

    setElevenLabsFieldErrors({});
    setElevenLabsFormError(null);
    setElevenLabsForm(buildElevenLabsForm(elevenLabsConnection.data));
  }, [
    elevenLabsConnection.data,
    elevenLabsConnection.isPending,
    isElevenLabsConnected,
    isElevenLabsDialogOpen,
  ]);

  useEffect(() => {
    if (!isElevenLabsDialogOpen) {
      return;
    }

    if (elevenLabsConnection.isPending && isElevenLabsConnected) {
      return;
    }

    setElevenLabsFieldErrors({});
    setElevenLabsFormError(null);
    setElevenLabsForm(buildElevenLabsForm(elevenLabsConnection.data));
  }, [
    elevenLabsConnection.data,
    elevenLabsConnection.isPending,
    isElevenLabsConnected,
    isElevenLabsDialogOpen,
  ]);

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

  const openMcpToolDialog = (integration: McpIntegrationDefinition) =>
    setToolDialogState({
      mcpId: integration.id,
      integrationName: integration.name,
    });
  const credentialIntegrations = useCredentialIntegrations({
    effectiveIntegrations: effectiveIntegrations.data ?? [],
    highlightedIntegrationId,
    isAdmin,
    openToolDialog: openMcpToolDialog,
  });
  const credentialItemsById = credentialIntegrations.itemsById;

  const items = useMemo<IntegrationItem[]>(() => {
    const visibleMcpIntegrations = MCP_INTEGRATIONS;
    const orgEnablementMap = new Map(
      (effectiveIntegrations.data ?? []).map((entry) => [
        entry.id,
        entry.enabled,
      ]),
    );
    const userConnectionMap = new Map(
      (effectiveIntegrations.data ?? []).map((entry) => [entry.id, entry]),
    );
    const canSetUpLinearOauth = isAdmin && linearOauthUnavailable;
    const canConfigureLinearOauth = isAdmin && !linearOauthUnavailable;
    const canReconnectLinear =
      isAdmin && Boolean(linearInstallation.data) && !linearOauthUnavailable;
    const startLinearConnection = () => {
      connectLinear.mutate(undefined, {
        onSuccess: (url) => {
          window.location.href = url;
        },
        onError: (error) =>
          toast.error(
            error instanceof Error
              ? error.message
              : 'Failed to enable Linear. Please try again.',
          ),
      });
    };
    const disconnectAdminConfiguredIntegration = (
      integration: McpIntegrationDefinition,
    ) => {
      disconnectMcp.mutate(
        { mcpId: integration.id },
        {
          onSuccess: () => {
            toast.success(`${integration.name} removed.`);
          },
          onError: (error) =>
            toast.error(
              error instanceof Error
                ? error.message
                : `Failed to remove ${integration.name}.`,
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
        enabled: Boolean(linearInstallation.data) && !linearOauthUnavailable,
        configured: linearOauthStatus === 'ready',
        needsConfiguration: linearOauthUnavailable,
        highlighted: highlightedIntegrationId === 'linear',
        isMcpBased: false,
        isPending:
          linearInstallation.isPending ||
          (!linearInstallation.data && effectiveIntegrations.isPending) ||
          connectLinear.isPending ||
          disconnectLinear.isPending,
        status: linearOauthUnavailable
          ? getLinearOauthSetupStatus(linearOauthStatus, isAdmin)
          : undefined,
        statusIcon: linearOauthUnavailable ? (
          <TriangleAlert className="size-4" />
        ) : undefined,
        actionLabel:
          linearOauthUnavailable && canSetUpLinearOauth
            ? 'Set up Linear'
            : !linearInstallation.data && linearOauthStatus === 'ready'
              ? 'Connect Linear'
              : undefined,
        headerAction: canReconnectLinear
          ? {
              label: 'Reconnect',
              ariaLabel: 'Reconnect Linear',
              onAction: startLinearConnection,
              isPending: connectLinear.isPending,
              icon: <RefreshCw />,
            }
          : undefined,
        utilityAction: canConfigureLinearOauth
          ? {
              label: 'Configure credentials',
              ariaLabel: 'Configure Linear',
              onAction: () => setIsLinearOauthSetupOpen(true),
              isPending: isLinearOauthSetupOpen && linearOauthSetup.isPending,
              icon: <Settings2 />,
            }
          : undefined,
        configureAction: isAdmin
          ? {
              label: 'Configure',
              ariaLabel: 'Configure Linear',
              onAction: () => setIsLinearOauthSetupOpen(true),
              isPending: isLinearOauthSetupOpen && linearOauthSetup.isPending,
              icon: <Pencil />,
            }
          : null,
        onAction: linearOauthUnavailable
          ? canSetUpLinearOauth
            ? () => setIsLinearOauthSetupOpen(true)
            : undefined
          : () => {
              if (linearInstallation.data) {
                disconnectLinear.mutate(undefined, {
                  onSuccess: () => toast.success('Linear removed.'),
                  onError: (error) =>
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : 'Failed to remove Linear. Please try again.',
                    ),
                });
                return;
              }

              startLinearConnection();
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
          const credentialItem = credentialItemsById.get(integration.id);
          if (credentialItem) {
            return credentialItem;
          }

          if (integration.id === 'exa') {
            const enabled = orgEnablementMap.get(integration.id) ?? false;
            const isPending =
              (setDeploymentEnabled.isPending &&
                setDeploymentEnabled.variables?.mcpId === integration.id) ||
              saveExaConnection.isPending ||
              removeExaApiKey.isPending;
            const configureAction = isAdmin
              ? {
                  label: isExaConnected ? 'Edit API key' : 'Add API key',
                  ariaLabel: `${isExaConnected ? 'Edit' : 'Add'} Exa API key`,
                  onAction: () => setIsExaDialogOpen(true),
                  isPending:
                    isPending || (isExaDialogOpen && exaConnection.isPending),
                  icon: <Pencil className="size-4" />,
                }
              : undefined;
            const manageToolsAction =
              isAdmin && enabled
                ? {
                    label: 'Manage tools',
                    ariaLabel: 'Manage Exa tools',
                    onAction: () => openMcpToolDialog(integration),
                    isPending: false,
                    icon: <Wrench className="size-4" />,
                  }
                : undefined;

            return {
              id: integration.id,
              name: integration.name,
              description: integration.description,
              icon: <McpIcon icon={integration.icon} name={integration.name} />,
              enabled,
              connected: isExaConnected,
              highlighted: highlightedIntegrationId === integration.id,
              isMcpBased: true,
              actionLabel: `${enabled ? 'Disable' : 'Enable'} Exa`,
              isPending,
              status: enabled
                ? isExaConnected
                  ? 'Enabled with a deployment API key. Exa Agent is available and usage-based.'
                  : 'Enabled with free keyless access. Exa rate limits apply, and Exa Agent is unavailable.'
                : isExaConnected
                  ? 'Disabled. The deployment API key is still stored.'
                  : 'Disabled. Enable Exa for free keyless search, or add a deployment API key.',
              configureAction,
              manageToolsAction,
              removeAction:
                isAdmin && isExaConnected
                  ? {
                      label: 'Remove API key',
                      ariaLabel: 'Remove Exa API key',
                      onAction: () =>
                        removeExaApiKey.mutate(undefined, {
                          onSuccess: () =>
                            toast.success(
                              enabled
                                ? 'Exa API key removed. Keyless access remains enabled.'
                                : 'Exa API key removed.',
                            ),
                          onError: (error) => toast.error(error.message),
                        }),
                      isPending: removeExaApiKey.isPending,
                      confirmationDescription:
                        'Remove the stored Exa API key. If Exa is enabled, it will continue with free keyless access.',
                    }
                  : undefined,
              utilityAction:
                isAdmin && isExaConnected
                  ? {
                      label: 'Remove API key',
                      ariaLabel: 'Remove Exa API key',
                      onAction: () => setIsRemoveExaApiKeyDialogOpen(true),
                      isPending: removeExaApiKey.isPending,
                      icon: <Trash2 className="size-4" />,
                    }
                  : undefined,
              headerAction: configureAction,
              secondaryAction: manageToolsAction,
              onAction: isAdmin
                ? () => {
                    const nextEnabled = !enabled;
                    setDeploymentEnabled.mutate(
                      { mcpId: integration.id, enabled: nextEnabled },
                      {
                        onSuccess: () =>
                          toast.success(
                            nextEnabled
                              ? 'Exa enabled for this deployment.'
                              : 'Exa disabled for this deployment.',
                          ),
                        onError: (error) => toast.error(error.message),
                      },
                    );
                  }
                : undefined,
            } satisfies IntegrationItem;
          }

          if (integration.id === 'voice') {
            if (voiceConfiguredByEnvironment) {
              // The key comes from the environment (an operator's or a
              // fleet-wide key), so there is nothing to configure or
              // disconnect; the deployment's admins still decide whether
              // Voice is on. The server reports that state (no enablement
              // row means on), unlike the effective-integrations list, which
              // treats a missing row as off.
              const voiceEnabled = voiceConnection.data?.enabled ?? true;
              const item = buildAdminConfiguredIntegrationItem({
                integration,
                connection: undefined,
                orgEnabled: voiceEnabled,
                highlightedIntegrationId,
                savePending: false,
                disconnectPending: false,
                disconnectingMcpId: undefined,
                dialogOpen: false,
                connectionPending: voiceConnection.isPending,
                canConfigure: false,
                canManageTools: false,
                openDialog: () => setIsVoiceDialogOpen(true),
                openToolDialog: () => openMcpToolDialog(integration),
                disconnectIntegration: () =>
                  disconnectAdminConfiguredIntegration(integration),
              });
              if (!isAdmin) {
                return item;
              }
              const nextEnabled = !voiceEnabled;
              return {
                ...item,
                configureAction: null,
                actionLabel: voiceEnabled ? 'Remove Voice' : 'Enable Voice',
                isPending:
                  setDeploymentEnabled.isPending &&
                  setDeploymentEnabled.variables?.mcpId === integration.id,
                onAction: () =>
                  setDeploymentEnabled.mutate(
                    { mcpId: integration.id, enabled: nextEnabled },
                    {
                      onSuccess: () =>
                        toast.success(
                          nextEnabled ? 'Voice enabled.' : 'Voice removed.',
                        ),
                      onError: (error) =>
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : `Failed to ${nextEnabled ? 'enable' : 'remove'} Voice.`,
                        ),
                    },
                  ),
              };
            }

            return buildAdminConfiguredIntegrationItem({
              integration,
              connection: userConnectionMap.get(integration.id),
              orgEnabled: orgEnablementMap.get(integration.id) ?? false,
              highlightedIntegrationId,
              savePending: saveVoiceConnection.isPending,
              disconnectPending: disconnectMcp.isPending,
              disconnectingMcpId: disconnectMcp.variables?.mcpId,
              dialogOpen: isVoiceDialogOpen,
              connectionPending: voiceConnection.isPending,
              canConfigure: isAdmin,
              // Credential-only: no agent tools to manage.
              canManageTools: false,
              openDialog: () => setIsVoiceDialogOpen(true),
              openToolDialog: () => openMcpToolDialog(integration),
              disconnectIntegration: () =>
                disconnectAdminConfiguredIntegration(integration),
            });
          }

          if (integration.id === 'elevenlabs') {
            return buildAdminConfiguredIntegrationItem({
              integration,
              connection: userConnectionMap.get(integration.id),
              orgEnabled: orgEnablementMap.get(integration.id) ?? false,
              highlightedIntegrationId,
              savePending: saveElevenLabsConnection.isPending,
              disconnectPending: disconnectMcp.isPending,
              disconnectingMcpId: disconnectMcp.variables?.mcpId,
              dialogOpen: isElevenLabsDialogOpen,
              connectionPending: elevenLabsConnection.isPending,
              canConfigure: isAdmin,
              // Credential-only: no agent tools to manage.
              canManageTools: false,
              openDialog: () => setIsElevenLabsDialogOpen(true),
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
              integration.serverMode !== 'credential_only' &&
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
                    icon: <Wrench className="size-4" />,
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
                      nextEnabled
                        ? `${displayName} enabled for this deployment.`
                        : `${displayName} removed.`,
                    );
                  },
                  onError: (error) =>
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : `Failed to ${nextEnabled ? 'enable' : 'remove'} ${displayName}.`,
                    ),
                },
              );
            },
          } satisfies IntegrationItem;
        }),
    ];

    return integrationIds === undefined
      ? sortIntegrationItems(baseItems, highlightedIntegrationId)
      : [...new Set(integrationIds)].flatMap((id) =>
          baseItems.filter(
            (item) => item.id === (id === 'sentry' ? 'sentry-mcp' : id),
          ),
        );
  }, [
    connectLinear,
    connectMcp,
    disconnectLinear,
    disconnectMcp,
    grafanaConnection.isPending,
    exaConnection.isPending,
    elevenLabsConnection.isPending,
    voiceConnection.isPending,
    voiceConfiguredByEnvironment,
    voiceConnection.data?.enabled,
    linearInstallation.data,
    linearInstallation.isPending,
    linearOauthSetup.isPending,
    linearOauthStatus,
    linearOauthUnavailable,
    effectiveIntegrations.isPending,
    isAdmin,
    isGrafanaDialogOpen,
    isExaDialogOpen,
    isExaConnected,
    isElevenLabsDialogOpen,
    isVoiceDialogOpen,
    isLinearOauthSetupOpen,
    saveGrafanaConnection.isPending,
    saveExaConnection.isPending,
    removeExaApiKey,
    saveElevenLabsConnection.isPending,
    saveVoiceConnection.isPending,
    saveVercelConnection.isPending,
    effectiveIntegrations.data,
    pathname,
    integrationIds,
    setDeploymentEnabled,
    saveSnowflakeConnection.isPending,
    snowflakeConnection.isPending,
    isSnowflakeDialogOpen,
    vercelConnection.isPending,
    isVercelDialogOpen,
    credentialItemsById,
    highlightedIntegrationId,
  ]);

  const handledConfigurationSequence = useRef<number | null>(null);
  const integrationsUnavailable = effectiveIntegrations.data?.some(
    (integration) => integration.status === 'unavailable',
  );

  useEffect(() => {
    if (
      configurationRequest == null ||
      effectiveIntegrations.isPending ||
      handledConfigurationSequence.current === configurationRequest.sequence
    ) {
      return;
    }

    const requestedItemId =
      configurationRequest.integrationId === 'sentry'
        ? 'sentry-mcp'
        : configurationRequest.integrationId;
    const requestedItem = items.find((item) => item.id === requestedItemId);
    const requestedIntegration = effectiveIntegrations.data?.find(
      (integration) => integration.id === configurationRequest.integrationId,
    );

    if (requestedItem?.isPending) {
      return;
    }

    handledConfigurationSequence.current = configurationRequest.sequence;

    if (integrationsUnavailable) {
      toast.error('Integrations are disabled by the deployment operator.');
      return;
    }

    if (requestedItem == null) {
      toast.error('This integration cannot be configured here.');
      return;
    }

    if (requestedIntegration?.status === 'connected') {
      toast.success(`${requestedItem.name} is already connected.`);
      return;
    }

    if (requestedIntegration?.status === 'needs_connection') {
      const reconnectAction =
        requestedItem.headerAction?.onAction ??
        (requestedItem.secondaryAction?.ariaLabel.startsWith('Reconnect ')
          ? requestedItem.secondaryAction.onAction
          : undefined);

      if (reconnectAction) {
        reconnectAction();
        return;
      }
    }

    if (requestedItem.onAction == null) {
      toast.error('This integration cannot be configured here.');
      return;
    }

    requestedItem.onAction();
  }, [
    configurationRequest,
    effectiveIntegrations.data,
    effectiveIntegrations.isPending,
    integrationsUnavailable,
    items,
  ]);

  const {
    isEnabled: customMcpEnabled,
    items: customMcpItems,
    openAddDialog: openCustomMcpDialog,
    dialogs: customMcpDialogs,
  } = useCustomMcpServers();
  const {
    items: apiKeyItems,
    isLoading: apiKeyItemsLoading,
    error: apiKeyItemsError,
    openAddDialog: openApiKeyDialog,
    dialogs: apiKeyDialogs,
  } = useYourIntegrations();
  const handledAddRequestSequence = useRef<number | null>(null);

  useEffect(() => {
    if (
      addRequest == null ||
      handledAddRequestSequence.current === addRequest.sequence
    ) {
      return;
    }

    handledAddRequestSequence.current = addRequest.sequence;
    if (addRequest.type === 'catalog') {
      setIsCatalogOpen(true);
    } else if (addRequest.type === 'custom-mcp') {
      if (customMcpEnabled) {
        openCustomMcpDialog();
      } else {
        toast.error(
          'Custom MCP servers are disabled by the deployment operator.',
        );
      }
    } else {
      openApiKeyDialog();
    }
  }, [addRequest, customMcpEnabled, openApiKeyDialog, openCustomMcpDialog]);

  const availableItems = items.filter((item) => !item.enabled);
  const activeItems = [
    ...items
      .filter((item) => item.enabled)
      .map((item) => ({
        ...item,
        configureAction:
          item.configureAction === undefined
            ? {
                label: 'Configure',
                ariaLabel: `Configure ${item.name}`,
                onAction: () => setConfigurationInfoItem(item),
                isPending: false,
              }
            : item.configureAction,
        manageToolsAction:
          item.manageToolsAction ??
          (item.secondaryAction?.label.startsWith('Manage')
            ? {
                ...item.secondaryAction,
                label: 'Manage available tools',
              }
            : undefined),
      })),
    ...customMcpItems,
    ...apiKeyItems,
  ]
    .filter((item) => item.enabled)
    .map((item) => ({
      ...item,
      removeAction:
        item.removeAction ??
        (item.onAction
          ? {
              label: 'Remove',
              ariaLabel: `Remove ${item.name}`,
              onAction: item.onAction,
              isPending: item.isPending,
            }
          : undefined),
    }));
  const configurationInfoDefinition = configurationInfoItem
    ? MCP_INTEGRATIONS.find(
        (integration) =>
          integration.id ===
          (configurationInfoItem.id === 'sentry-mcp'
            ? 'sentry'
            : configurationInfoItem.id),
      )
    : undefined;
  const configurationIsDeploymentScoped = configurationInfoDefinition
    ? isDeploymentScopedMcpIntegration(configurationInfoDefinition)
    : false;
  const displayedActiveItems = integrationsUnavailable
    ? [...customMcpItems, ...apiKeyItems].filter((item) => item.enabled)
    : activeItems;
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
    nextSearchParams.delete('mcp');
    nextSearchParams.delete('reason');

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

  const handleExaFieldChange = (field: keyof ExaFormState, value: string) => {
    setExaForm((current) => ({ ...current, [field]: value }));
    setExaFieldErrors((current) =>
      current[field] ? { ...current, [field]: undefined } : current,
    );
    setExaFormError(null);
  };

  const handleVoiceFieldChange = (
    field: keyof VoiceFormState,
    value: string,
  ) => {
    setVoiceForm((current) => ({ ...current, [field]: value }));
    setVoiceFieldErrors((current) => {
      if (!current[field]) {
        return current;
      }

      return { ...current, [field]: undefined };
    });
  };

  const handleElevenLabsFieldChange = (
    field: keyof ElevenLabsFormState,
    value: string,
  ) => {
    setElevenLabsForm((current) => ({ ...current, [field]: value }));
    setElevenLabsFieldErrors((current) => {
      if (!current[field]) {
        return current;
      }

      return { ...current, [field]: undefined };
    });
    setElevenLabsFormError(null);
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

  const handleExaDialogOpenChange = (open: boolean) => {
    setIsExaDialogOpen(open);
    setExaFieldErrors({});
    setExaFormError(null);

    if (open) {
      setExaForm(buildEmptyExaForm());
    }
  };

  const handleVoiceDialogOpenChange = (open: boolean) => {
    setIsVoiceDialogOpen(open);

    setVoiceFieldErrors({});
    setVoiceFormError(null);

    if (!open) {
      return;
    }

    setVoiceForm(buildEmptyVoiceForm());
  };

  const handleElevenLabsDialogOpenChange = (open: boolean) => {
    setIsElevenLabsDialogOpen(open);

    setElevenLabsFieldErrors({});
    setElevenLabsFormError(null);

    if (!open) {
      return;
    }

    setElevenLabsForm(buildElevenLabsForm(elevenLabsConnection.data));
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

  const handleExaSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsed = saveExaConnectionSchema.safeParse(exaForm);
    if (!parsed.success) {
      setExaFieldErrors(getExaFieldErrors(parsed));
      return;
    }

    if (!isExaConnected && parsed.data.apiKey.length === 0) {
      setExaFieldErrors({ apiKey: ['API key is required'] });
      return;
    }

    setExaFieldErrors({});
    setExaFormError(null);
    saveExaConnection.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(
          isExaConnected
            ? 'Exa API key updated for this deployment.'
            : 'Exa API key saved for this deployment.',
        );
        handleExaDialogOpenChange(false);
      },
      onError: (error) => setExaFormError(error.message),
    });
  };

  const handleVoiceSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsed = saveVoiceConnectionSchema.safeParse({
      apiKey: voiceForm.apiKey,
      voiceId: voiceForm.voiceId,
    });
    if (!parsed.success) {
      setVoiceFieldErrors(getVoiceFieldErrors(parsed));
      return;
    }

    if (!isVoiceConnected && parsed.data.apiKey.length === 0) {
      setVoiceFieldErrors({ apiKey: ['API key is required'] });
      return;
    }

    setVoiceFieldErrors({});
    setVoiceFormError(null);

    saveVoiceConnection.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(
          isVoiceConnected
            ? 'Voice key updated for this deployment.'
            : 'Voice enabled for this deployment.',
        );
        handleVoiceDialogOpenChange(false);
      },
      onError: (error) => {
        setVoiceFormError(error.message);
      },
    });
  };

  const handleElevenLabsSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsed = saveElevenLabsConnectionSchema.safeParse({
      apiKey: elevenLabsForm.apiKey,
      voiceId: elevenLabsForm.voiceId,
    });
    if (!parsed.success) {
      setElevenLabsFieldErrors(getElevenLabsFieldErrors(parsed));
      return;
    }

    if (!isElevenLabsConnected && parsed.data.apiKey.length === 0) {
      setElevenLabsFieldErrors({
        apiKey: ['API key is required'],
      });
      return;
    }

    setElevenLabsFieldErrors({});
    setElevenLabsFormError(null);

    saveElevenLabsConnection.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(
          isElevenLabsConnected
            ? 'ElevenLabs connection updated for this deployment.'
            : 'ElevenLabs connected for this deployment.',
        );
        handleElevenLabsDialogOpenChange(false);
      },
      onError: (error) => {
        setElevenLabsFormError(error.message);
      },
    });
  };

  const handleSnowflakeSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsed = saveSnowflakeConnectionSchema.safeParse({
      account: snowflakeForm.account,
      username: snowflakeForm.username,
      privateKey: snowflakeForm.privateKey,
      privateKeyPassphrase: snowflakeForm.privateKeyPassphrase,
      role: snowflakeForm.role,
    });
    if (!parsed.success) {
      setSnowflakeFieldErrors(getSnowflakeFieldErrors(parsed));
      return;
    }

    if (!isSnowflakeConnected && parsed.data.privateKey.trim().length === 0) {
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

  if (integrationsUnavailable && integrationIds !== undefined) {
    return (
      <div>
        <Alert>
          <AlertTitle>Integrations disabled by deployment operator</AlertTitle>
          <AlertDescription>
            Curated integrations cannot be connected or used on this Roomote
            instance.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className={integrationIds === undefined ? 'contents' : 'space-y-8'}>
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
      <LinearOauthSetupDialog
        open={isLinearOauthSetupOpen}
        onOpenChange={setIsLinearOauthSetupOpen}
        setup={linearOauthSetup.data}
      />
      {credentialIntegrations.dialogs}
      <AdminConfiguredIntegrationDialog
        integrationName="Exa"
        title={isExaConnected ? 'Edit Exa API key' : 'Add Exa API key'}
        open={isExaDialogOpen}
        onOpenChange={handleExaDialogOpenChange}
        isEditing={isExaConnected}
        isPending={saveExaConnection.isPending}
        isLoading={isExaConnected && exaConnection.isPending}
        submitLabel={isExaConnected ? 'Save changes' : 'Add API key'}
        description={
          <>
            Optionally store an Exa API key for authenticated access and Exa
            Agent. The key stays encrypted server-side and is sent only from
            Roomote&apos;s proxy to Exa. Saving it does not change whether Exa
            is enabled.
          </>
        }
        onSubmit={handleExaSubmit}
      >
        <ExaConnectionFields
          form={exaForm}
          fieldErrors={exaFieldErrors}
          formError={exaFormError}
          allowBlankApiKey={isExaConnected}
          onFieldChange={handleExaFieldChange}
        />
      </AdminConfiguredIntegrationDialog>
      <Dialog
        open={isRemoveExaApiKeyDialogOpen}
        onOpenChange={setIsRemoveExaApiKeyDialogOpen}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Remove Exa API key?</DialogTitle>
            <DialogDescription>
              Remove the stored Exa API key. If Exa is enabled, it will continue
              with free keyless access.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsRemoveExaApiKeyDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={removeExaApiKey.isPending}
              onClick={() =>
                removeExaApiKey.mutate(undefined, {
                  onSuccess: () => {
                    setIsRemoveExaApiKeyDialogOpen(false);
                    toast.success(
                      effectiveIntegrations.data?.find(
                        (entry) => entry.id === 'exa',
                      )?.enabled
                        ? 'Exa API key removed. Keyless access remains enabled.'
                        : 'Exa API key removed.',
                    );
                  },
                  onError: (error) => toast.error(error.message),
                })
              }
            >
              {removeExaApiKey.isPending ? <Spinner size="sm" /> : <Trash2 />}
              Remove key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AdminConfiguredIntegrationDialog
        integrationName="Voice"
        open={isVoiceDialogOpen}
        onOpenChange={handleVoiceDialogOpenChange}
        isEditing={isVoiceConnected}
        isPending={saveVoiceConnection.isPending}
        isLoading={isVoiceConnected && voiceConnection.isPending}
        description={
          <>Store an OpenAI API key with GPT-Live access for this deployment.</>
        }
        onSubmit={handleVoiceSubmit}
      >
        <VoiceConnectionFields
          form={voiceForm}
          fieldErrors={voiceFieldErrors}
          formError={voiceFormError}
          allowBlankApiKey={isVoiceConnected}
          onFieldChange={handleVoiceFieldChange}
        />
      </AdminConfiguredIntegrationDialog>
      <AdminConfiguredIntegrationDialog
        integrationName="ElevenLabs"
        open={isElevenLabsDialogOpen}
        onOpenChange={handleElevenLabsDialogOpenChange}
        isEditing={isElevenLabsConnected}
        isPending={saveElevenLabsConnection.isPending}
        isLoading={isElevenLabsConnected && elevenLabsConnection.isPending}
        description={
          <>
            Store an ElevenLabs API key and voice ID for this deployment. The
            key stays encrypted server-side and is used only by the control
            plane to narrate feature-demo videos.
          </>
        }
        onSubmit={handleElevenLabsSubmit}
      >
        <ElevenLabsConnectionFields
          form={elevenLabsForm}
          fieldErrors={elevenLabsFieldErrors}
          formError={elevenLabsFormError}
          allowBlankApiKey={isElevenLabsConnected}
          onFieldChange={handleElevenLabsFieldChange}
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
          allowBlankPrivateKey={isSnowflakeConnected}
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
      {customMcpDialogs}
      {apiKeyDialogs}
      <Dialog open={isCatalogOpen} onOpenChange={setIsCatalogOpen}>
        <DialogContent
          size="xl"
          className="md:grid-rows-[auto_minmax(0,1fr)] md:overflow-y-hidden"
        >
          <DialogHeader>
            <DialogTitle>Add from the catalog</DialogTitle>
            <DialogDescription>
              Choose a built-in integration to connect or configure.
            </DialogDescription>
          </DialogHeader>
          {integrationsUnavailable ? (
            <Alert>
              <AlertTitle>
                Integrations disabled by deployment operator
              </AlertTitle>
              <AlertDescription>
                Built-in integrations cannot be added on this Roomote instance.
              </AlertDescription>
            </Alert>
          ) : availableItems.length > 0 ? (
            <div className="divide-y divide-background rounded-lg border bg-card md:min-h-0 md:overflow-y-auto">
              {availableItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <div className="flex size-5 shrink-0 items-center justify-center">
                    {item.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {item.name}
                    </p>
                  </div>
                  {[item.headerAction, item.utilityAction]
                    .filter((action) => action != null)
                    .map((action) => (
                      <BasicTooltip
                        key={action.ariaLabel}
                        content={action.label}
                      >
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={action.ariaLabel}
                          disabled={action.isPending}
                          onClick={() => {
                            setIsCatalogOpen(false);
                            action.onAction();
                          }}
                        >
                          {action.isPending ? (
                            <Spinner size="sm" />
                          ) : (
                            action.icon
                          )}
                        </Button>
                      </BasicTooltip>
                    ))}
                  {item.onAction ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        setIsCatalogOpen(false);
                        item.onAction?.();
                      }}
                    >
                      <Plus />
                      Add
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              All available built-in integrations are active.
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={configurationInfoItem != null}
        onOpenChange={(open) => {
          if (!open) setConfigurationInfoItem(null);
        }}
      >
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>
              Configure {configurationInfoItem?.name ?? 'integration'}
            </DialogTitle>
            <DialogDescription>
              {configurationInfoItem?.description}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {configurationIsDeploymentScoped
              ? 'Reconnect the workspace account to update this deployment-wide connection.'
              : 'Connection settings for this integration are managed by each team member from Personal settings.'}{' '}
            Deployment-wide tool availability can be managed from the sliders
            action in this list.
          </p>
          <DialogFooter>
            {configurationIsDeploymentScoped && configurationInfoDefinition ? (
              <Button
                type="button"
                onClick={() => {
                  connectMcp.mutate(
                    {
                      mcpId: configurationInfoDefinition.id,
                      redirectTo: pathname,
                    },
                    {
                      onSuccess: (url) => {
                        window.location.href = url;
                      },
                      onError: (error) => toast.error(error.message),
                    },
                  );
                }}
              >
                Reconnect
              </Button>
            ) : (
              <Button asChild>
                <Link href="/settings/personal">Open Personal settings</Link>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!showCatalog ? null : integrationIds !== undefined ? (
        <IntegrationSection
          id="selected-integrations"
          title="Integrations"
          items={items}
        />
      ) : (
        <div className="space-y-3 md:flex md:min-h-0 md:flex-1 md:flex-col md:gap-3 md:space-y-0">
          {integrationsUnavailable ? (
            <Alert>
              <AlertTitle>
                Integrations disabled by deployment operator
              </AlertTitle>
              <AlertDescription>
                Built-in integrations cannot be connected or used on this
                Roomote instance. Active custom and API-key integrations remain
                listed below.
              </AlertDescription>
            </Alert>
          ) : null}
          {apiKeyItemsError ? (
            <p role="alert" className="text-sm text-destructive">
              {apiKeyItemsError}
            </p>
          ) : null}
          <Card
            variant="snug"
            className="gap-0 p-0 md:min-h-0 md:flex-1 md:overflow-y-auto"
          >
            <CardContent className="h-full p-0!">
              <div
                role="table"
                aria-label="Integrations"
                className="flex h-full flex-col"
              >
                <IntegrationListHeader />
                <div
                  role="rowgroup"
                  className="flex min-h-0 flex-1 flex-col divide-y divide-background"
                >
                  {apiKeyItemsLoading ? (
                    <div className="space-y-2 px-4 py-3">
                      <Skeleton className="h-4 w-48" />
                      <Skeleton className="h-3 w-full max-w-lg" />
                    </div>
                  ) : null}
                  {displayedActiveItems.map((item) => (
                    <IntegrationListRow
                      key={item.id}
                      item={item}
                      showStatusInDescription
                    />
                  ))}
                  {!apiKeyItemsLoading && displayedActiveItems.length === 0 ? (
                    <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-3 px-4 py-6">
                      <Image
                        src="/elements/integrations.png"
                        width={778}
                        height={685}
                        alt=""
                        className="max-h-32 w-auto object-contain"
                      />
                      <p className="text-sm text-muted-foreground">
                        No active integrations yet.
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
