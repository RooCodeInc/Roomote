'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Gift, Plug } from 'lucide-react';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { ArrowRight, Button, Spinner } from '@/components/system';
import { cn } from '@/lib/utils';

import { StepTitle } from './StepTitle';
import { SetupFooter } from './SetupFooter';
import { getSetupStepDefinition } from './types';

const INFERENCE_STEP = getSetupStepDefinition('inference');

export function StepConfigureInference({
  onUseTrial,
  onConfigureProvider,
  onBack,
}: {
  cloudEnabled: boolean;
  onUseTrial: () => void;
  onConfigureProvider: () => void;
  onBack?: () => void;
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
          Your Roomote Cloud trial includes $5 of inference to try things out,
          or you can configure your own provider directly.
        </p>
        <p>
          Some Roomote functionality uses fast judgement models, not just LLMs.
          You can use the Roomote provider model for free, or configure your own
          (TypeSafe Jev, OpenRouter, Vercel).
        </p>
        <p>The Roomote provider never retains your data.</p>

        <div className="space-y-0.5 max-w-sm">
          <Button
            type="button"
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
              Use the Roomote provider
            </span>
            <ArrowRight />
          </Button>
          <Button
            type="button"
            variant="default"
            className={choiceButtonClassName}
            disabled={chooseTrialInference.isPending}
            onClick={onConfigureProvider}
          >
            <Plug className="size-4 shrink-0" />
            <span className="font-medium grow text-left">
              Configure my own provider
            </span>
            <ArrowRight />
          </Button>
        </div>

        <SetupFooter onBack={onBack} />
      </div>
    </div>
  );
}
