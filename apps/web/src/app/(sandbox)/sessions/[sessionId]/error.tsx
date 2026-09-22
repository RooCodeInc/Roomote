'use client';

import { RetryableLoadError } from '@/components/system';

export default function SessionDetailError({ retry }: { retry: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background p-6">
      {/* `retry` refetches the server component tree before clearing the
          boundary; `reset` alone would only re-render the failed state. */}
      <RetryableLoadError
        message="Unable to load this session"
        onRetry={retry}
      />
    </div>
  );
}
