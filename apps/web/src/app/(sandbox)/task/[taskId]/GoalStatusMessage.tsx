import type { TaskGoalStatus } from '@roomote/types';

import { CircleAlert, CircleCheck, LoaderCircle } from '@/components/system';
import { Message, MessageContent } from '@/components/ai-elements';

interface GoalStatusMessageProps {
  objective: string;
  status: TaskGoalStatus;
  blockedReason?: string | null;
}

export function GoalStatusMessage({
  objective,
  status,
  blockedReason,
}: GoalStatusMessageProps) {
  const presentation = (() => {
    switch (status) {
      case 'active':
        return {
          label: 'Pursuing goal',
          Icon: LoaderCircle,
          iconClassName: 'animate-spin text-primary',
        };
      case 'complete':
        return {
          label: 'Goal completed',
          Icon: CircleCheck,
          iconClassName: 'text-green-600 dark:text-green-500',
        };
      case 'blocked':
        return {
          label: 'Goal blocked',
          Icon: CircleAlert,
          iconClassName: 'text-amber-500',
        };
      case 'budget_limited':
        return {
          label: 'Goal continuation limit reached',
          Icon: CircleAlert,
          iconClassName: 'text-amber-500',
        };
    }
  })();
  const { Icon } = presentation;

  return (
    <Message from="assistant">
      <MessageContent>
        <div
          className="flex items-start gap-2 text-sm animate-in fade-in duration-300"
          data-testid="goal-status"
          {...(status === 'active'
            ? { role: 'status', 'aria-live': 'polite' as const }
            : {})}
        >
          <Icon
            className={`mt-0.5 size-4 shrink-0 ${presentation.iconClassName}`}
          />
          <div className="min-w-0 space-y-1">
            <div className="font-medium">{presentation.label}</div>
            <div className="text-muted-foreground whitespace-pre-wrap wrap-break-word">
              {objective}
            </div>
            {blockedReason ? (
              <div className="whitespace-pre-wrap wrap-break-word">
                {blockedReason}
              </div>
            ) : null}
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}
