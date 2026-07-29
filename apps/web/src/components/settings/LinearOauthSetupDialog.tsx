'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';

import { DOCS_LINEAR_INTEGRATION_URL } from '@/lib/docs';
import {
  useRemoveLinearOauthSetup,
  useSaveLinearOauthSetup,
} from '@/hooks/linear';
import {
  Alert,
  AlertDescription,
  Button,
  Check,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ExternalLink,
  Input,
  Label,
  Skeleton,
  Spinner,
  Trash,
  TriangleAlert,
} from '@/components/system';
import { NumberedStep } from '@/app/(onboarding)/setup/NumberedStep';

type SetupFieldStatus = {
  configured: boolean;
  managedByEnvironment: boolean;
  savedInRoomote: boolean;
};

type LinearOauthSetupDetails = {
  callbackUrl: string;
  webhookUrl: string;
  manifestUrl: string;
  fields: {
    clientId: SetupFieldStatus;
    clientSecret: SetupFieldStatus;
    webhookSecret: SetupFieldStatus;
  };
};

type LinearOauthForm = {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
};

const EMPTY_FORM: LinearOauthForm = {
  clientId: '',
  clientSecret: '',
  webhookSecret: '',
};

function CredentialField({
  id,
  label,
  value,
  status,
  secret = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  status: SetupFieldStatus;
  secret?: boolean;
  onChange: (value: string) => void;
}) {
  const helperText = status.managedByEnvironment
    ? status.savedInRoomote
      ? 'Managed by the deployment environment. A saved fallback is also stored in Roomote.'
      : 'Managed by the deployment environment.'
    : null;

  return (
    <div className="space-y-1.5">
      <div className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)] md:items-center max-w-xl">
        <Label className="text-sm font-medium" htmlFor={id}>
          {label}
        </Label>
        <Input
          id={id}
          secret={secret && !status.managedByEnvironment ? true : undefined}
          className="font-mono"
          value={status.managedByEnvironment ? '' : value}
          placeholder={
            status.managedByEnvironment
              ? 'Managed by environment'
              : status.configured
                ? 'Saved'
                : undefined
          }
          disabled={status.managedByEnvironment}
          onChange={(event) => onChange(event.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <p className="text-xs text-muted-foreground">{helperText}</p>
    </div>
  );
}

export function LinearOauthSetupDialog({
  open,
  onOpenChange,
  setup,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setup: LinearOauthSetupDetails | undefined;
}) {
  const [form, setForm] = useState<LinearOauthForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [removeConfirmationOpen, setRemoveConfirmationOpen] = useState(false);
  const saveSetup = useSaveLinearOauthSetup();
  const removeSetup = useRemoveLinearOauthSetup();

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setFormError(null);
      setRemoveConfirmationOpen(false);
    }
  }, [open]);

  const updateField = (field: keyof LinearOauthForm, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFormError(null);
  };

  const save = () => {
    saveSetup.mutate(form, {
      onSuccess: (result) => {
        toast.success(
          result.requiresReconnect
            ? 'Linear OAuth credentials saved. Enable Linear to reconnect the workspace.'
            : 'Linear OAuth credentials saved.',
        );
        onOpenChange(false);
      },
      onError: (error) => {
        setFormError(
          error instanceof Error
            ? error.message
            : 'Failed to save Linear OAuth credentials.',
        );
      },
    });
  };

  const publicUrlUsesHttps = setup?.webhookUrl.startsWith('https://') ?? true;
  const fieldStatuses = setup ? Object.values(setup.fields) : [];
  const hasConfiguredCredentials = fieldStatuses.some(
    (field) => field.configured,
  );
  const hasSavedCredentials = fieldStatuses.some(
    (field) => field.savedInRoomote,
  );

  const remove = () => {
    removeSetup.mutate(undefined, {
      onSuccess: () => {
        toast.success('Saved Linear OAuth credentials removed.');
        setRemoveConfirmationOpen(false);
        onOpenChange(false);
      },
      onError: (error) => {
        toast.error(
          error instanceof Error
            ? error.message
            : 'Failed to remove saved Linear OAuth credentials.',
        );
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size={removeConfirmationOpen ? 'sm' : '2xl'}>
        {removeConfirmationOpen ? (
          <>
            <DialogHeader>
              <DialogTitle>Remove saved Linear credentials?</DialogTitle>
              <DialogDescription>
                This disables Linear and removes credentials stored by Roomote.
                It does not delete the app in Linear or change credentials
                managed by the deployment environment.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRemoveConfirmationOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={removeSetup.isPending}
                onClick={remove}
              >
                {removeSetup.isPending ? <Spinner size="sm" /> : null}
                Remove credentials
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {hasConfiguredCredentials
                  ? 'Configure Linear'
                  : 'Set up Linear'}
              </DialogTitle>
              <DialogDescription>
                {hasConfiguredCredentials
                  ? 'Update the Linear app credentials saved for this deployment.'
                  : "Roomote is self-hosted, so we need you to create a Linear app for this deployment. It's easy."}
              </DialogDescription>
            </DialogHeader>

            {!setup ? (
              <div className="space-y-4 py-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : (
              <div className="space-y-6 py-2">
                {!hasConfiguredCredentials && !publicUrlUsesHttps ? (
                  <Alert variant="destructive">
                    <TriangleAlert className="size-4" />
                    <AlertDescription>
                      Linear requires a public HTTPS webhook URL. Configure
                      R_PUBLIC_URL with your deployment&apos;s HTTPS address
                      before creating the app.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {!hasConfiguredCredentials ? (
                  <NumberedStep number={1}>
                    <div>
                      <h3 className="font-medium">Create a Linear app.</h3>
                      <p className="text-sm text-muted-foreground mb-2">
                        Roomote uses a dedicated Linear app for this deployment.
                        Log into Linear, use the pre-filled manifest, review the
                        settings in Linear, then create the app.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!publicUrlUsesHttps}
                      onClick={() =>
                        window.open(
                          setup.manifestUrl,
                          '_blank',
                          'noopener,noreferrer',
                        )
                      }
                    >
                      Create the app
                      <ExternalLink />
                    </Button>
                  </NumberedStep>
                ) : null}

                <NumberedStep number={hasConfiguredCredentials ? -1 : 2}>
                  <div>
                    <h3 className="font-medium">
                      {hasConfiguredCredentials
                        ? 'Update the app credentials.'
                        : 'Copy the app credentials.'}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {hasConfiguredCredentials
                        ? 'Paste updated values from your Linear app. Leave a saved value blank to keep it.'
                        : "After saving, from the new app's settings, copy the values below."}
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <CredentialField
                      id="linear-client-id"
                      label="Client ID"
                      value={form.clientId}
                      status={setup.fields.clientId}
                      onChange={(value) => updateField('clientId', value)}
                    />
                    <CredentialField
                      id="linear-client-secret"
                      label="Client secret"
                      value={form.clientSecret}
                      status={setup.fields.clientSecret}
                      secret
                      onChange={(value) => updateField('clientSecret', value)}
                    />
                    <CredentialField
                      id="linear-webhook-secret"
                      label="Webhook secret"
                      value={form.webhookSecret}
                      status={setup.fields.webhookSecret}
                      secret
                      onChange={(value) => updateField('webhookSecret', value)}
                    />
                  </div>
                  {formError ? (
                    <p className="text-sm text-destructive">{formError}</p>
                  ) : null}
                </NumberedStep>
              </div>
            )}

            <DialogFooter className="gap-2 justify-between">
              <div className="flex flex-wrap gap-2 just">
                {hasSavedCredentials ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setRemoveConfirmationOpen(true)}
                  >
                    <Trash />
                    Remove saved credentials
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" asChild>
                    <Link
                      href={DOCS_LINEAR_INTEGRATION_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Setup guide
                      <ExternalLink />
                    </Link>
                  </Button>
                )}
              </div>
              <div className="flex justify-end gap-2 ml-auto">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={!setup || saveSetup.isPending}
                  onClick={save}
                >
                  {saveSetup.isPending ? <Spinner size="sm" /> : <Check />}
                  Finish
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
