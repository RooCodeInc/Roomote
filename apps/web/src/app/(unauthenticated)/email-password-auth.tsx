'use client';

import { type ReactNode, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Streamdown } from 'streamdown';

import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import {
  Alert,
  AlertCircle,
  AlertDescription,
  ArrowRight,
  Button,
  Input,
  Label,
  Spinner,
} from '@/components/system';

/**
 * Email/password sign-in and sign-up. Sign-up is authorized server-side by
 * the visitor's invite cookie (or the deployment's setup token for the first
 * admin); without one the server rejects account creation. Callers that
 * already know the visitor holds no invite should pass `allowSignUp={false}`
 * so the form never offers account creation and instead points the visitor
 * at an admin for an invite.
 */
export function EmailPasswordAuth({
  redirectUrl,
  defaultMode = 'sign-in',
  allowSignUp = true,
  showModeToggle = true,
  labelsAsPlaceholders = false,
  hideModeSwitchMessage = false,
  showNameField = true,
  submitRowClassName,
  submitButtonClassName,
  submitLeadingAction,
  accountLinkHelpText = null,
}: {
  redirectUrl: string;
  defaultMode?: 'sign-in' | 'sign-up';
  allowSignUp?: boolean;
  showModeToggle?: boolean;
  labelsAsPlaceholders?: boolean;
  hideModeSwitchMessage?: boolean;
  showNameField?: boolean;
  submitRowClassName?: string;
  submitButtonClassName?: string;
  submitLeadingAction?: ReactNode;
  accountLinkHelpText?: string | null;
}) {
  const router = useRouter();
  const [modeState, setModeState] = useState<'sign-in' | 'sign-up'>(
    defaultMode,
  );
  const mode = allowSignUp ? modeState : 'sign-in';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const showPasswordStrength = mode === 'sign-up';

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const result =
        mode === 'sign-up'
          ? await authClient.signUp.email({
              name: name.trim() || email.trim(),
              email: email.trim(),
              password,
              callbackURL: redirectUrl,
            })
          : await authClient.signIn.email({
              email: email.trim(),
              password,
              callbackURL: redirectUrl,
            });

      if (result.error) {
        setErrorMessage(
          result.error.message ||
            (mode === 'sign-up'
              ? 'Unable to create the account. Creating an account requires a valid invite link.'
              : 'Unable to sign in with that email and password.'),
        );
        return;
      }

      router.replace(redirectUrl);
      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Unable to continue.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="space-y-3 text-left max-w-sm" onSubmit={handleSubmit}>
      {errorMessage && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {mode === 'sign-up' && showNameField ? (
        <div className="space-y-1">
          {labelsAsPlaceholders ? null : (
            <Label htmlFor="auth-name">Name</Label>
          )}
          <Input
            id="auth-name"
            aria-label={labelsAsPlaceholders ? 'Name' : undefined}
            placeholder={labelsAsPlaceholders ? 'Name' : undefined}
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={isSubmitting}
          />
        </div>
      ) : null}

      <div className="space-y-1">
        {labelsAsPlaceholders ? null : (
          <Label htmlFor="auth-email">Email</Label>
        )}
        <Input
          id="auth-email"
          type="email"
          aria-label={labelsAsPlaceholders ? 'Email' : undefined}
          placeholder={labelsAsPlaceholders ? 'Email' : undefined}
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={isSubmitting}
        />
      </div>

      <div className="space-y-1">
        {labelsAsPlaceholders ? null : (
          <Label htmlFor="auth-password">Password</Label>
        )}
        <Input
          id="auth-password"
          secret={true}
          passwordStrength={showPasswordStrength}
          aria-label={labelsAsPlaceholders ? 'Password' : undefined}
          placeholder={labelsAsPlaceholders ? 'Password' : undefined}
          autoComplete={
            mode === 'sign-up' ? 'new-password' : 'current-password'
          }
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={isSubmitting}
        />
      </div>

      <div className={cn('flex items-center gap-2', submitRowClassName)}>
        {submitLeadingAction}
        <Button
          className={cn('w-full', submitButtonClassName)}
          type="submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? <Spinner /> : null}
          {mode === 'sign-up' ? 'Create account' : 'Sign in'}
          <ArrowRight />
        </Button>
      </div>

      {allowSignUp && showModeToggle && (
        <Button
          type="button"
          className="w-full"
          variant="outline"
          onClick={() => {
            setErrorMessage(null);
            setModeState(mode === 'sign-up' ? 'sign-in' : 'sign-up');
          }}
          disabled={isSubmitting}
        >
          {mode === 'sign-up'
            ? 'Already have an account? Sign in'
            : 'Need an account? Create one'}
        </Button>
      )}
      {hideModeSwitchMessage ? null : (
        <div className="mt-8 w-full text-sm text-muted-foreground">
          <p>
            Need an account? Forgot your password?
            <br />
            Ask your admin.
          </p>
          {accountLinkHelpText ? (
            <Streamdown className="mt-2 [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-2 [&_h1]:text-sm! [&_h2]:text-sm! [&_h3]:text-sm! [&_img]:hidden [&_p]:m-0">
              {accountLinkHelpText}
            </Streamdown>
          ) : null}
        </div>
      )}
    </form>
  );
}
