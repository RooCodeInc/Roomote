import type { ReactNode } from 'react';
import {
  DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
  type ChannelAutoStartLaunchMode,
} from '@roomote/types';

import type { ChannelAutoStartFormRow } from './formState';

import {
  Button,
  Input,
  Label,
  Plus,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  Trash2,
} from '@/components/system';
import {
  SlackChannelSelect,
  type SlackChannelOption,
} from './SlackChannelSelect';

type AutoRespondChannelTemplate = {
  channel: string;
  label: string;
  instructions: string;
};

export type ChannelAutoStartLaunchModeOption = {
  value: ChannelAutoStartLaunchMode;
  label: string;
  description: string;
  instructionsLabel: string;
  instructionsHint: string;
  instructionsPlaceholder: string;
};

const AUTO_RESPOND_CHANNEL_TEMPLATES: readonly AutoRespondChannelTemplate[] = [
  {
    channel: '#bugs',
    label: 'Bugs',
    instructions:
      'Treat each message as a bug report. Follow this sequence:\n1. Reproduce the issue first - find a minimal test case or steps that trigger the behavior.\n2. Read error messages, stack traces, and logs completely before forming a hypothesis.\n3. Check recent changes (git log, recent PRs) that could have introduced the regression.\n4. Trace the data flow backward from the symptom to the root cause - fix at the source, not the symptom.\n5. If the system has multiple components, add diagnostic instrumentation at each boundary to identify which layer breaks before proposing a fix.\n6. Propose a fix only after you can explain the root cause. Include a test that would have caught it.',
  },
  {
    channel: '#support-inbound',
    label: 'Support',
    instructions:
      "Treat each message as a support request from a customer or internal user. Understand the user's problem before jumping to solutions. Check documentation and known issues first. If it's a bug, reproduce it. If it's a misunderstanding, explain clearly. Escalate to a human if the request involves account changes, permissions, or access control.",
  },
  {
    channel: '#ask-engineering',
    label: 'Ask Engineering',
    instructions:
      'Treat each message as a technical question from a teammate. Search the codebase and documentation for the answer before responding. Provide code references (file paths, function names) when relevant. If the question requires a code change, propose it with context.',
  },
  {
    channel: '#ops-requests',
    label: 'Ops Requests',
    instructions:
      "Treat each message as an operational request. Assess urgency and impact first. For infrastructure issues, check monitoring dashboards and recent deployments. For access requests, verify the requester's permissions. Document actions taken.",
  },
] as const;

function createEmptyChannelAutoStartRow(): ChannelAutoStartFormRow {
  return {
    channelId: null,
    slackChannel: '',
    instructions: '',
    launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
    launchCriteria: '',
  };
}

export function createChannelAutoStartRowFromTemplate(
  template: Pick<AutoRespondChannelTemplate, 'channel' | 'instructions'>,
): ChannelAutoStartFormRow {
  return {
    channelId: null,
    slackChannel: template.channel,
    instructions: template.instructions,
    launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
    launchCriteria: '',
  };
}

export function getAvailableAutoRespondChannelTemplates(
  rows: ChannelAutoStartFormRow[] | null | undefined,
): AutoRespondChannelTemplate[] {
  const configuredChannels = new Set(
    (rows ?? [])
      .map((row) => row.slackChannel.trim().toLowerCase())
      .filter(Boolean),
  );

  return AUTO_RESPOND_CHANNEL_TEMPLATES.filter(
    (template) => !configuredChannels.has(template.channel.toLowerCase()),
  );
}

function getChannelAutoStartLaunchModeOption(
  value: ChannelAutoStartLaunchMode,
  launchModeOptions: ChannelAutoStartLaunchModeOption[],
) {
  const fallbackOption = launchModeOptions[0];

  if (!fallbackOption) {
    throw new Error('Missing channel auto-start launch mode options.');
  }

  return (
    launchModeOptions.find((option) => option.value === value) ?? fallbackOption
  );
}

type ChannelAutoStartEditorProps = {
  slackAppMention: string;
  rows: ChannelAutoStartFormRow[];
  launchModeOptions: ChannelAutoStartLaunchModeOption[];
  showLaunchModePicker: boolean;
  availableTemplates: AutoRespondChannelTemplate[];
  isEnabled: boolean;
  slackChannelOptions?: SlackChannelOption[];
  slackConnected?: boolean;
  warning?: ReactNode;
  channelFieldError?: string;
  instructionsFieldError?: string;
  onRowsChange: (rows: ChannelAutoStartFormRow[]) => void;
};

export function ChannelAutoStartEditor({
  slackAppMention,
  rows,
  launchModeOptions,
  showLaunchModePicker,
  availableTemplates,
  isEnabled: _isEnabled,
  slackChannelOptions,
  slackConnected = true,
  warning,
  channelFieldError,
  instructionsFieldError,
  onRowsChange,
}: ChannelAutoStartEditorProps) {
  const updateRow = (
    rowIndex: number,
    patch: Partial<ChannelAutoStartFormRow>,
  ) => {
    onRowsChange(
      rows.map((row, index) =>
        index === rowIndex ? { ...row, ...patch } : row,
      ),
    );
  };

  // Editing the channel invalidates any persisted channel ID, so drop it and
  // force the server to resolve the new value on save.
  const changeRowChannel = (rowIndex: number, slackChannel: string) => {
    updateRow(rowIndex, { slackChannel, channelId: null });
  };

  const addRow = (row: ChannelAutoStartFormRow) => {
    onRowsChange([...rows, row]);
  };
  const useSlackChannelSelect = Boolean(slackChannelOptions?.length);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 justify-between border-b pb-3">
        <p className="text-muted-foreground">
          {showLaunchModePicker
            ? `Add as many channels as you want, choose whether each one always starts a task or lets Roomote decide, and make sure ${slackAppMention} is in each one.`
            : `Add as many channels as you want. Just make sure ${slackAppMention} is in each one.`}
        </p>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => addRow(createEmptyChannelAutoStartRow())}
        >
          <Plus />
          Add channel
        </Button>
      </div>

      {rows.length > 0 ? (
        <div className="space-y-6 divide-y">
          {rows.map((row, index) => {
            const launchModeOption = getChannelAutoStartLaunchModeOption(
              row.launchMode,
              launchModeOptions,
            );

            return (
              <div
                key={`channel-auto-start-row-${index}`}
                className="space-y-4 pb-6"
              >
                <div className="space-y-2">
                  <Label htmlFor={`channel-auto-start-slack-channel-${index}`}>
                    Monitor this Slack channel
                  </Label>
                  <div className="flex gap-2 items-center justify-between">
                    {useSlackChannelSelect ? (
                      <SlackChannelSelect
                        id={`channel-auto-start-slack-channel-${index}`}
                        value={row.slackChannel || null}
                        onChange={(value) =>
                          changeRowChannel(index, value ?? '')
                        }
                        options={slackChannelOptions ?? []}
                        disabled={!slackConnected}
                        className="w-md"
                        placeholder={
                          slackConnected
                            ? 'Select a Slack channel'
                            : 'Connect Slack to choose a channel'
                        }
                      />
                    ) : (
                      <Input
                        id={`channel-auto-start-slack-channel-${index}`}
                        value={row.slackChannel}
                        onChange={(event) =>
                          changeRowChannel(index, event.target.value)
                        }
                        placeholder="#bugs or C123ABC456"
                        className="w-m"
                      />
                    )}

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove auto-respond channel ${index + 1}`}
                      onClick={() =>
                        onRowsChange(
                          rows.filter((_, nextIndex) => nextIndex !== index),
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>

                <div className="border-l-2 pl-4 py-2 space-y-4">
                  {showLaunchModePicker ? (
                    <div className="space-y-2">
                      <Label>When new messages arrive</Label>
                      <Tabs
                        value={launchModeOption.value}
                        onValueChange={(value) =>
                          updateRow(index, {
                            launchMode: value as ChannelAutoStartLaunchMode,
                          })
                        }
                        className="gap-3"
                      >
                        <TabsList className="grid h-auto w-full grid-cols-1 md:grid-cols-2">
                          {launchModeOptions.map((option) => (
                            <TabsTrigger
                              key={option.value}
                              value={option.value}
                              className="h-auto whitespace-normal px-3 py-2 text-center leading-tight"
                            >
                              {option.label}
                            </TabsTrigger>
                          ))}
                        </TabsList>
                      </Tabs>
                    </div>
                  ) : null}

                  <div className="space-y-2">
                    <Label
                      htmlFor={`channel-auto-start-launch-criteria-${index}`}
                    >
                      Launch criteria (optional)
                    </Label>
                    <p className="text-xs text-muted-foreground w-md">
                      When set, Roomote first checks each new message against
                      these criteria and only launches a task when they are met.
                      If empty, all messages lead to a task.
                    </p>
                    <Textarea
                      id={`channel-auto-start-launch-criteria-${index}`}
                      value={row.launchCriteria}
                      onChange={(event) =>
                        updateRow(index, { launchCriteria: event.target.value })
                      }
                      rows={6}
                      placeholder="Example: Launch only for alerts about services we depend on in production when the status is new or worsening. Never launch for resolved or recovery updates."
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor={`channel-auto-start-instructions-${index}`}>
                      {launchModeOption.instructionsLabel}
                    </Label>
                    <Textarea
                      id={`channel-auto-start-instructions-${index}`}
                      value={row.instructions}
                      onChange={(event) =>
                        updateRow(index, { instructions: event.target.value })
                      }
                      rows={6}
                      placeholder={launchModeOption.instructionsPlaceholder}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {availableTemplates.length > 0 ? (
        rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4">
            <p className="text-sm font-medium text-foreground">
              No auto-respond channels yet
            </p>
            <p className="pt-1 text-sm text-muted-foreground">
              Examples with rules:{' '}
              {availableTemplates.map((template, index) => (
                <span key={template.channel}>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-sm font-normal align-baseline text-muted-foreground"
                    onClick={() =>
                      addRow(createChannelAutoStartRowFromTemplate(template))
                    }
                  >
                    {template.channel}
                  </Button>
                  {index < availableTemplates.length - 1 ? ' ' : '.'}
                </span>
              ))}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Examples with rules:{' '}
            {availableTemplates.map((template, index) => (
              <span key={template.channel}>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm font-normal align-baseline text-muted-foreground"
                  onClick={() =>
                    addRow(createChannelAutoStartRowFromTemplate(template))
                  }
                >
                  {template.channel}
                </Button>
                {index < availableTemplates.length - 1 ? ' ' : '.'}
              </span>
            ))}
          </p>
        )
      ) : null}

      {warning}
      {channelFieldError ? (
        <p className="text-xs text-destructive">{channelFieldError}</p>
      ) : null}
      {instructionsFieldError ? (
        <p className="text-xs text-destructive">{instructionsFieldError}</p>
      ) : null}
    </div>
  );
}
