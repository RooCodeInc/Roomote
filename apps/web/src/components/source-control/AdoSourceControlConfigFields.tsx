'use client';

import type { SetupSourceControlStatus } from '@roomote/types';

import {
  Button,
  Check,
  ChevronDown,
  ExternalLink,
  Input,
  Label,
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

export function AdoSourceControlConfigFields({
  fields,
  values,
  editingSavedValues,
  organizationConfirmed,
  advancedExpanded,
  disabled,
  compact = false,
  idPrefix,
  onValueChange,
  onEditingSavedValueChange,
  onEditOrganization,
  onAdvancedExpandedChange,
}: {
  fields: readonly SourceControlField[];
  values: Record<string, string>;
  editingSavedValues: Record<string, boolean>;
  organizationConfirmed: boolean;
  advancedExpanded: boolean;
  disabled: boolean;
  compact?: boolean;
  idPrefix: string;
  onValueChange: (envVarName: string, value: string) => void;
  onEditingSavedValueChange: (envVarName: string, editing: boolean) => void;
  onEditOrganization: () => void;
  onAdvancedExpandedChange: (expanded: boolean) => void;
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
  const advancedFields = fields.filter(
    (field) =>
      field.envVarName !== ADO_ORGANIZATION_ENV_VAR &&
      field.envVarName !== ADO_TOKEN_ENV_VAR,
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
  const serverContentId = `${idPrefix}-server-options`;
  const serverCollapsedErrorId = `${idPrefix}-server-options-error`;
  const advancedCollapsedErrorId = `${idPrefix}-advanced-options-error`;

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
                Optional settings for custom hosts, Git credentials, personal
                account linking, and webhook verification.
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
