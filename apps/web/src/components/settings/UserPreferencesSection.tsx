'use client';

import { useColorTheme } from '@/hooks/useColorTheme';
import { useMindReaderMode } from '@/hooks/useMindReaderMode';
import { useNarrationMode } from '@/hooks/useNarrationMode';
import { usePersonalPreferences } from '@/hooks/usePersonalPreferences';
import type { PersonalColorTheme } from '@/types/preferences';

import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Settings2,
  Switch,
} from '@/components/system';

import { Section } from './Section';

const COLOR_THEME_OPTIONS: ReadonlyArray<{
  label: string;
  value: PersonalColorTheme;
}> = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'Auto', value: 'system' },
];

export function UserPreferencesSection({
  slackFastModeDefaultAvailable = false,
}: {
  slackFastModeDefaultAvailable?: boolean;
}) {
  const {
    colorTheme,
    isLoading: isThemeLoading,
    isUpdating: isThemeUpdating,
    setColorTheme,
  } = useColorTheme();
  const {
    enabled: mindReaderModeEnabled,
    isLoading: isMindReaderModeLoading,
    isUpdating: isMindReaderModeUpdating,
    setEnabled: setMindReaderModeEnabled,
  } = useMindReaderMode();
  const {
    enabled: narrationModeEnabled,
    isLoading: isNarrationModeLoading,
    isUpdating: isNarrationModeUpdating,
    setEnabled: setNarrationModeEnabled,
  } = useNarrationMode();
  const {
    preferences,
    isLoading: isSlackFastModeDefaultLoading,
    isUpdating: isSlackFastModeDefaultUpdating,
    setPreferences,
  } = usePersonalPreferences({
    enabled: slackFastModeDefaultAvailable,
    errorMessage: 'Failed to update the Slack fast mode default.',
  });
  const isThemeDisabled = isThemeLoading || isThemeUpdating;

  return (
    <Section icon={Settings2} title="Preferences">
      <div className="space-y-5">
        <div className="flex gap-2 items-center">
          <Label htmlFor="color-theme" className="font-semibold">
            Color theme
          </Label>
          <Select
            disabled={isThemeDisabled}
            value={colorTheme}
            onValueChange={(value) =>
              setColorTheme(value as PersonalColorTheme)
            }
          >
            <SelectTrigger
              id="color-theme"
              aria-label="Color theme"
              className="w-full sm:w-44"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COLOR_THEME_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-3">
          <Switch
            aria-label="Toggle mind reader mode"
            checked={mindReaderModeEnabled}
            disabled={isMindReaderModeLoading || isMindReaderModeUpdating}
            onCheckedChange={setMindReaderModeEnabled}
          />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">
              Mind reader mode
            </p>
            <p className="text-sm text-foreground">
              Automatically expand LLM thoughts by default in conversations.
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <Switch
            aria-label="Toggle narration mode"
            checked={narrationModeEnabled}
            disabled={isNarrationModeLoading || isNarrationModeUpdating}
            onCheckedChange={setNarrationModeEnabled}
          />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">
              Narration mode
            </p>
            <p className="text-sm text-foreground">
              Streamline conversations, keeping only text messages and LLM
              thoughts.
            </p>
          </div>
        </div>

        {slackFastModeDefaultAvailable ? (
          <div className="flex gap-3">
            <Switch
              aria-label="Toggle Slack fast mode default"
              checked={preferences.slackFastModeDefault}
              disabled={
                isSlackFastModeDefaultLoading || isSlackFastModeDefaultUpdating
              }
              onCheckedChange={(enabled) =>
                setPreferences({ slackFastModeDefault: enabled })
              }
            />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">
                Default Slack messages to fast mode
              </p>
              <p className="text-sm text-foreground">
                Use fast mode for your Slack messages without adding !fast.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
