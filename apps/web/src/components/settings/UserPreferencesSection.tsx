'use client';

import { useColorTheme } from '@/hooks/useColorTheme';
import { useMindReaderMode } from '@/hooks/useMindReaderMode';
import { useNarrationMode } from '@/hooks/useNarrationMode';
import { useTherapistMode } from '@/hooks/useTherapistMode';
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

export function UserPreferencesSection() {
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
    enabled: therapistModeEnabled,
    isLoading: isTherapistModeLoading,
    isUpdating: isTherapistModeUpdating,
    setEnabled: setTherapistModeEnabled,
  } = useTherapistMode();
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

        <div className="flex gap-3">
          <Switch
            aria-label="Toggle therapist mode"
            checked={therapistModeEnabled}
            disabled={isTherapistModeLoading || isTherapistModeUpdating}
            onCheckedChange={setTherapistModeEnabled}
          />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">
              Therapist mode
            </p>
            <p className="text-sm text-foreground">
              Mention the specific memory used to inform a session or task.
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}
