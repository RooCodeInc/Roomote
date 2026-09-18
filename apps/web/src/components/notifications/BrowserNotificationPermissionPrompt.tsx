'use client';

import { BellElectric, Button, X } from '@/components/system';

export function BrowserNotificationPermissionPrompt({
  onEnable,
  onDismiss,
}: {
  onEnable: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-xl border bg-background p-4 shadow-lg">
      <div className="flex items-start gap-3">
        <BellElectric className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="font-medium">Get notified when Roomote is ready</p>
            <p className="text-sm text-muted-foreground">
              Allow desktop notifications while this Session or task page stays
              open in the background.
            </p>
          </div>
          <Button size="sm" onClick={onEnable}>
            Enable notifications
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Dismiss notification permission prompt"
          onClick={onDismiss}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
