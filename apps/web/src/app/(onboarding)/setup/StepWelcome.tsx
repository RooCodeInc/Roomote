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
    <div className="relative w-full max-w-xl space-y-6 py-2 md:py-0">
      <Image
        src="/elements/welcome.png"
        alt=""
        width={160}
        height={129}
        className="relative -left-4 block max-w-40 md:-left-6"
      />
      <h2 className="relative flex flex-wrap items-center gap-2 text-3xl font-bold tracking-tighter">
        <span>Welcome to</span>
        <span className="hidden md:inline">{PRODUCT_NAME}!</span>
        <RoomoteWordmark className="inline-block md:hidden" />
      </h2>
      <div className="space-y-2">
        {isOnboarding ? (
          <>
            <p className="font-semibold">Your autonomous coding agent.</p>
            <p>
              You don&apos;t even need to be an engineer. {PRODUCT_NAME} runs in
              isolated sandboxes and verifies its own work, so it doesn&apos;t
              blindly break things. You can be confident you&apos;re having an
              impact and not making mistakes.
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold">For setup, we'll:</p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Create your admin account for this deployment</li>
              <li>Connect to your inference provider</li>
              <li>Connect to source control (where your code lives)</li>
            </ol>
            <p>
              It takes 2 minutes and everything is stored securely in your
              deployment.
            </p>
          </>
        )}
      </div>
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
