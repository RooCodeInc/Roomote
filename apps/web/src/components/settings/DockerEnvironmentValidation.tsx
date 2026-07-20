'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';
import {
  Alert,
  AlertCircle,
  AlertDescription,
  Button,
  Check,
  Minus,
  Spinner,
} from '@/components/system';

type ValidationOutput = {
  status: 'completed' | 'unavailable';
  message?: string;
  result?: {
    ok: boolean;
    checks: Array<{
      id: string;
      status: 'pass' | 'fail' | 'skipped';
      message: string;
    }>;
  };
};

const CHECK_LABELS: Record<string, string> = {
  daemon: 'Docker daemon',
  worker_image: 'Worker image',
  release_archive: 'Worker release archive',
};

/**
 * On-demand Docker environment validation for self-host settings. Runs the
 * same checks the controller preflights before a spawn, so operators can find
 * boot blockers before their first task.
 */
export function DockerEnvironmentValidation() {
  const trpc = useTRPC();
  const [output, setOutput] = useState<ValidationOutput | null>(null);

  const validate = useMutation(
    trpc.compute.validateDockerEnvironment.mutationOptions({
      onSuccess: (data) => setOutput(data),
      onError: (error) =>
        setOutput({
          status: 'unavailable',
          message: error.message || 'Validation failed unexpectedly.',
        }),
    }),
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={validate.isPending}
          onClick={() => validate.mutate()}
        >
          {validate.isPending ? (
            <>
              <Spinner className="size-4" />
              Validating…
            </>
          ) : (
            'Validate environment'
          )}
        </Button>
        {validate.isPending && (
          <span className="text-sm text-muted-foreground">
            Checking the Docker daemon, worker image, and release archive. A
            first-time image pull can take a minute.
          </span>
        )}
      </div>

      {output?.status === 'unavailable' && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{output.message}</AlertDescription>
        </Alert>
      )}

      {output?.status === 'completed' && output.result && (
        <ul className="space-y-1.5 text-sm">
          {output.result.checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2">
              {check.status === 'pass' ? (
                <Check className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-500" />
              ) : check.status === 'fail' ? (
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              ) : (
                <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0">
                <span className="font-medium">
                  {CHECK_LABELS[check.id] ?? check.id}:
                </span>{' '}
                <span
                  className={
                    check.status === 'fail'
                      ? 'text-destructive wrap-break-word'
                      : 'text-muted-foreground wrap-break-word'
                  }
                >
                  {check.message}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
