'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

import {
  AlertCircle,
  Button,
  Check,
  Input,
  Label,
  MessageSquareHeart,
  RotateCcw,
  Skeleton,
  Smile,
  Spinner,
  Sun,
  Textarea,
  Trash2,
} from '@/components/system';
import { Section } from '@/components/settings';
import { ROOMOTE_STYLE_GUIDANCE_MAX_LENGTH } from '@roomote/cloud-agents/style-guidance-constants';

const SAVE_DEBOUNCE_MS = 500;

const VIBES_IDEA_DOWNLOADS = [
  {
    label: 'Roomote right arrow (black)',
    href: '/vibes/ideas/roomote_right_black.png',
    download: 'roomote_right_black.png',
  },
  {
    label: 'Roomote right arrow (green)',
    href: '/vibes/ideas/roomote_right_green.png',
    download: 'roomote_right_green.png',
  },
  {
    label: 'Roomote up arrow (black)',
    href: '/vibes/ideas/roomote_up_black.png',
    download: 'roomote_up_black.png',
  },
  {
    label: 'Roomote up arrow (green)',
    href: '/vibes/ideas/roomote_up_green.png',
    download: 'roomote_up_green.png',
  },
  {
    label: 'Let me Roomote that for you',
    href: '/vibes/ideas/let-me-roomote-that-for-you.png',
    download: 'let-me-roomote-that-for-you.png',
  },
] as const;

type VibesFieldName =
  | 'slackSummonEmoji'
  | 'slackAckEmoji'
  | 'slackCompletionEmoji';

type VibesDraft = Record<VibesFieldName, string>;

type VibesFieldErrors = Partial<
  Record<VibesFieldName | 'styleGuidance', string>
>;
type DebounceTimers = Partial<
  Record<VibesFieldName, ReturnType<typeof setTimeout>>
>;

function normalizeEmojiInput(value: string): string {
  return value.replace(/^:+|:+$/g, '');
}

function toDraft(settings: {
  slackSummonEmoji: string | null;
  slackAckEmoji: string;
  slackCompletionEmoji: string;
}): VibesDraft {
  return {
    slackSummonEmoji: settings.slackSummonEmoji ?? '',
    slackAckEmoji: settings.slackAckEmoji,
    slackCompletionEmoji: settings.slackCompletionEmoji,
  };
}

function toStyleGuidanceValue(value: string | null | undefined): string {
  return value ?? '';
}

const FIELD_TO_TOAST_TYPE: Record<VibesFieldName, string> = {
  slackSummonEmoji: 'summon',
  slackAckEmoji: 'acknowledgement',
  slackCompletionEmoji: 'completion',
};

function hasDirtyField(draft: VibesDraft, saved: VibesDraft) {
  return (
    draft.slackSummonEmoji !== saved.slackSummonEmoji ||
    draft.slackAckEmoji !== saved.slackAckEmoji ||
    draft.slackCompletionEmoji !== saved.slackCompletionEmoji
  );
}

export function VibesSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const customTonePresets = [
    {
      label: 'Chill',
      guidance:
        'Keep the tone relaxed, friendly, and easygoing. Be helpful without sounding formal, use plain language, and keep updates short and low-pressure. It is okay to be lightly conversational, but stay focused on the work and avoid forced enthusiasm or excessive exclamation points.',
    },
    {
      label: 'Gen Z',
      guidance:
        'Use a casual Gen Z tone: concise, upbeat, and conversational, with tasteful slang when it fits. Keep the answer competent and grounded, avoid corporate polish, and do not overdo memes or internet-speak. Make status updates feel quick, friendly, and confident.',
    },
    {
      label: 'Sciency',
      guidance:
        'Use a precise, analytical tone with a scientific bent. Frame claims in terms of evidence, assumptions, uncertainty, and observable behavior. Prefer careful reasoning, hypotheses, measurements, and falsifiable explanations over vibes. Stay readable and practical, but do not flatten important nuance.',
    },
    {
      label: 'Corporate',
      guidance:
        'Use a polished, professional workplace tone. Be clear, composed, and solutions-oriented, with concise status updates and practical next steps. Avoid slang, jokes, strong emotion, and overly casual phrasing. When something is blocked or uncertain, state it diplomatically and focus on the path forward.',
    },
    {
      label: 'Goblin Mode',
      guidance:
        'Work goblins and gremlins into the voice as often as naturally possible. Keep the answer useful and grounded, but prefer playful goblin-and-gremlin phrasing in status updates, transitions, and light humor whenever it does not obscure the actual work.',
    },
  ] as const;
  const settingsQueryKey = trpc.vibes.get.queryKey();
  const settingsQuery = useQuery(trpc.vibes.get.queryOptions());
  const updateMutation = useMutation(trpc.vibes.update.mutationOptions());
  const [draft, setDraft] = useState<VibesDraft>({
    slackSummonEmoji: '',
    slackAckEmoji: '',
    slackCompletionEmoji: '',
  });
  const [savedDraft, setSavedDraft] = useState<VibesDraft>({
    slackSummonEmoji: '',
    slackAckEmoji: '',
    slackCompletionEmoji: '',
  });
  const [fieldErrors, setFieldErrors] = useState<VibesFieldErrors>({});
  const [hasLoadedInitialState, setHasLoadedInitialState] = useState(false);
  const [styleGuidance, setStyleGuidance] = useState('');
  const [savedStyleGuidance, setSavedStyleGuidance] = useState('');
  const [hasLoadedInitialStyleGuidance, setHasLoadedInitialStyleGuidance] =
    useState(false);
  const debounceTimersRef = useRef<DebounceTimers>({});
  const draftRef = useRef(draft);
  const savedDraftRef = useRef(savedDraft);
  const styleGuidanceRef = useRef(styleGuidance);
  const savedStyleGuidanceRef = useRef(savedStyleGuidance);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    savedDraftRef.current = savedDraft;
  }, [savedDraft]);

  useEffect(() => {
    styleGuidanceRef.current = styleGuidance;
  }, [styleGuidance]);

  useEffect(() => {
    savedStyleGuidanceRef.current = savedStyleGuidance;
  }, [savedStyleGuidance]);

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    const nextDraft = toDraft(settingsQuery.data);
    const previouslySavedDraft = savedDraftRef.current;
    const isDirty = hasDirtyField(draftRef.current, previouslySavedDraft);
    const hasServerChange = hasDirtyField(nextDraft, previouslySavedDraft);

    if (!hasLoadedInitialState || (!isDirty && hasServerChange)) {
      setDraft(nextDraft);
      draftRef.current = nextDraft;
    }

    setSavedDraft(nextDraft);
    savedDraftRef.current = nextDraft;
    setHasLoadedInitialState(true);
  }, [hasLoadedInitialState, settingsQuery.data]);

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    const nextStyleGuidance = toStyleGuidanceValue(
      settingsQuery.data.styleGuidance,
    );
    const hasUnsavedStyleGuidance =
      styleGuidanceRef.current !== savedStyleGuidanceRef.current;

    if (!hasLoadedInitialStyleGuidance || !hasUnsavedStyleGuidance) {
      setStyleGuidance(nextStyleGuidance);
      styleGuidanceRef.current = nextStyleGuidance;
    }

    setSavedStyleGuidance(nextStyleGuidance);
    savedStyleGuidanceRef.current = nextStyleGuidance;
    setHasLoadedInitialStyleGuidance(true);
  }, [hasLoadedInitialStyleGuidance, settingsQuery.data]);

  useEffect(() => {
    const debounceTimers = debounceTimersRef.current;

    return () => {
      for (const timer of Object.values(debounceTimers)) {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
  }, []);

  const scheduleSave = (field: VibesFieldName) => {
    const existingTimer = debounceTimersRef.current[field];
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    debounceTimersRef.current[field] = setTimeout(() => {
      void saveField(field, draftRef.current[field]);
    }, SAVE_DEBOUNCE_MS);
  };

  const clearScheduledSave = (field: VibesFieldName) => {
    const existingTimer = debounceTimersRef.current[field];
    if (existingTimer) {
      clearTimeout(existingTimer);
      delete debounceTimersRef.current[field];
    }
  };

  const saveField = async (field: VibesFieldName, rawValue: string) => {
    const previouslySavedValue = savedDraftRef.current[field];

    if (rawValue === previouslySavedValue) {
      return;
    }

    try {
      const result = await updateMutation.mutateAsync(
        field === 'slackSummonEmoji'
          ? { slackSummonEmoji: rawValue }
          : { [field]: rawValue },
      );

      if (!result.success) {
        setFieldErrors((current) => ({
          ...current,
          [field]: result.fieldErrors[field],
        }));
        return;
      }

      queryClient.setQueryData(settingsQueryKey, result.settings);
      void queryClient.invalidateQueries({ queryKey: settingsQueryKey });

      const nextDraft = toDraft(result.settings);
      const emoji = nextDraft[field];

      setSavedDraft(nextDraft);
      savedDraftRef.current = nextDraft;
      setFieldErrors((current) => ({
        ...current,
        [field]: undefined,
      }));

      setDraft((current) => {
        if (current[field] !== rawValue) {
          return current;
        }

        const updatedDraft = {
          ...current,
          [field]: nextDraft[field],
        };
        draftRef.current = updatedDraft;
        return updatedDraft;
      });

      if (field === 'slackSummonEmoji' && !emoji) {
        toast.success('Removed custom summon emoji');
        return;
      }

      toast.success(`Change ${FIELD_TO_TOAST_TYPE[field]} emoji to :${emoji}:`);
    } catch {
      toast.error('Failed to save vibes settings.');
    }
  };

  const saveStyleGuidance = async () => {
    try {
      const result = await updateMutation.mutateAsync({
        styleGuidance,
      });

      if (!result.success) {
        setFieldErrors((current) => ({
          ...current,
          styleGuidance: result.fieldErrors.styleGuidance,
        }));
        return;
      }

      queryClient.setQueryData(settingsQueryKey, result.settings);
      void queryClient.invalidateQueries({ queryKey: settingsQueryKey });

      const nextStyleGuidance = toStyleGuidanceValue(
        result.settings.styleGuidance,
      );

      setStyleGuidance(nextStyleGuidance);
      styleGuidanceRef.current = nextStyleGuidance;
      setSavedStyleGuidance(nextStyleGuidance);
      savedStyleGuidanceRef.current = nextStyleGuidance;
      setFieldErrors((current) => ({
        ...current,
        styleGuidance: undefined,
      }));

      toast.success(
        nextStyleGuidance ? 'Style guidance saved.' : 'Style guidance cleared.',
      );
    } catch {
      toast.error('Failed to save vibes settings.');
    }
  };

  const updateField = ({
    field,
    value,
    saveImmediately = false,
  }: {
    field: VibesFieldName;
    value: string;
    saveImmediately?: boolean;
  }) => {
    const normalizedValue = normalizeEmojiInput(value);
    const nextDraft = {
      ...draftRef.current,
      [field]: normalizedValue,
    };

    setDraft(nextDraft);
    draftRef.current = nextDraft;
    setFieldErrors((current) => ({
      ...current,
      [field]: undefined,
    }));

    clearScheduledSave(field);

    if (saveImmediately) {
      void saveField(field, normalizedValue);
      return;
    }

    scheduleSave(field);
  };

  const handleBlur = (field: VibesFieldName) => {
    clearScheduledSave(field);

    if (draftRef.current[field] !== savedDraftRef.current[field]) {
      void saveField(field, draftRef.current[field]);
    }
  };

  const ackDefault = settingsQuery.data?.defaults.slackAckEmoji ?? 'eyes';
  const completionDefault =
    settingsQuery.data?.defaults.slackCompletionEmoji ?? 'white_check_mark';
  const isStyleGuidanceDirty = styleGuidance !== savedStyleGuidance;
  const showStyleGuidanceCounter =
    styleGuidance.length >= ROOMOTE_STYLE_GUIDANCE_MAX_LENGTH * 0.9;
  const styleGuidanceFooter =
    !isStyleGuidanceDirty && !updateMutation.isPending ? undefined : (
      <>
        <Button
          variant="outline"
          type="button"
          size="sm"
          onClick={() => {
            setStyleGuidance(savedStyleGuidance);
            styleGuidanceRef.current = savedStyleGuidance;
            setFieldErrors((current) => ({
              ...current,
              styleGuidance: undefined,
            }));
            updateMutation.reset();
          }}
          disabled={updateMutation.isPending}
        >
          <RotateCcw />
          Reset to default
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void saveStyleGuidance()}
          disabled={updateMutation.isPending || !isStyleGuidanceDirty}
        >
          {updateMutation.isPending && <Spinner />}
          {updateMutation.isPending ? 'Saving...' : 'Save'}
          <Check />
        </Button>
      </>
    );

  if (settingsQuery.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <p>Failed to load vibes settings.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Section icon={Smile} title="Custom reaction emoji">
        <p className="mb-4">
          Choose the emoji Roomote uses when reacting to messages.
        </p>
        <div className="space-y-4 max-w-lg">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="slack-ack-emoji">Acknowledgement</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Used by Roomote it to show it saw your message. Default 👀
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                onClick={() =>
                  updateField({
                    field: 'slackAckEmoji',
                    value: ackDefault,
                    saveImmediately: true,
                  })
                }
                aria-label="Reset acknowledgement emoji"
              >
                <RotateCcw />
              </Button>
            </div>
            <Input
              id="slack-ack-emoji"
              value={draft.slackAckEmoji}
              onChange={(event) =>
                updateField({
                  field: 'slackAckEmoji',
                  value: event.target.value,
                })
              }
              onBlur={() => handleBlur('slackAckEmoji')}
            />
            {fieldErrors.slackAckEmoji ? (
              <p className="text-xs text-destructive">
                {fieldErrors.slackAckEmoji}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="slack-completion-emoji">Completion</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Used by Roomote it to show it completed some type of work.
                  Default ✅
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                onClick={() =>
                  updateField({
                    field: 'slackCompletionEmoji',
                    value: completionDefault,
                    saveImmediately: true,
                  })
                }
                aria-label="Reset completion emoji"
              >
                <RotateCcw />
              </Button>
            </div>
            <Input
              id="slack-completion-emoji"
              value={draft.slackCompletionEmoji}
              onChange={(event) =>
                updateField({
                  field: 'slackCompletionEmoji',
                  value: event.target.value,
                })
              }
              onBlur={() => handleBlur('slackCompletionEmoji')}
            />
            {fieldErrors.slackCompletionEmoji ? (
              <p className="text-xs text-destructive">
                {fieldErrors.slackCompletionEmoji}
              </p>
            ) : null}
          </div>
        </div>
      </Section>

      <Section icon={Sun} title="Call Roomote with a reaction">
        <p className="mb-4">
          React to an existing Slack message to start a task from that message.
          Ain&apos;t nobody got time for typing.
        </p>
        <div className="space-y-4 max-w-lg">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="slack-summon-emoji">Emoji name</Label>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                onClick={() =>
                  updateField({
                    field: 'slackSummonEmoji',
                    value: '',
                    saveImmediately: true,
                  })
                }
                aria-label="Clear summon emoji"
              >
                <Trash2 />
              </Button>
            </div>
            <Input
              id="slack-summon-emoji"
              value={draft.slackSummonEmoji}
              placeholder="shipit"
              onChange={(event) =>
                updateField({
                  field: 'slackSummonEmoji',
                  value: event.target.value,
                })
              }
              onBlur={() => handleBlur('slackSummonEmoji')}
            />
            {fieldErrors.slackSummonEmoji ? (
              <p className="text-xs text-destructive">
                {fieldErrors.slackSummonEmoji}
              </p>
            ) : null}
          </div>

          <aside className="space-y-3 rounded-lg bg-background p-4">
            <p className="text-sm font-light">
              Want something new? Take one of ours.
            </p>

            <div className="flex items-center gap-2">
              {VIBES_IDEA_DOWNLOADS.map((idea) => (
                <a
                  key={idea.download}
                  href={idea.href}
                  download={idea.download}
                  className="group block overflow-hidden rounded-lg border bg-background transition-colors hover:border-foreground/30"
                >
                  <Image
                    src={idea.href}
                    alt={idea.label}
                    width={480}
                    height={480}
                    className="size-8"
                  />
                </a>
              ))}
            </div>
          </aside>
        </div>
      </Section>

      <Section
        icon={MessageSquareHeart}
        title="Custom tone"
        footer={styleGuidanceFooter}
      >
        <p className="mb-4">
          Provide tone of voice guidance to help Roomote blend into your team by
          having it chatting like you do.
        </p>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="style-guidance" className="sr-only">
              Custom style
            </Label>
            <Textarea
              id="style-guidance"
              value={styleGuidance}
              onChange={(event) => {
                if (fieldErrors.styleGuidance) {
                  updateMutation.reset();
                  setFieldErrors((current) => ({
                    ...current,
                    styleGuidance: undefined,
                  }));
                }

                setStyleGuidance(event.target.value);
                styleGuidanceRef.current = event.target.value;
              }}
              rows={4}
              maxLength={ROOMOTE_STYLE_GUIDANCE_MAX_LENGTH}
              className="min-h-24"
              placeholder="Direct, concise, calm. Avoid hype. Keep status updates brief and concrete."
              disabled={updateMutation.isPending}
            />
            <div className="flex items-start justify-between gap-3 text-xs">
              {fieldErrors.styleGuidance ? (
                <p className="text-destructive">{fieldErrors.styleGuidance}</p>
              ) : null}
              {showStyleGuidanceCounter ? (
                <span
                  className={
                    styleGuidance.length >= ROOMOTE_STYLE_GUIDANCE_MAX_LENGTH
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  }
                >
                  {styleGuidance.length}/{ROOMOTE_STYLE_GUIDANCE_MAX_LENGTH}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center text-sm">
              <p className="text-muted-foreground mr-2">Try some presets</p>
              {customTonePresets.map((preset) => (
                <Button
                  key={preset.label}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    updateMutation.reset();
                    setFieldErrors((current) => ({
                      ...current,
                      styleGuidance: undefined,
                    }));
                    setStyleGuidance(preset.guidance);
                    styleGuidanceRef.current = preset.guidance;
                  }}
                  disabled={updateMutation.isPending}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}
