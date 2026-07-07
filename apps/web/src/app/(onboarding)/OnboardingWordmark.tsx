'use client';

import { RoomoteWordmark } from '@/components/layout/RoomoteWordmark';

type OnboardingWordmarkProps = {
  className?: string;
};

export function OnboardingWordmark({ className }: OnboardingWordmarkProps) {
  return <RoomoteWordmark className={className} />;
}
