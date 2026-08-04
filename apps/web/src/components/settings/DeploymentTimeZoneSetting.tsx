'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { formatTimeZone } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import {
  Button,
  Check,
  ChevronsUpDown,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Sun,
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
  const [isEditing, setIsEditing] = useState(false);
  const [isTimeZonePickerOpen, setIsTimeZonePickerOpen] = useState(false);

  useEffect(() => {
    if (settings.data) {
      setTimeZone(settings.data.timeZone ?? settings.data.effectiveTimeZone);
    }
  }, [settings.data]);

  const update = useMutation(
    trpc.miscSettings.setTimeZone.mutationOptions({
      onSuccess: async () => {
        toast.success('Scheduling timezone updated');
        setIsEditing(false);
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

  const effectiveTimeZone = settings.data?.effectiveTimeZone ?? 'UTC';

  if (settings.isPending) {
    return <Skeleton className="h-5 w-64" />;
  }

  if (!isEditing) {
    return (
      <div className="flex gap-1 items-center text-sm text-muted-foreground">
        <Sun className="size-4" />
        <p>
          Scheduling timezone:{' '}
          <span className="font-medium text-foreground">
            {formatTimeZone(effectiveTimeZone)}
          </span>{' '}
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => setIsEditing(true)}
          >
            Edit
          </Button>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label>Scheduling timezone</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Popover
          open={isTimeZonePickerOpen}
          onOpenChange={setIsTimeZonePickerOpen}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              role="combobox"
              aria-label="Scheduling timezone"
              aria-expanded={isTimeZonePickerOpen}
              className="w-full justify-between font-normal sm:w-80"
            >
              <span className="truncate">{formatTimeZone(timeZone)}</span>
              <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-(--radix-popover-trigger-width) p-0"
          >
            <Command>
              <CommandInput placeholder="Search timezones..." />
              <CommandList>
                <CommandEmpty>No timezones found.</CommandEmpty>
                <CommandGroup>
                  {supportedTimeZones().map((value) => (
                    <CommandItem
                      key={value}
                      value={value}
                      keywords={[formatTimeZone(value)]}
                      onSelect={() => {
                        setTimeZone(value);
                        setIsTimeZonePickerOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          'mr-2 size-4',
                          value === timeZone ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <span className="truncate">{formatTimeZone(value)}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
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
        <Button
          variant="ghost"
          disabled={update.isPending}
          onClick={() => {
            setTimeZone(
              settings.data?.timeZone ??
                settings.data?.effectiveTimeZone ??
                'UTC',
            );
            setIsEditing(false);
          }}
        >
          Cancel
        </Button>
      </div>
      {settings.data?.timeZoneSource !== 'explicit' ? (
        <p className="text-xs text-muted-foreground">
          Save to pin this timezone for the deployment.
        </p>
      ) : null}
    </div>
  );
}
