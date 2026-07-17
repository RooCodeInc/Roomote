'use client';

import Image from 'next/image';
import { PRODUCT_NAME } from '@roomote/types';

import { RoomoteWordmark } from '@/components/layout';
import { ArrowRight, Button } from '@/components/system';

import { markSetupWelcomeSeen } from './welcome-seen';

type StepWelcomeProps = {
  isOnboarding?: boolean;
  onContinue: () => void;
};

export function StepWelcome({
  isOnboarding = false,
  onContinue,
}: StepWelcomeProps) {
  return (
    <div className="relative w-full max-w-lg space-y-6 py-2 md:py-0">
      <Image
        src="/elements/welcome.png"
        alt=""
        width={160}
        height={129}
        className="relative -left-4 block max-w-40 md:-left-6"
      />
      <h2 className="relative flex flex-wrap items-center gap-2 text-3xl font-bold tracking-tighter">
        <span>Welcome to</span>
        <span className="hidden md:inline">Roomote!</span>
        <RoomoteWordmark className="inline-block md:hidden" />
      </h2>
      <p>
        {PRODUCT_NAME} is your very own coding agent. Ask questions, parallelize
        tasks, fix bugs, churn through chores, setup proactive work and more.
      </p>
      {isOnboarding ? (
        <p>
          You don&apos;t even need to be an engineer. {PRODUCT_NAME} runs in
          isolated sandboxes and verifies its own work, so it doesn&apos;t
          blindly break things. You can be confident you&apos;re having an
          impact and not making mistakes.
        </p>
      ) : null}
      <Button
        size="default"
        onClick={() => {
          markSetupWelcomeSeen();
          onContinue();
        }}
      >
        Get started
        <ArrowRight />
      </Button>
    </div>
  );
}
