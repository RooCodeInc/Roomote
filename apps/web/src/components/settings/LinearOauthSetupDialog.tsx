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
  Copy,
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
  TriangleAlert,
} from '@/components/system';

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

function EndpointField({ label, value }: { label: string; value: string }) {
  const copyValue = async () => {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied.`);
  };

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input value={value} readOnly className="font-mono text-xs" />
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={copyValue}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

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
    : status.configured
      ? 'Already saved. Leave blank to keep the current value.'
      : 'Required.';

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={secret ? 'password' : 'text'}
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
        data-1p-ignore
      />
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
      <DialogContent size={removeConfirmationOpen ? 'sm' : 'lg'}>
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
                  ? 'Update or remove the Linear app credentials saved for this deployment.'
                  : 'Create a Linear app for this deployment, then connect it to your workspace.'}
              </DialogDescription>
            </DialogHeader>

            {!setup ? (
              <div className="space-y-4 py-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : (
              <div className="space-y-6 py-2">
                {!publicUrlUsesHttps ? (
                  <Alert variant="destructive">
                    <TriangleAlert className="size-4" />
                    <AlertDescription>
                      Linear requires a public HTTPS webhook URL. Configure
                      R_PUBLIC_URL with your deployment&apos;s HTTPS address
                      before creating the app.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <section className="space-y-3">
                  <div>
                    <h3 className="font-medium">
                      Create a Linear app for this deployment.
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Roomote needs its own Linear app. The manifest pre-fills
                      the callback, webhook, and agent event settings. Review it
                      in Linear, then create the app.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!publicUrlUsesHttps}
                    onClick={() =>
                      window.open(
                        setup.manifestUrl,
                        '_blank',
                        'noopener,noreferrer',
                      )
                    }
                  >
                    Create Linear app
                    <ExternalLink />
                  </Button>
                  <div className="grid gap-3">
                    <EndpointField
                      label="Callback URL"
                      value={setup.callbackUrl}
                    />
                    <EndpointField
                      label="Webhook URL"
                      value={setup.webhookUrl}
                    />
                  </div>
                </section>

                <section className="space-y-3">
                  <div>
                    <h3 className="font-medium">Then save the credentials.</h3>
                    <p className="text-sm text-muted-foreground">
                      Copy these values from the new app&apos;s settings.
                      Roomote encrypts values saved here. After they are saved,
                      Enable Linear connects the app to your workspace.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
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
                </section>
              </div>
            )}

            <DialogFooter className="gap-2 sm:justify-between">
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" asChild>
                  <Link
                    href={DOCS_LINEAR_INTEGRATION_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Setup guide
                    <ExternalLink />
                  </Link>
                </Button>
                {hasSavedCredentials ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setRemoveConfirmationOpen(true)}
                  >
                    Remove saved credentials
                  </Button>
                ) : null}
              </div>
              <div className="flex justify-end gap-2">
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
                  {saveSetup.isPending ? <Spinner size="sm" /> : null}
                  Save credentials
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
