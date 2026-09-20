'use client';

import { RetryableLoadError } from '@/components/system';

export default function SessionDetailError({ reset }: { reset: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background p-6">
      <RetryableLoadError
        message="Unable to load this session"
        onRetry={reset}
      />
    </div>
  );
}
