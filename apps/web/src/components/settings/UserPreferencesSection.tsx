'use client';

import { useColorTheme } from '@/hooks/useColorTheme';
import { useNarrationMode } from '@/hooks/useNarrationMode';
import { useShowCommandOutput } from '@/hooks/useShowCommandOutput';
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
  const { enabled, isLoading, isUpdating, setEnabled } = useNarrationMode();
  const {
    enabled: commandOutputEnabled,
    isLoading: isCommandOutputLoading,
    isUpdating: isCommandOutputUpdating,
    setEnabled: setCommandOutputEnabled,
  } = useShowCommandOutput();
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
            aria-label="Toggle narration mode"
            checked={enabled}
            disabled={isLoading || isUpdating}
            onCheckedChange={setEnabled}
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
            aria-label="Toggle command output"
            checked={commandOutputEnabled}
            disabled={isCommandOutputLoading || isCommandOutputUpdating}
            onCheckedChange={setCommandOutputEnabled}
          />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">
              Show command output
            </p>
            <p className="text-sm text-foreground">
              Display expandable command output in task conversations. Narration
              mode still hides command activity.
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}
