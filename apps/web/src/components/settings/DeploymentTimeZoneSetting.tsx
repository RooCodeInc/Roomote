'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

const FALLBACK_TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

function supportedTimeZones(): string[] {
  const supportedValuesOf = (
    Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
  ).supportedValuesOf;
  return Array.from(
    new Set([
      'UTC',
      ...(supportedValuesOf?.('timeZone') ?? FALLBACK_TIME_ZONES),
    ]),
  );
}

export function DeploymentTimeZoneSetting() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.miscSettings.get.queryOptions());
  const [timeZone, setTimeZone] = useState('UTC');

  useEffect(() => {
    if (settings.data) {
      setTimeZone(settings.data.timeZone ?? settings.data.effectiveTimeZone);
    }
  }, [settings.data]);

  const update = useMutation(
    trpc.miscSettings.setTimeZone.mutationOptions({
      onSuccess: async () => {
        toast.success('Scheduling timezone updated');
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.miscSettings.get.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.automations.getSettings.queryKey(),
          }),
        ]);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <Label>Scheduling timezone</Label>
        <p className="text-sm text-muted-foreground">
          All scheduled automations and natural-language schedules use this
          timezone.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={timeZone} onValueChange={setTimeZone}>
          <SelectTrigger className="sm:w-80" aria-label="Scheduling timezone">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {supportedTimeZones().map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={
            update.isPending ||
            !settings.data ||
            timeZone === settings.data.timeZone
          }
          onClick={() => update.mutate({ timeZone })}
        >
          Save timezone
        </Button>
      </div>
      {settings.data?.timeZoneSource !== 'explicit' ? (
        <p className="text-xs text-muted-foreground">
          Currently inferred as {settings.data?.effectiveTimeZone ?? 'UTC'}.
          Save to pin it for this deployment.
        </p>
      ) : null}
    </div>
  );
}
