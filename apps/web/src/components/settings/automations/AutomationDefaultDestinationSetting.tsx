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
/** Recipient a saved DM or Email default is bound to. */
type DestinationOwner = { name: string | null; isViewer: boolean };

export function AutomationDefaultDestinationSetting({
  value,
  savedValue,
  savedOwner,
  error,
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
  savedOwner: DestinationOwner | null;
  error?: string;
  availableProviders: readonly DestinationProvider[];
  slackOptions: DestinationOption[];
  discordOptions: DestinationOption[];
  emailOptions: DestinationOption[];
  isDirty: boolean;
  isSaving: boolean;
  onChange: (value: AutomationDestinationValue) => void;
  /** `onSaved` runs only once the server accepted the destination. */
  onSave: (onSaved: () => void) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = formatDestination(
    savedValue,
    savedOwner,
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
            noneDescription=""
            disabled={isSaving}
            onChange={onChange}
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
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
              onClick={() => onSave(() => setOpen(false))}
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
  owner: DestinationOwner | null,
  slackOptions: DestinationOption[],
  discordOptions: DestinationOption[],
  emailOptions: DestinationOption[],
) {
  if (value.provider === 'none') return 'Not configured';
  // DM and Email defaults belong to the admin who saved them.
  const recipient =
    !owner || owner.isViewer ? 'you' : (owner.name ?? 'another admin');
  if (value.provider === 'email') {
    // Another admin's identity is not in the viewer's own email options.
    if (owner && !owner.isViewer) return `Email to ${recipient}`;
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
    return `${label} DM to ${recipient}`;
  }
  const option = (
    value.provider === 'slack' ? slackOptions : discordOptions
  ).find((candidate) => candidate.id === value.channelId);
  return option?.label ?? value.channelId;
}
