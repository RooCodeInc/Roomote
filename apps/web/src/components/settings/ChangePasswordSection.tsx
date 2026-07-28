'use client';

import { type FormEvent, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  Button,
  Check,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  KeyRound,
  Label,
  Spinner,
} from '@/components/system';
import { authClient } from '@/lib/auth-client';
import { useTRPC } from '@/trpc/client';

import { Section } from './Section';

function getAuthErrorMessage(
  error: { message?: string } | null | undefined,
  fallback: string,
) {
  return error?.message || fallback;
}

export function ChangePasswordSection({
  email,
  mode = 'change',
}: {
  email?: string;
  mode?: 'change' | 'set';
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const accountCapabilitiesQueryKey =
    trpc.preferences.accountCapabilities.queryKey();
  const setPasswordMutation = useMutation(
    trpc.preferences.setPassword.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: accountCapabilitiesQueryKey,
        });
      },
    }),
  );

  const resetForm = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      resetForm();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);

    try {
      if (mode === 'set') {
        await setPasswordMutation.mutateAsync({ newPassword });
      } else {
        const result = await authClient.changePassword({
          currentPassword,
          newPassword,
          revokeOtherSessions: true,
        });

        if (result.error) {
          toast.error(
            getAuthErrorMessage(
              result.error,
              'Unable to change your password.',
            ),
          );
          return;
        }
      }

      toast.success(mode === 'set' ? 'Password set.' : 'Password changed.');
      handleOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Unable to change your password.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Section
      icon={KeyRound}
      title="Password"
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setIsOpen(true)}
        >
          {mode === 'set' ? 'Set password' : 'Change password'}
        </Button>
      }
    >
      <p className="text-muted-foreground">
        {mode === 'set'
          ? `Set a password to sign in with ${email ?? 'this email'} on mobile and other devices.`
          : 'Update your password to keep your account secure.'}
      </p>
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              {mode === 'set' ? 'Set password' : 'Change password'}
            </DialogTitle>
            <DialogDescription>
              {mode === 'set'
                ? 'Choose a password for signing in with your email.'
                : 'Enter your current password, then choose a new one.'}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleSubmit}>
            {mode === 'change' ? (
              <div className="space-y-1">
                <Label htmlFor="current-password">Current password</Label>
                <Input
                  id="current-password"
                  secret={true}
                  autoComplete="current-password"
                  required
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  disabled={isSubmitting}
                />
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                secret={true}
                passwordStrength
                autoComplete="new-password"
                required
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={isSubmitting}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <Input
                id="confirm-password"
                secret={true}
                match={newPassword}
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={isSubmitting}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={isSubmitting}
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? <Spinner /> : <Check />}
                Save password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
