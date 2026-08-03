'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey, UseMutationOptions } from '@tanstack/react-query';
import { toast } from 'sonner';

/**
 * Shared lifecycle for OAuth device-code connect dialogs (ChatGPT, xAI,
 * GitHub Copilot). The dialogs supply provider-specific config (mutations,
 * query keys, copy) and render the result; this hook owns the polling loop.
 *
 * Lifecycle semantics follow the hardened ChatGPT dialog (expiry deadline,
 * failure reasons, slow-down backoff, rejected-poll surfacing). Cancellation
 * uses the xAI dialog's monotonic generation counter rather than a shared
 * boolean: cancel + reopen can flip a boolean back to true and revive a stale
 * loop that still holds the previous device code, while a retired generation
 * can never match again.
 */

/** Minimum shape every provider's start mutation must resolve to. */
type DeviceCodeStartResult = {
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  /**
   * Relative validity window rather than an absolute timestamp so clock skew
   * between server and browser cannot expire a code early or late.
   */
  expiresInMs: number;
};

/**
 * Why a poll ended terminally. `blocked` is a refusal waiting cannot resolve
 * (e.g. an org policy blocking the OAuth app); `expired` means the code aged
 * out, whether reported by the issuer or by the client-side deadline.
 */
type DeviceCodePollFailureReason = 'blocked' | 'expired';

type DeviceCodePollResult =
  | { status: 'pending'; intervalMs?: number }
  | { status: 'success' }
  | { status: 'failed'; error: string; reason?: DeviceCodePollFailureReason };

type StartMutationHandlers<TAuth> = {
  onSuccess: (result: TAuth) => void;
  onError: (error: unknown) => void;
};

type UseDeviceCodeFlowConfig<
  TAuth extends DeviceCodeStartResult,
  TPollInput,
> = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Invoked once after a successful connect, after query invalidations. */
  onConnected?: () => void | Promise<void>;
  /**
   * Build the start mutation's options with the hook's handlers attached,
   * e.g. `(handlers) => trpc.x.startDeviceAuth.mutationOptions(handlers)`.
   * The handlers must reach the returned options untouched; the hook relies
   * on them to receive the device auth result.
   *
   * Typed as `object` rather than tanstack's `UseMutationOptions` because
   * tRPC's generated option type carries its own error and context generics
   * that do not structurally assign to the plain tanstack shape; the runtime
   * contract is identical and the hook casts at the `useMutation` boundary.
   */
  startMutationOptions: (handlers: StartMutationHandlers<TAuth>) => object;
  /** Build the poll mutation's options, with no handlers attached. */
  pollMutationOptions: () => object;
  /** Map the start result to the poll mutation's input payload. */
  getPollInput: (auth: TAuth) => TPollInput;
  /** Query keys to invalidate after a successful connect. */
  invalidateQueryKeys: () => QueryKey[];
  successToast: string;
  copy: {
    /** Shown when the client-side expiry deadline passes. */
    expired: string;
    /** Fallback when the start mutation rejects without an Error message. */
    startFailed: string;
    /** Fallback when a poll rejects without an Error message. */
    pollFailed: string;
  };
};

export function useDeviceCodeFlow<
  TAuth extends DeviceCodeStartResult,
  TPollInput,
>(config: UseDeviceCodeFlowConfig<TAuth, TPollInput>) {
  const {
    open,
    onOpenChange,
    onConnected,
    getPollInput,
    invalidateQueryKeys,
    successToast,
    copy,
  } = config;
  const queryClient = useQueryClient();
  const [deviceAuth, setDeviceAuth] = useState<TAuth | null>(null);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failureReason, setFailureReason] =
    useState<DeviceCodePollFailureReason | null>(null);
  /**
   * Monotonic generation bumped whenever every in-flight poll loop must die
   * (close, restart, terminal outcome, effect cleanup). A loop only acts
   * while its own generation is still current.
   */
  const generationRef = useRef(0);

  const startMutation = useMutation(
    config.startMutationOptions({
      onSuccess: (result) => {
        setDeviceAuth(result);
        setError(null);
      },
      onError: (startError) => {
        setError(
          startError instanceof Error ? startError.message : copy.startFailed,
        );
      },
    }) as UseMutationOptions<TAuth, Error, void>,
  );

  // Poll results drive the loop below rather than mutation callbacks, so a
  // single code path owns both stopping the loop and reporting the outcome.
  const pollMutation = useMutation(
    config.pollMutationOptions() as UseMutationOptions<
      DeviceCodePollResult,
      Error,
      TPollInput
    >,
  );

  useEffect(() => {
    if (!open) {
      generationRef.current += 1;
      setPolling(false);
      setDeviceAuth(null);
      setError(null);
      setFailureReason(null);
      return;
    }

    // Only auto-start the device-code flow once per open. Guard on
    // startMutation.isError so a failed start does not re-fire on the next
    // render (deviceAuth stays null and isPending returns to false, which
    // would otherwise loop with no backoff). The user clicks Restart to
    // retry explicitly.
    if (!deviceAuth && !startMutation.isPending && !startMutation.isError) {
      startMutation.mutate();
    }
  }, [open, deviceAuth, startMutation]);

  useEffect(() => {
    if (!open || !deviceAuth) {
      return;
    }

    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    // The issuer stops accepting the code at this deadline; polling past it
    // can never succeed.
    const expiresAt = Date.now() + deviceAuth.expiresInMs;
    setPolling(true);

    const fail = (
      message: string,
      reason: DeviceCodePollFailureReason | null = null,
    ) => {
      generationRef.current += 1;
      setPolling(false);
      setError(message);
      setFailureReason(reason);
    };

    const poll = async () => {
      let intervalMs = deviceAuth.intervalMs;

      while (isCurrent()) {
        if (Date.now() >= expiresAt) {
          fail(copy.expired, 'expired');
          return;
        }

        const result = await pollMutation.mutateAsync(getPollInput(deviceAuth));

        // Another open/close/restart may have started while we awaited.
        if (!isCurrent()) {
          return;
        }

        if (result.status === 'success') {
          // Retire this loop before the awaits below so a slow invalidation
          // cannot overlap a restarted flow.
          generationRef.current += 1;
          setPolling(false);
          toast.success(successToast);
          await Promise.all(
            invalidateQueryKeys().map((queryKey) =>
              queryClient.invalidateQueries({ queryKey }),
            ),
          );
          await onConnected?.();
          onOpenChange(false);
          return;
        }

        if (result.status === 'failed') {
          fail(result.error, result.reason ?? null);
          return;
        }

        // A slow-down/rate-limited poll returns the new absolute interval to
        // back off to, not a delta.
        if (result.intervalMs) {
          intervalMs = result.intervalMs;
        }

        const remainingMs = expiresAt - Date.now();
        if (remainingMs <= 0) {
          fail(copy.expired, 'expired');
          return;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(intervalMs, remainingMs)),
        );
      }
    };

    void poll().catch((pollError: unknown) => {
      // A stale loop's rejection must not clobber a newer flow's state.
      if (!isCurrent()) {
        return;
      }
      fail(pollError instanceof Error ? pollError.message : copy.pollFailed);
    });

    return () => {
      // Invalidate only this effect's generation when deviceAuth/open change.
      if (isCurrent()) {
        generationRef.current += 1;
      }
    };
    // The polling lifecycle is intentionally keyed only to the active device
    // flow; mutation/query objects are recreated by hooks between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deviceAuth]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      generationRef.current += 1;
      setPolling(false);
    }
    onOpenChange(next);
  }

  function restart() {
    generationRef.current += 1;
    setPolling(false);
    setDeviceAuth(null);
    setError(null);
    setFailureReason(null);
    // Clear the prior failed mutation state so the start effect can fire
    // again, then kick off a fresh device-code request.
    startMutation.reset();
    startMutation.mutate();
  }

  return {
    deviceAuth,
    error,
    failureReason,
    polling,
    isStartPending: startMutation.isPending,
    handleOpenChange,
    restart,
  };
}
