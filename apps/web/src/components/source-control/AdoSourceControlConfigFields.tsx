'use client';

import type { SetupSourceControlStatus } from '@roomote/types';

import {
  Button,
  Check,
  ChevronDown,
  CopyIconButton,
  ExternalLink,
  Input,
  Label,
  Spinner,
} from '@/components/system';
import {
  ADO_PAT_DOCUMENTATION_URL,
  buildAdoPersonalAccessTokenUrl,
  getAdoBaseUrlValidationError,
  getAdoOrganizationValidationError,
  isAdoCloudBaseUrl,
  normalizeAdoOrganization,
} from '@/lib/ado';

const MASKED_VALUE = '••••••••••••••••••••••••••••';
const ADO_ORGANIZATION_ENV_VAR = 'ADO_ORGANIZATION';
const ADO_TOKEN_ENV_VAR = 'ADO_TOKEN';
const ADO_BASE_URL_ENV_VAR = 'ADO_BASE_URL';
const ADO_CLIENT_ID_ENV_VAR = 'ADO_CLIENT_ID';
const ADO_CLIENT_SECRET_ENV_VAR = 'ADO_CLIENT_SECRET';
const ADO_TENANT_ID_ENV_VAR = 'ADO_TENANT_ID';
const ADO_OAUTH_ENV_VARS = new Set([
  ADO_CLIENT_ID_ENV_VAR,
  ADO_CLIENT_SECRET_ENV_VAR,
  ADO_TENANT_ID_ENV_VAR,
]);
const ENTRA_APP_REGISTRATIONS_URL =
  'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade';

type SourceControlField =
  SetupSourceControlStatus['providers'][number]['fields'][number];

function isSecretSourceControlField(field: Pick<SourceControlField, 'secret'>) {
  return field.secret === true;
}

function fieldInputId(idPrefix: string, field: SourceControlField) {
  return `${idPrefix}-${field.envVarName.toLowerCase().replaceAll('_', '-')}`;
}

export function getEffectiveAdoOrganization(
  fields: readonly SourceControlField[],
  values: Record<string, string>,
): string {
  const organizationField = fields.find(
    (field) => field.envVarName === ADO_ORGANIZATION_ENV_VAR,
  );
  const organization =
    values[ADO_ORGANIZATION_ENV_VAR] ?? organizationField?.savedValue ?? '';

  return normalizeAdoOrganization(organization);
}

export function getEffectiveAdoBaseUrl(
  fields: readonly SourceControlField[],
  values: Record<string, string>,
): string {
  const baseUrlField = fields.find(
    (field) => field.envVarName === ADO_BASE_URL_ENV_VAR,
  );

  return (
    values[ADO_BASE_URL_ENV_VAR] ??
    baseUrlField?.savedValue ??
    ''
  ).trim();
}

function isFieldSatisfied(
  field: SourceControlField | undefined,
  values: Record<string, string>,
) {
  return (
    field?.runtimeSatisfied === true ||
    field?.savedSatisfied === true ||
    (field ? (values[field.envVarName]?.trim().length ?? 0) > 0 : false)
  );
}

export function getAdoOAuthValidationError(
  fields: readonly SourceControlField[],
  values: Record<string, string>,
): string | null {
  const clientIdSatisfied = isFieldSatisfied(
    fields.find((field) => field.envVarName === ADO_CLIENT_ID_ENV_VAR),
    values,
  );
  const clientSecretSatisfied = isFieldSatisfied(
    fields.find((field) => field.envVarName === ADO_CLIENT_SECRET_ENV_VAR),
    values,
  );

  return clientIdSatisfied !== clientSecretSatisfied
    ? 'Enter both the Microsoft Entra application (client) ID and client secret.'
    : null;
}

function isAdoOAuthConfigured(fields: readonly SourceControlField[]) {
  return [ADO_CLIENT_ID_ENV_VAR, ADO_CLIENT_SECRET_ENV_VAR].every(
    (envVarName) => {
      const field = fields.find(
        (candidate) => candidate.envVarName === envVarName,
      );
      return field?.runtimeSatisfied === true || field?.savedSatisfied === true;
    },
  );
}

function isAdoOAuthReady(
  fields: readonly SourceControlField[],
  values: Record<string, string>,
) {
  return [ADO_CLIENT_ID_ENV_VAR, ADO_CLIENT_SECRET_ENV_VAR].every(
    (envVarName) =>
      isFieldSatisfied(
        fields.find((field) => field.envVarName === envVarName),
        values,
      ),
  );
}

export function AdoSourceControlConfigFields({
  fields,
  values,
  editingSavedValues,
  organizationConfirmed,
  advancedExpanded,
  oauthExpanded,
  oauthCallbackUrl,
  oauthAccountLinked,
  oauthAccountStatePending,
  oauthLinkPending,
  disabled,
  compact = false,
  idPrefix,
  onValueChange,
  onEditingSavedValueChange,
  onEditOrganization,
  onAdvancedExpandedChange,
  onOauthExpandedChange,
  onLinkAccount,
  onSaveAndLinkAccount,
}: {
  fields: readonly SourceControlField[];
  values: Record<string, string>;
  editingSavedValues: Record<string, boolean>;
  organizationConfirmed: boolean;
  advancedExpanded: boolean;
  oauthExpanded: boolean;
  oauthCallbackUrl: string;
  oauthAccountLinked: boolean;
  oauthAccountStatePending: boolean;
  oauthLinkPending: boolean;
  disabled: boolean;
  compact?: boolean;
  idPrefix: string;
  onValueChange: (envVarName: string, value: string) => void;
  onEditingSavedValueChange: (envVarName: string, editing: boolean) => void;
  onEditOrganization: () => void;
  onAdvancedExpandedChange: (expanded: boolean) => void;
  onOauthExpandedChange: (expanded: boolean) => void;
  onLinkAccount: () => void;
  onSaveAndLinkAccount: () => void;
}) {
  const organizationField = fields.find(
    (field) => field.envVarName === ADO_ORGANIZATION_ENV_VAR,
  );
  const tokenField = fields.find(
    (field) => field.envVarName === ADO_TOKEN_ENV_VAR,
  );
  const baseUrlField = fields.find(
    (field) => field.envVarName === ADO_BASE_URL_ENV_VAR,
  );
  const oauthFields = fields.filter((field) =>
    ADO_OAUTH_ENV_VARS.has(field.envVarName),
  );
  const advancedFields = fields.filter(
    (field) =>
      field.envVarName !== ADO_ORGANIZATION_ENV_VAR &&
      field.envVarName !== ADO_TOKEN_ENV_VAR &&
      !ADO_OAUTH_ENV_VARS.has(field.envVarName),
  );
  const organization = getEffectiveAdoOrganization(fields, values);
  const baseUrl = getEffectiveAdoBaseUrl(fields, values);
  const usesAdoCloud = isAdoCloudBaseUrl(baseUrl);
  const organizationValidationError = getAdoOrganizationValidationError(
    organization,
    baseUrl,
  );
  const visibleOrganizationValidationError = organization
    ? organizationValidationError
    : null;
  const baseUrlValidationError = getAdoBaseUrlValidationError(baseUrl);
  const patCreationUrl = usesAdoCloud
    ? buildAdoPersonalAccessTokenUrl(organization)
    : ADO_PAT_DOCUMENTATION_URL;
  const advancedContentId = `${idPrefix}-advanced-options`;
  const oauthContentId = `${idPrefix}-oauth-options`;
  const serverContentId = `${idPrefix}-server-options`;
  const serverCollapsedErrorId = `${idPrefix}-server-options-error`;
  const advancedCollapsedErrorId = `${idPrefix}-advanced-options-error`;
  const oauthValidationError = getAdoOAuthValidationError(fields, values);
  const oauthConfigured = isAdoOAuthConfigured(fields);
  const oauthReady = isAdoOAuthReady(fields, values);

  const renderField = (
    field: SourceControlField,
    validationError: string | null = null,
  ) => {
    const value = values[field.envVarName] ?? '';
    const isSecretField = isSecretSourceControlField(field);
    const shouldShowSavedValueMask =
      isSecretField &&
      !field.runtimeSatisfied &&
      field.savedSatisfied &&
      value.length === 0 &&
      !editingSavedValues[field.envVarName];
    const inputId = fieldInputId(idPrefix, field);
    const errorId = `${inputId}-error`;

    return (
      <div
        key={field.envVarName}
        className={`grid max-w-xl gap-2 ${
          compact
            ? 'md:grid-cols-[180px_minmax(0,1fr)]'
            : 'md:grid-cols-[200px_minmax(0,1fr)]'
        } md:items-center`}
      >
        <Label htmlFor={inputId} className="text-sm font-medium">
          {field.label}
          {field.required === false ? ' (optional)' : ''}
        </Label>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              secret={isSecretField && !field.runtimeSatisfied}
              type={isSecretField ? undefined : 'text'}
              className="font-mono"
              value={
                isSecretField && field.runtimeSatisfied
                  ? MASKED_VALUE
                  : shouldShowSavedValueMask
                    ? MASKED_VALUE
                    : field.runtimeSatisfied && !isSecretField
                      ? (field.savedValue ?? value)
                      : value
              }
              onFocus={() => {
                if (shouldShowSavedValueMask) {
                  onEditingSavedValueChange(field.envVarName, true);
                }
              }}
              onBlur={() => {
                if (
                  isSecretField &&
                  field.savedSatisfied &&
                  value.length === 0
                ) {
                  onEditingSavedValueChange(field.envVarName, false);
                }
              }}
              onChange={(event) =>
                onValueChange(field.envVarName, event.target.value)
              }
              placeholder={field.runtimeSatisfied ? '' : field.envVarName}
              disabled={disabled || field.runtimeSatisfied}
              aria-invalid={validationError ? true : undefined}
              aria-describedby={validationError ? errorId : undefined}
              data-1p-ignore
            />
            {(field.runtimeSatisfied || field.savedSatisfied) && <Check />}
          </div>
          {validationError ? (
            <p id={errorId} className="text-sm text-destructive">
              {validationError}
            </p>
          ) : null}
        </div>
      </div>
    );
  };

  if (!organizationConfirmed) {
    return (
      <div className="space-y-4">
        <div className="space-y-1 max-w-xl">
          <p className="font-semibold">
            {usesAdoCloud
              ? 'Enter your Azure DevOps organization.'
              : 'Enter your Azure DevOps Server project collection.'}
          </p>
          <p className="text-sm text-muted-foreground">
            {usesAdoCloud ? (
              <>
                Use the organization name from your{' '}
                <code>https://dev.azure.com/&lt;organization&gt;</code> URL.
              </>
            ) : (
              'Use the collection name shown in your Azure DevOps Server web portal URL.'
            )}
          </p>
        </div>
        {organizationField
          ? renderField(organizationField, visibleOrganizationValidationError)
          : null}
        {baseUrlField ? (
          <div className="space-y-3">
            <button
              type="button"
              className="cursor-pointer text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              onClick={() => onAdvancedExpandedChange(!advancedExpanded)}
              disabled={disabled}
              aria-expanded={advancedExpanded}
              aria-controls={serverContentId}
              aria-describedby={
                !advancedExpanded && baseUrlValidationError
                  ? serverCollapsedErrorId
                  : undefined
              }
            >
              {advancedExpanded
                ? 'Hide Azure DevOps Server options'
                : 'Using Azure DevOps Server?'}
              <ChevronDown
                className={`${advancedExpanded ? 'rotate-180' : ''} inline size-4 transition-all`}
              />
            </button>
            {advancedExpanded ? (
              <div id={serverContentId} className="space-y-3">
                <p className="max-w-xl text-sm text-muted-foreground">
                  Enter the web portal URL for your self-hosted Azure DevOps
                  Server. The organization field should contain its project
                  collection name.
                </p>
                {renderField(baseUrlField, baseUrlValidationError)}
              </div>
            ) : baseUrlValidationError ? (
              <p
                id={serverCollapsedErrorId}
                className="text-sm text-destructive"
              >
                {baseUrlValidationError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1 max-w-xl">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Organization</span>
          <code className="ph-no-capture">{organization}</code>
          {organizationField?.runtimeSatisfied ? (
            <span className="text-muted-foreground">
              Managed by runtime configuration
            </span>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={onEditOrganization}
              disabled={disabled}
            >
              Change organization
            </Button>
          )}
        </div>
        {organizationValidationError ? (
          <p className="text-sm text-destructive">
            {organizationValidationError}
          </p>
        ) : null}
      </div>

      <div className="space-y-3 max-w-xl">
        <div className="space-y-1">
          <p className="font-semibold">
            {usesAdoCloud
              ? 'Create a personal access token.'
              : 'Create a personal access token in Azure DevOps Server.'}
          </p>
          <p className="text-sm text-muted-foreground">
            {usesAdoCloud
              ? 'Create the PAT with Code read & write access and permission to manage service hook subscriptions, then paste it below.'
              : 'Open the PAT instructions, then create a token from your server user settings and paste it below.'}
          </p>
        </div>
        {patCreationUrl ? (
          <Button asChild variant="outline" size={compact ? 'sm' : 'default'}>
            <a href={patCreationUrl} target="_blank" rel="noopener noreferrer">
              {usesAdoCloud
                ? 'Create Azure DevOps PAT'
                : 'View PAT setup instructions'}
              <ExternalLink />
            </a>
          </Button>
        ) : null}
      </div>

      {tokenField ? renderField(tokenField) : null}

      {usesAdoCloud && oauthFields.length > 0 ? (
        <div className="space-y-3 border-t pt-6">
          <div className="space-y-1 max-w-xl">
            <p className="font-semibold">Optional: link user accounts</p>
            <p className="text-sm text-muted-foreground">
              The PAT connects this Roomote deployment to Azure DevOps. OAuth
              separately identifies each user, which is required when they start
              Roomote work from pull request comments.
            </p>
          </div>
          <button
            type="button"
            className="cursor-pointer text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            onClick={() => onOauthExpandedChange(!oauthExpanded)}
            disabled={disabled || oauthLinkPending}
            aria-expanded={oauthExpanded}
            aria-controls={oauthContentId}
          >
            {oauthExpanded
              ? 'Hide account linking setup'
              : 'Set up account linking'}
            <ChevronDown
              className={`${oauthExpanded ? 'rotate-180' : ''} inline size-4 transition-all`}
            />
          </button>
          {oauthExpanded ? (
            <div id={oauthContentId} className="space-y-4">
              <div className="space-y-2 max-w-xl text-sm text-muted-foreground">
                <p>
                  Create a Microsoft Entra app registration. If Microsoft Teams
                  or Microsoft sign-in is already configured, you can reuse that
                  app: add the callback below and grant the delegated Azure
                  DevOps <code>user_impersonation</code> permission.
                </p>
                <Button
                  asChild
                  variant="outline"
                  size={compact ? 'sm' : 'default'}
                >
                  <a
                    href={ENTRA_APP_REGISTRATIONS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Microsoft Entra app registrations
                    <ExternalLink />
                  </a>
                </Button>
                <p>Configure this Web redirect URI:</p>
                <p className="flex items-center gap-1">
                  <code className="break-all text-foreground">
                    {oauthCallbackUrl}
                  </code>
                  <CopyIconButton
                    content={oauthCallbackUrl}
                    tooltip="Copy redirect URI"
                  />
                </p>
                <p>
                  Paste the application ID and client secret below. The tenant
                  ID is optional; use the same tenant as Teams when applicable.
                </p>
              </div>
              <div className="space-y-2">
                {oauthFields.map((field) => renderField(field))}
              </div>
              {oauthValidationError ? (
                <p className="text-sm text-destructive" role="alert">
                  {oauthValidationError}
                </p>
              ) : null}
              {oauthAccountStatePending ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner /> Checking linked account…
                </p>
              ) : oauthAccountLinked ? (
                <p className="flex items-center gap-2 text-sm">
                  <Check /> Your Azure DevOps account is linked.
                </p>
              ) : oauthConfigured ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onLinkAccount}
                  disabled={disabled || oauthLinkPending}
                >
                  {oauthLinkPending ? <Spinner /> : null}
                  Link my Azure DevOps account
                </Button>
              ) : oauthReady && !oauthValidationError ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onSaveAndLinkAccount}
                  disabled={disabled || oauthLinkPending}
                >
                  {disabled || oauthLinkPending ? <Spinner /> : null}
                  Save and link my account
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {advancedFields.length > 0 ? (
        <div className="space-y-3">
          <button
            type="button"
            className="cursor-pointer text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            onClick={() => onAdvancedExpandedChange(!advancedExpanded)}
            disabled={disabled}
            aria-expanded={advancedExpanded}
            aria-controls={advancedContentId}
            aria-describedby={
              !advancedExpanded && baseUrlValidationError
                ? advancedCollapsedErrorId
                : undefined
            }
          >
            {advancedExpanded
              ? 'Hide advanced options'
              : 'Show advanced options'}
            <ChevronDown
              className={`${advancedExpanded ? 'rotate-180' : ''} inline size-4 transition-all`}
            />
          </button>
          {advancedExpanded ? (
            <div id={advancedContentId} className="space-y-2">
              <p className="max-w-xl text-sm text-muted-foreground">
                Optional settings for custom hosts, Git credentials, and webhook
                verification.
              </p>
              {advancedFields.map((field) =>
                renderField(
                  field,
                  field.envVarName === ADO_BASE_URL_ENV_VAR
                    ? baseUrlValidationError
                    : null,
                ),
              )}
            </div>
          ) : baseUrlValidationError ? (
            <p
              id={advancedCollapsedErrorId}
              className="text-sm text-destructive"
            >
              {baseUrlValidationError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
