import Link from 'next/link';

import { ArrowRight, Button, Check } from '@/components/system';
import { Message, MessageContent } from '@/components/ai-elements';

export function OnboardingCompletionMessage({
  environmentName,
}: {
  environmentName: string;
}) {
  return (
    <Message from="assistant">
      <MessageContent>
        <div className="flex flex-wrap items-start gap-2 text-sm bg-card px-4 pt-2 pb-4 rounded-lg max-w-xl">
          <Check className="size-4 shrink-0 mt-2.5" />
          <div>
            <p className="font-medium">
              The {environmentName} environment is set up.
            </p>
            <p>You can start your first task now.</p>
            <Button asChild size="sm">
              <Link href="/">
                Go
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}
