'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_KEY_PREFIX = 'roomote-setup-session';
const PERSIST_DEBOUNCE_MS = 300;

type SetupAsyncStepState = 'pending' | 'completed' | 'skipped';

type SetupAsyncSession = {
  version: 1;
  onboardingTask: {
    taskId: string | null;
    postOnboardingUnlocked: boolean;
  };
  suggestedTasksStep: {
    state: SetupAsyncStepState;
  };
  communicationStep: {
    state: SetupAsyncStepState;
  };
};

function createEmptySetupAsyncSession(): SetupAsyncSession {
  return {
    version: 1,
    onboardingTask: {
      taskId: null,
      postOnboardingUnlocked: false,
    },
    suggestedTasksStep: {
      state: 'pending',
    },
    communicationStep: {
      state: 'pending',
    },
  };
}

function parseStepState(
  value: SetupAsyncStepState | undefined,
): SetupAsyncStepState {
  return value === 'completed' || value === 'skipped' ? value : 'pending';
}

function parseSetupAsyncSession(value: string | null): SetupAsyncSession {
  if (!value) {
    return createEmptySetupAsyncSession();
  }

  try {
    const parsed = JSON.parse(value) as Partial<SetupAsyncSession>;
    return {
      version: 1,
      onboardingTask: {
        taskId:
          typeof parsed.onboardingTask?.taskId === 'string'
            ? parsed.onboardingTask.taskId
            : null,
        postOnboardingUnlocked:
          parsed.onboardingTask?.postOnboardingUnlocked === true,
      },
      suggestedTasksStep: {
        state: parseStepState(parsed.suggestedTasksStep?.state),
      },
      communicationStep: {
        state: parseStepState(parsed.communicationStep?.state),
      },
    };
  } catch {
    return createEmptySetupAsyncSession();
  }
}

function readSetupAsyncSession(storageKey: string | null): SetupAsyncSession {
  if (!storageKey || typeof window === 'undefined') {
    return createEmptySetupAsyncSession();
  }

  try {
    return parseSetupAsyncSession(window.localStorage.getItem(storageKey));
  } catch {
    return createEmptySetupAsyncSession();
  }
}

function resetPostOnboardingSteps(
  taskId: string | null,
): Pick<SetupAsyncSession, 'onboardingTask' | 'suggestedTasksStep'> {
  return {
    onboardingTask: {
      taskId,
      postOnboardingUnlocked: false,
    },
    suggestedTasksStep: {
      state: 'pending',
    },
  };
}

export function useSetupAsyncSession({
  currentTaskId,
}: {
  currentTaskId: string | null;
}) {
  const storageKey = useMemo(() => `${STORAGE_KEY_PREFIX}:deployment`, []);
  const [session, setSession] = useState<SetupAsyncSession>(() =>
    createEmptySetupAsyncSession(),
  );
  const [hydrated, setHydrated] = useState(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSession(readSetupAsyncSession(storageKey));
    setHydrated(true);
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated || !storageKey) {
      return;
    }

    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;

      try {
        window.localStorage.setItem(storageKey, JSON.stringify(session));
      } catch {
        // Ignore localStorage failures.
      }
    }, PERSIST_DEBOUNCE_MS);

    return () => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [hydrated, session, storageKey]);

  useEffect(() => {
    setSession((previous) => {
      if (previous.onboardingTask.taskId === currentTaskId) {
        return previous;
      }

      return {
        ...previous,
        ...resetPostOnboardingSteps(currentTaskId),
      };
    });
  }, [currentTaskId]);

  const updateSession = useCallback(
    (updater: (current: SetupAsyncSession) => SetupAsyncSession) => {
      setSession((current) => updater(current));
    },
    [],
  );

  const setSuggestedTasksStepState = useCallback(
    (state: SetupAsyncStepState) => {
      updateSession((current) => ({
        ...current,
        suggestedTasksStep: {
          state,
        },
      }));
    },
    [updateSession],
  );

  const setCommunicationStepState = useCallback(
    (state: SetupAsyncStepState) => {
      updateSession((current) => ({
        ...current,
        communicationStep: {
          state,
        },
      }));
    },
    [updateSession],
  );

  const unlockPostOnboardingFlow = useCallback(() => {
    updateSession((current) => ({
      ...current,
      onboardingTask: {
        ...current.onboardingTask,
        postOnboardingUnlocked: true,
      },
    }));
  }, [updateSession]);

  return {
    hydrated,
    session,
    unlockPostOnboardingFlow,
    setSuggestedTasksStepState,
    setCommunicationStepState,
  };
}
