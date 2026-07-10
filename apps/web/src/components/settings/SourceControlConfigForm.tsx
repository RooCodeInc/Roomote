'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SetupSourceControlStatus } from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import { Button, Check, Input, Spinner } from '@/components/system';

const MASKED_VALUE = '••••••••••••••••••••••••••••';

type SourceControlField =
  SetupSourceControlStatus['providers'][number]['fields'][number];

function isSecretSourceControlField(field: Pick<SourceControlField, 'secret'>) {
  return field.secret === true;
}

function getNonSecretFieldInitialValues(
  fields: readonly SourceControlField[],
): Record<string, string> {
  const next: Record<string, string> = {};

  for (const field of fields) {
    if (isSecretSourceControlField(field) || field.runtimeSatisfied) {
      continue;
    }

    const savedValue = field.savedValue?.trim();
    if (savedValue) {
      next[field.envVarName] = savedValue;
    }
  }

  return next;
}

export function SourceControlConfigForm({
  provider,
  configStatus,
  onSaved,
  saveSuccessMessage,
}: {
  provider: SetupSourceControlStatus['preselectedProvider'];
  configStatus: SetupSourceControlStatus | undefined;
  onSaved?: () => void;
  saveSuccessMessage?: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const providerStatus = useMemo(
    () =>
      configStatus?.providers.find(
        (candidate) => candidate.provider === provider,
      ),
    [configStatus, provider],
  );

  // Key off field content, not array identity — query/refetch creates a new
  // fields array each time and must not wipe in-progress edits.
  const nonSecretInitialValuesKey = (providerStatus?.fields ?? [])
    .filter((field) => !isSecretSourceControlField(field))
    .map(
      (field) =>
        `${field.envVarName}:${field.savedValue ?? ''}:${field.savedSatisfied}:${field.runtimeSatisfied}`,
    )
    .join('|');
  const nonSecretInitialValues = useMemo(
    () => getNonSecretFieldInitialValues(providerStatus?.fields ?? []),
    // fields array identity is intentionally omitted; content key drives updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed
    [nonSecretInitialValuesKey],
  );
  const [values, setValues] = useState<Record<string, string>>(
    () => nonSecretInitialValues,
  );
  const [editingSavedValues, setEditingSavedValues] = useState<
    Record<string, boolean>
  >({});

  const saveConfig = useMutation(
    trpc.sourceControl.saveConfig.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.sourceControl.configStatus.queryKey(),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.sourceControl.repositories.queryKey(),
        });
        setEditingSavedValues({});
        toast.success(
          saveSuccessMessage ?? 'Source-control configuration saved.',
        );
        onSaved?.();
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  useEffect(() => {
    setValues(nonSecretInitialValues);
    setEditingSavedValues({});
  }, [provider, nonSecretInitialValues]);

  if (!providerStatus) {
    return null;
  }

  const isActionDisabled =
    saveConfig.isPending ||
    providerStatus.fields.some((field) => {
      const nextValue = values[field.envVarName]?.trim() ?? '';
      return (
        field.required !== false &&
        !field.runtimeSatisfied &&
        !field.savedSatisfied &&
        nextValue.length === 0
      );
    });

  const hasNewValues = providerStatus.fields.some((field) => {
    if (field.runtimeSatisfied) {
      return false;
    }
    const nextValue = values[field.envVarName]?.trim() ?? '';
    if (!isSecretSourceControlField(field)) {
      return nextValue !== (field.savedValue?.trim() ?? '');
    }
    return nextValue.length > 0;
  });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {providerStatus.fields.map((field) => {
          const value = values[field.envVarName] ?? '';
          const isSecretField = isSecretSourceControlField(field);
          const shouldShowSavedValueMask =
            isSecretField &&
            !field.runtimeSatisfied &&
            field.savedSatisfied &&
            value.length === 0 &&
            !editingSavedValues[field.envVarName];

          return (
            <div
              key={field.envVarName}
              className="grid max-w-xl gap-2 md:grid-cols-[180px_minmax(0,1fr)] md:items-center"
            >
              <div className="text-sm font-medium">
                {field.label}
                {field.required === false ? ' (optional)' : ''}
              </div>
              <div className="flex items-center gap-2">
                <Input
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
                      setEditingSavedValues((current) => ({
                        ...current,
                        [field.envVarName]: true,
                      }));
                    }
                  }}
                  onBlur={() => {
                    if (
                      isSecretField &&
                      field.savedSatisfied &&
                      value.length === 0
                    ) {
                      setEditingSavedValues((current) => ({
                        ...current,
                        [field.envVarName]: false,
                      }));
                    }
                  }}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.envVarName]: event.target.value,
                    }))
                  }
                  placeholder={field.runtimeSatisfied ? '' : field.envVarName}
                  disabled={saveConfig.isPending || field.runtimeSatisfied}
                  data-1p-ignore
                />
                {(field.runtimeSatisfied || field.savedSatisfied) && <Check />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => saveConfig.mutate({ provider, values })}
          disabled={isActionDisabled}
        >
          {saveConfig.isPending ? <Spinner /> : null}
          {hasNewValues ? 'Save configuration' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
