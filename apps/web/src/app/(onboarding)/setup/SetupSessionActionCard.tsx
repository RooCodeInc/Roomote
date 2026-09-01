'use client';

import type { ReactNode } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/system';

/**
 * The shared, trusted action surface for work the administrator completes
 * while talking with Roomote during the first setup session.
 *
 * Keep the explanatory copy here, and let the body focus on the controls and
 * state needed to complete the action. The setup agent should point to a card
 * instead of repeating its title, introduction, or option catalog in chat.
 */
export function SetupSessionActionCard({
  title,
  icon,
  intro,
  children,
}: {
  title: string;
  icon: ReactNode;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card variant="snug" className="border-primary/30 bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <span className="text-muted-foreground" aria-hidden="true">
            {icon}
          </span>
          {title}
        </CardTitle>
        <CardDescription>{intro}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
