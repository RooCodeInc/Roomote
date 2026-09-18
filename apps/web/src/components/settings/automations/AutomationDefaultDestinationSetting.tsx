'use client';

import { useState } from 'react';
import type { AutomationDestinationProvider as DestinationProvider } from '@roomote/types';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SendHorizontal,
} from '@/components/system';

import {
  AutomationDestinationPicker,
  type AutomationDestinationValue,
} from './AutomationDestinationPicker';

type DestinationOption = { id: string; name: string; label: string };

export function AutomationDefaultDestinationSetting({
  value,
  savedValue,
  availableProviders,
  slackOptions,
  discordOptions,
  emailOptions,
  isDirty,
  isSaving,
  onChange,
  onSave,
  onReset,
}: {
  value: AutomationDestinationValue;
  savedValue: AutomationDestinationValue;
  availableProviders: readonly DestinationProvider[];
  slackOptions: DestinationOption[];
  discordOptions: DestinationOption[];
  emailOptions: DestinationOption[];
  isDirty: boolean;
  isSaving: boolean;
  onChange: (value: AutomationDestinationValue) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = formatDestination(
    savedValue,
    slackOptions,
    discordOptions,
    emailOptions,
  );

  return (
    <>
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <SendHorizontal className="size-4" />
        <p>
          Default destination:{' '}
          <span className="font-medium text-foreground">{summary}</span>{' '}
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => setOpen(true)}
          >
            {savedValue.provider === 'none' ? 'Select' : 'Edit'}
          </Button>
        </p>
      </div>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && isDirty) onReset();
          setOpen(nextOpen);
        }}
      >
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Default destination</DialogTitle>
            <DialogDescription>
              Used when an automation has no explicit destination. Existing
              custom automations keep the destination selected when they were
              created.
            </DialogDescription>
          </DialogHeader>
          <AutomationDestinationPicker
            id="default-automation-destination"
            value={value}
            availableProviders={availableProviders}
            slackOptions={slackOptions}
            discordOptions={discordOptions}
            emailOptions={emailOptions}
            channelProviders={['slack', 'discord']}
            defaultSlackChannelId={slackOptions[0]?.id ?? ''}
            defaultDiscordChannelId={discordOptions[0]?.id ?? ''}
            defaultEmailIdentityId={emailOptions[0]?.id ?? ''}
            allowNone={false}
            noneLabel="Select a destination"
            noneDescription="No deployment default is configured. Select a channel, DM, or email address. Existing owner fallback remains unchanged."
            disabled={isSaving}
            onChange={onChange}
          />
          <DialogFooter>
            {savedValue.provider !== 'none' ? (
              <Button
                variant="ghost"
                disabled={isSaving}
                onClick={() =>
                  onChange({ provider: 'none', mode: 'channel', channelId: '' })
                }
              >
                Clear destination
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={isSaving}
              onClick={() => {
                onReset();
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={
                isSaving ||
                !isDirty ||
                (value.provider !== 'none' &&
                  value.mode === 'channel' &&
                  !value.channelId) ||
                (value.provider === 'email' && !value.channelId)
              }
              onClick={() => {
                onSave();
                setOpen(false);
              }}
            >
              Save destination
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatDestination(
  value: AutomationDestinationValue,
  slackOptions: DestinationOption[],
  discordOptions: DestinationOption[],
  emailOptions: DestinationOption[],
) {
  if (value.provider === 'none') return 'Not configured';
  if (value.provider === 'email') {
    return (
      emailOptions.find((option) => option.id === value.channelId)?.name ??
      'Email address'
    );
  }
  if (value.mode === 'direct_message') {
    const label =
      value.provider === 'slack'
        ? 'Slack'
        : value.provider === 'discord'
          ? 'Discord'
          : value.provider === 'teams'
            ? 'Teams'
            : 'Telegram';
    return `${label} DM to you`;
  }
  const option = (
    value.provider === 'slack' ? slackOptions : discordOptions
  ).find((candidate) => candidate.id === value.channelId);
  return option?.label ?? value.channelId;
}
