import * as React from 'react';
import { ZxcvbnFactory } from '@zxcvbn-ts/core';

import { cn } from '@/lib/utils';
import { Eye, EyeOff } from './icons';

type InputProps = React.ComponentProps<'input'> & {
  secret?: boolean;
  passwordStrength?: boolean;
  match?: string;
};

const zxcvbn = new ZxcvbnFactory();

const PASSWORD_STRENGTH_CLASSES = [
  'bg-chart-6',
  'bg-chart-6',
  'bg-chart-7',
  'bg-chart-2',
  'bg-accent-bright-foreground',
] as const;

const CREDENTIAL_AUTOCOMPLETE_TOKENS = new Set([
  'name',
  'email',
  'username',
  'nickname',
  'new-password',
  'current-password',
  'one-time-code',
]);

function getInputValue(
  value: InputProps['value'] | InputProps['defaultValue'],
) {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.join('');
  }

  return '';
}

function shouldIgnorePasswordManagers(
  autoComplete: React.HTMLInputAutoCompleteAttribute | undefined,
  hasExplicitAutoComplete: boolean,
) {
  if (!hasExplicitAutoComplete || autoComplete == null || autoComplete === '') {
    return true;
  }

  return !String(autoComplete)
    .toLowerCase()
    .split(/\s+/)
    .some((token) => CREDENTIAL_AUTOCOMPLETE_TOKENS.has(token));
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      type,
      secret = false,
      passwordStrength = false,
      match,
      disabled,
      value,
      defaultValue,
      onChange,
      autoComplete: autoCompleteProp,
      ...props
    },
    ref,
  ) => {
    const [showSecretValue, setShowSecretValue] = React.useState(false);
    const [inputValue, setInputValue] = React.useState(() =>
      getInputValue(defaultValue),
    );
    const inputType = secret ? (showSecretValue ? 'text' : 'password') : type;
    const hasExplicitAutoComplete = autoCompleteProp !== undefined;
    const autoComplete =
      autoCompleteProp ?? (secret ? 'new-password' : undefined);
    const ignorePasswordManagers = shouldIgnorePasswordManagers(
      autoCompleteProp,
      hasExplicitAutoComplete,
    );
    const strengthValue =
      value === undefined ? inputValue : getInputValue(value);
    const hasMatch = match !== undefined;
    const isMatch = hasMatch && match.length > 0 && strengthValue === match;
    const strengthScore = React.useMemo(
      () =>
        hasMatch
          ? isMatch
            ? PASSWORD_STRENGTH_CLASSES.length - 1
            : 0
          : passwordStrength
            ? zxcvbn.check(strengthValue).score
            : 0,
      [hasMatch, isMatch, passwordStrength, strengthValue],
    );
    const showMeter = passwordStrength || hasMatch;
    const hasMeterValue = strengthValue.length > 0;
    const strengthPercent =
      showMeter && hasMeterValue
        ? hasMatch
          ? '100%'
          : `${((strengthScore + 1) / 5) * 100}%`
        : '0%';
    const strengthClass =
      PASSWORD_STRENGTH_CLASSES[strengthScore] ?? PASSWORD_STRENGTH_CLASSES[0];
    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      setInputValue(event.target.value);
      onChange?.(event);
    };

    const input = (
      <input
        ref={ref}
        type={inputType}
        data-slot="input"
        className={cn(
          'bg-card border border-input flex h-9 w-full min-w-0 rounded-md px-3 py-1 text-sm transition-[color,box-shadow,border,background] outline-none',
          'selection:bg-primary selection:text-primary-foreground',
          'placeholder:text-muted-foreground/70',
          'disabled:cursor-not-allowed disabled:bg-foreground/5 disabled:text-foreground/50',
          'focus-visible:border-foreground dark:focus-visible:border-accent-bright-foreground',
          'file:text-foreground file:inline-flex file:h-7 file:border-0 file:border-r-1 file:border-border file:bg-transparent file:font-medium file:mr-2 file:pr-2',
          'aria-invalid:ring-2 aria-invalid:ring-destructive/50',
          secret && 'pr-10',
          className,
        )}
        {...(ignorePasswordManagers
          ? { 'data-1p-ignore': true, 'data-op-ignore': 'true' as const }
          : {})}
        autoComplete={autoComplete}
        disabled={disabled}
        value={value}
        defaultValue={defaultValue}
        onChange={handleChange}
        {...props}
      />
    );

    if (!secret && !showMeter) {
      return input;
    }

    return (
      <div className="relative flex w-full items-center">
        {input}
        {secret ? (
          <button
            type="button"
            className="absolute cursor-pointer right-0 top-0 flex h-full items-center px-3 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground/50"
            onClick={() => setShowSecretValue((currentValue) => !currentValue)}
            aria-label={showSecretValue ? 'Hide value' : 'Show value'}
            title={showSecretValue ? 'Hide value' : 'Show value'}
            disabled={disabled}
          >
            {showSecretValue ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </button>
        ) : null}
        {showMeter ? (
          <div
            className={`absolute inset-x-px bottom-px overflow-hidden rounded-b-[calc(var(--radius-md)-1px)] transition-all ${hasMeterValue ? 'h-1 bg-muted' : 'h-0 bg-transparent'}`}
            role="meter"
            aria-label={hasMatch ? 'Input match' : 'Password strength'}
            aria-valuemin={0}
            aria-valuemax={4}
            aria-valuenow={hasMeterValue ? strengthScore : 0}
          >
            <div
              className={cn(
                'h-full transition-all duration-200',
                strengthClass,
              )}
              style={{ width: strengthPercent }}
            />
          </div>
        ) : null}
      </div>
    );
  },
);

Input.displayName = 'Input';

export { Input };
