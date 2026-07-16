'use client';

import { useState } from 'react';
import { PRODUCT_NAME } from '@roomote/types';

import { ArrowRight, Button, Input } from '@/components/system';

import { StepTitle } from './StepTitle';

export function StepSetupToken({
  hasRejectedToken,
  onContinue,
}: {
  hasRejectedToken: boolean;
  onContinue: (setupToken: string) => void;
}) {
  const [value, setValue] = useState('');
  const trimmedValue = value.trim();

  return (
    <div className="relative w-full max-w-lg space-y-6 py-2 md:py-0">
      <StepTitle text="Enter your setup token" />
      <p>
        This {PRODUCT_NAME} deployment requires a setup token before initial
        setup can begin. Use the setup link printed by the installer, or find
        the token as <span className="font-mono">SETUP_TOKEN</span>&nbsp;in the
        deployment&apos;s env file.
      </p>
      {hasRejectedToken ? (
        <p className="text-sm text-destructive">
          That setup token didn&apos;t match. Check the value and try again.
        </p>
      ) : null}
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault();

          if (trimmedValue.length > 0) {
            onContinue(trimmedValue);
          }
        }}
      >
        <Input
          secret
          className="font-mono"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Setup token"
          data-1p-ignore
        />
        <Button type="submit" disabled={trimmedValue.length === 0}>
          Continue
          <ArrowRight />
        </Button>
      </form>
    </div>
  );
}
