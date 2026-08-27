'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Gift, Plug } from 'lucide-react';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { ArrowRight, Button, Spinner } from '@/components/system';
import { cn } from '@/lib/utils';

import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const INFERENCE_STEP = getSetupStepDefinition('inference');

export function StepConfigureInference({
  onUseTrial,
  onConfigureProvider,
}: {
  onUseTrial: () => void;
  onConfigureProvider: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const chooseTrialInference = useMutation(
    trpc.setupNew.chooseTrialInference.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        onUseTrial();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const choiceButtonClassName = cn(
    'group flex w-full items-center gap-3 py-5',
    'hover:text-accent-foreground hover:bg-foreground',
  );

  return (
    <div className="relative w-full max-w-2xl space-y-6 py-2 md:py-0">
      <StepTitle text={INFERENCE_STEP.title} />
      <div className="space-y-4 max-w-xl">
        <p>
          Roomote needs a model provider for, you know, AI stuff.
          <br />
          If you want, we can give you a few credits to try Roomote out or you
          can configure your provider directly.
        </p>

        <div className="space-y-0.5 max-w-sm">
          <Button
            type="button"
            size="sm"
            variant="default"
            className={choiceButtonClassName}
            disabled={chooseTrialInference.isPending}
            onClick={() => chooseTrialInference.mutate()}
          >
            {chooseTrialInference.isPending ? (
              <Spinner />
            ) : (
              <Gift className="size-4 shrink-0" />
            )}
            <span className="font-medium grow text-left">
              Use free Roomote trial inference
            </span>
            <ArrowRight />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="default"
            className={choiceButtonClassName}
            disabled={chooseTrialInference.isPending}
            onClick={onConfigureProvider}
          >
            <Plug className="size-4 shrink-0" />
            <span className="font-medium grow text-left">
              Configure your provider
            </span>
            <ArrowRight />
          </Button>
        </div>

        <p className="text-sm text-foreground/50">
          Roomote trial inference goes through OpenRouter.
        </p>
      </div>
    </div>
  );
}
