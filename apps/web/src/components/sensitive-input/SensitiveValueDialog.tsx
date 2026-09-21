'use client';

import type { ReactNode } from 'react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Lock,
} from '@/components/system';

export function SensitiveValueDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  inputId,
  value,
  onChange,
  onSubmit,
  submitLabel = 'Save',
  triggerLabel,
  placeholder = 'Enter your response',
  disabled = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  inputId: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitLabel?: string;
  triggerLabel: string;
  placeholder?: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onOpenChange(true)}
        disabled={disabled}
      >
        <Lock className="size-3.5" />
        {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="2xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <div className="space-y-2">
              <label htmlFor={inputId} className="text-sm font-medium">
                {label}
              </label>
              <Input
                id={inputId}
                secret
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                className="ph-no-capture ph-mask sentry-mask"
              />
            </div>
            {children}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={disabled}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={disabled || !value.trim()}>
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
