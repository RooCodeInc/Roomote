'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';

type PendingConsent = {
  promise: Promise<boolean>;
  resolve: (accepted: boolean) => void;
};

const VoiceConsentContext = createContext<() => Promise<boolean>>(
  async () => true,
);

export function useVoiceConsent() {
  return useContext(VoiceConsentContext);
}

export function VoiceConsentProvider({
  children,
  cloudEnabled,
}: {
  children: React.ReactNode;
  cloudEnabled: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryOptions = trpc.preferences.getVoiceConsent.queryOptions();
  const consentQuery = useQuery({
    ...queryOptions,
    enabled: cloudEnabled,
  });
  const acceptConsent = useMutation(
    trpc.preferences.acceptVoiceConsent.mutationOptions(),
  );
  const [open, setOpen] = useState(false);
  const pendingConsentRef = useRef<PendingConsent | null>(null);

  const finishConsent = useCallback((accepted: boolean) => {
    pendingConsentRef.current?.resolve(accepted);
    pendingConsentRef.current = null;
    setOpen(false);
  }, []);

  useEffect(
    () => () => {
      pendingConsentRef.current?.resolve(false);
      pendingConsentRef.current = null;
    },
    [],
  );

  const requestConsent = useCallback(async () => {
    if (!cloudEnabled) return true;

    try {
      const accepted =
        consentQuery.data ?? (await queryClient.fetchQuery(queryOptions));
      if (accepted) return true;
    } catch {
      // Acceptance can still be recorded from the dialog after a read failure.
    }

    if (pendingConsentRef.current) {
      return pendingConsentRef.current.promise;
    }

    let resolveConsent!: (accepted: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveConsent = resolve;
    });
    pendingConsentRef.current = { promise, resolve: resolveConsent };
    setOpen(true);
    return promise;
  }, [cloudEnabled, consentQuery.data, queryClient, queryOptions]);

  const accept = async () => {
    try {
      await acceptConsent.mutateAsync();
      queryClient.setQueryData(queryOptions.queryKey, true);
      finishConsent(true);
    } catch {
      toast.error('Could not save your voice choice. Please try again.');
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !acceptConsent.isPending) finishConsent(false);
  };

  return (
    <VoiceConsentContext.Provider value={requestConsent}>
      {children}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent showCloseButton={!acceptConsent.isPending} size="md">
          <DialogHeader>
            <DialogTitle>Try experimental voice</DialogTitle>
            <DialogDescription>
              Voice is optional and experimental. To provide a live voice
              conversation, Roomote sends your microphone audio, voice
              transcripts, and workspace context such as repository and
              integration names to OpenAI.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={acceptConsent.isPending}
              onClick={() => finishConsent(false)}
              type="button"
              variant="outline"
            >
              Not now
            </Button>
            <Button
              disabled={acceptConsent.isPending}
              onClick={() => void accept()}
              type="button"
            >
              {acceptConsent.isPending ? 'Saving...' : 'Continue with voice'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </VoiceConsentContext.Provider>
  );
}
