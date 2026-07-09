'use client';

import { useEffect, useState } from 'react';
import type { SetupComputeStatus } from '@roomote/types';

import {
  Button,
  Check,
  Container,
  Info,
  Input,
  Spinner,
  Trash2,
} from '@/components/system';

import { Section } from './Section';

type ComputeWorkerImageStatus = SetupComputeStatus['workerImage'];

type ComputeWorkerImageSectionProps = {
  workerImage: ComputeWorkerImageStatus;
  onSave: (value: string) => void;
  onClear: () => void;
  savePending: boolean;
  clearPending: boolean;
};

/**
 * Shared hosted-compute worker image section. Hosted providers (Modal, E2B,
 * Daytona) derive or provision their worker base image from this value, so it
 * is configured once, above the provider sections. A process env value locks
 * the field.
 */
export function ComputeWorkerImageSection({
  workerImage,
  onSave,
  onClear,
  savePending,
  clearPending,
}: ComputeWorkerImageSectionProps) {
  const [value, setValue] = useState('');

  useEffect(() => {
    setValue('');
  }, [workerImage.runtimeSatisfied, workerImage.savedSatisfied]);

  const trimmed = value.trim();
  const isRuntimeLocked = workerImage.runtimeSatisfied;
  const displayedValue =
    isRuntimeLocked && workerImage.hostedImageRef
      ? workerImage.hostedImageRef
      : value;

  return (
    <Section
      icon={<Container className="size-4 shrink-0" />}
      title="Hosted sandbox worker image"
    >
      <div className="max-w-xl space-y-3">
        <p className="text-sm text-muted-foreground">
          Hosted sandbox providers start tasks from this Roomote worker image.
          Use an image tag they can pull, such as a public GHCR image or one
          they have credentials for.
        </p>
        <div className="flex items-center gap-2">
          <Input
            className="font-mono"
            value={displayedValue}
            onChange={(event) => setValue(event.target.value)}
            placeholder={
              !isRuntimeLocked &&
              workerImage.savedSatisfied &&
              workerImage.hostedImageRef
                ? workerImage.hostedImageRef
                : 'ghcr.io/roocodeinc/roomote-worker:tag'
            }
            disabled={isRuntimeLocked || savePending}
            data-1p-ignore
          />
          {(workerImage.runtimeSatisfied || workerImage.savedSatisfied) && (
            <Check />
          )}
        </div>
        {isRuntimeLocked ? (
          <div className="flex items-start gap-2 text-muted-foreground">
            <Info className="inline size-4 mt-0.5 shrink-0" />
            <p className="text-sm">
              The worker image is set via an environment variable and can&apos;t
              be overridden here.
            </p>
          </div>
        ) : (
          <>
            {!workerImage.hostedReady ? (
              <div className="flex items-start gap-2 text-muted-foreground">
                <Info className="inline size-4 mt-0.5 shrink-0" />
                <p className="text-sm">
                  No registry-qualified worker image is configured yet. Set one
                  to enable hosted providers.
                </p>
              </div>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {workerImage.savedSatisfied ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onClear}
                  disabled={clearPending}
                >
                  <Trash2 />
                  {clearPending ? 'Removing...' : 'Remove'}
                  {clearPending ? <Spinner /> : null}
                </Button>
              ) : null}
              <Button
                type="button"
                onClick={() => onSave(trimmed)}
                disabled={trimmed.length === 0 || savePending}
              >
                <Check />
                {savePending ? 'Saving...' : 'Save'}
                {savePending ? <Spinner /> : null}
              </Button>
            </div>
          </>
        )}
      </div>
    </Section>
  );
}
