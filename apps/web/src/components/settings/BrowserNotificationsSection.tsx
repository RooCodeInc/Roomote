'use client';

import { useEffect, useState } from 'react';

import { BellElectric, Button } from '@/components/system';
import {
  getBrowserNotificationCapability,
  type BrowserNotificationCapability,
} from '@/lib/browser-notifications';
import { useBrowserNotificationsExperiment } from '@/hooks/useBrowserNotificationsExperiment';

import { Section } from './Section';

export function BrowserNotificationsSection() {
  const { enabled } = useBrowserNotificationsExperiment();
  const [capability, setCapability] =
    useState<BrowserNotificationCapability>('unsupported');

  useEffect(() => {
    setCapability(getBrowserNotificationCapability());
  }, []);

  if (!enabled) return null;

  return (
    <Section icon={BellElectric} title="Browser notifications">
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Desktop notifications can alert you while an open Session or task page
          is in the background. Closed-page push is not supported.
        </p>
        {capability === 'default' ? (
          <Button
            size="sm"
            onClick={() => {
              void Notification.requestPermission().then(setCapability);
            }}
          >
            Enable notifications
          </Button>
        ) : (
          <p className="font-medium">
            {capability === 'granted'
              ? 'Enabled in this browser'
              : capability === 'denied'
                ? 'Blocked in browser settings'
                : 'Not supported in this browser'}
          </p>
        )}
      </div>
    </Section>
  );
}
