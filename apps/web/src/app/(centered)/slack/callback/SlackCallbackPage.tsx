'use client';

import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';

import { decodeRecord } from '@/lib';

import { useMount } from '@/hooks/useMount';
import { useTRPCClient } from '@/trpc/client';

import {
  CircleCheck,
  CircleX,
  AlertCircleIcon,
  Slack,
  Alert,
  AlertDescription,
} from '@/components/system';

export default function SlackCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();
  const trpcClient = useTRPCClient();

  const [isLoading, setIsLoading] = useState(true);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installMutation = useMutation({
    mutationFn: (args: { code: string; state: string }) =>
      trpcClient.slack.exchangeOAuthCode.mutate(args),
    onSuccess: (result) => {
      setIsSuccess(result.success);
      setIsLoading(false);

      if (!result.success) {
        setError(result.error);
      } else {
        router.push('/settings');
      }
    },
    onError: (error) => {
      setIsSuccess(false);
      setIsLoading(false);
      setError(error.message);
    },
  });

  const linkAccountMutation = useMutation({
    mutationFn: (args: { code: string; state: string }) =>
      trpcClient.slack.finishAuthenticateAccount.mutate(args),
    onSuccess: (result, _variables, _context) => {
      setIsSuccess(result.success);
      setIsLoading(false);

      if (!result.success) {
        setError(result.error);
      }
    },
    onError: (error) => {
      setIsSuccess(false);
      setIsLoading(false);
      setError(error.message);
    },
  });

  const isMounted = useRef(false);

  useMount(() => {
    if (isMounted.current) {
      return;
    }

    isMounted.current = true;

    const error = params.get('error');
    const code = params.get('code');
    const state = params.get('state');

    if (error) {
      setError(error);
      setIsLoading(false);
      return;
    }

    if (!code || !state) {
      setError('Failed to link Slack. Please try again.');
      setIsLoading(false);
      return;
    }

    const decodedRecord = decodeRecord<Record<string, string>>(state);
    let decodedState = decodedRecord as
      | { mode?: string; redirectPath?: string; redirect?: string }
      | undefined;

    if (!decodedState && state.includes('.')) {
      try {
        const [encodedPayload] = state.split('.');
        if (encodedPayload) {
          const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
          const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
          decodedState = JSON.parse(atob(padded)) as {
            mode?: string;
            redirectPath?: string;
            redirect?: string;
          };
        }
      } catch {
        decodedState = undefined;
      }
    }

    const isLinkAccountFlow = decodedState?.mode === 'link_account';

    if (isLinkAccountFlow) {
      linkAccountMutation.mutate(
        { code, state },
        {
          onSuccess: (result) => {
            if (result.success) {
              const redirect =
                decodedState?.redirectPath ?? decodedState?.redirect;
              const isValidRedirect =
                redirect &&
                redirect.startsWith('/') &&
                !redirect.startsWith('//') &&
                !redirect.includes('://');
              router.push(isValidRedirect ? redirect : '/settings');
            }
          },
        },
      );
    } else {
      installMutation.mutate({ code, state });
    }
  });

  return (
    <div className="flex flex-col items-center justify-center gap-2">
      <div className="flex items-center justify-center gap-2">
        {isLoading ? (
          <Slack className="animate-pulse" />
        ) : isSuccess ? (
          <CircleCheck className="text-green-500" />
        ) : (
          <CircleX className="text-rose-500" />
        )}
        <div className="text-sm">
          {isSuccess ? 'Slack Linked' : error ? 'Error' : 'Slack Linking...'}
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription className="max-w-sm line-clamp-5">
            {error}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
