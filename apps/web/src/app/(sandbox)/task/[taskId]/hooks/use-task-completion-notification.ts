'use client';

import { useEffect, useRef, useCallback } from 'react';

import type { TaskPhase } from '@roomote/types';

const NOTIFICATION_SOUND_URL = '/sounds/notification-beep.mp3';

const RESUMING_SESSION_STATE = 'resuming';

const INTERACTIVE_SESSION_STATE = 'interactive';

/** Phases that should draw user attention (done or needs input). */
const ATTENTION_PHASES = new Set<TaskPhase>([
  'idle',
  'waiting_for_prompt',
  'waiting_for_user_input',
]);

/** Phases that represent "task is actively working". */
const ACTIVE_PHASES = new Set<TaskPhase>(['running']);

/**
 * Size of the green circle indicator relative to the favicon dimension.
 * e.g. 0.35 means the circle diameter is 35% of the favicon size.
 */
const DOT_RATIO = 0.35;

/**
 * Draw a green circle overlay on a favicon image and return the modified
 * image as a data URL.
 */
function addGreenDotToFavicon(
  img: HTMLImageElement,
  size: number,
): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return null;
  }

  ctx.drawImage(img, 0, 0, size, size);

  const dotRadius = (size * DOT_RATIO) / 2;
  const cx = size - dotRadius - 1;
  const cy = size - dotRadius - 1;

  // White border ring for contrast.
  ctx.beginPath();
  ctx.arc(cx, cy, dotRadius + 1, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Green circle.
  ctx.beginPath();
  ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
  ctx.fillStyle = '#22c55e';
  ctx.fill();

  return canvas.toDataURL('image/png');
}

/**
 * Find the <link rel="icon"> elements in the document head.
 */
function getFaviconLinks(): HTMLLinkElement[] {
  return Array.from(
    document.querySelectorAll<HTMLLinkElement>(
      'link[rel="icon"], link[rel="shortcut icon"]',
    ),
  );
}

interface FaviconState {
  original: Map<HTMLLinkElement, string>;
  modified: boolean;
}

function saveFaviconState(): FaviconState {
  const links = getFaviconLinks();
  const original = new Map<HTMLLinkElement, string>();

  for (const link of links) {
    original.set(link, link.href);
  }

  return { original, modified: false };
}

function restoreFavicon(state: FaviconState): void {
  if (!state.modified) {
    return;
  }

  for (const [link, href] of state.original) {
    link.href = href;
  }

  state.modified = false;
}

async function setNotificationFavicon(state: FaviconState): Promise<void> {
  state.modified = true;
  const links = getFaviconLinks();

  for (const link of links) {
    const size = Number.parseInt(
      link.getAttribute('sizes')?.split('x')[0] ?? '32',
      10,
    );

    const img = new Image();
    img.crossOrigin = 'anonymous';

    const dataUrl = await new Promise<string | null>((resolve) => {
      img.onload = () => resolve(addGreenDotToFavicon(img, size));
      img.onerror = () => resolve(null);
      img.src = state.original.get(link) ?? link.href;
    });

    if (!state.modified) {
      return;
    }

    if (dataUrl) {
      link.href = dataUrl;
    }
  }
}

function playNotificationSound(): HTMLAudioElement {
  const audio = new Audio(NOTIFICATION_SOUND_URL);
  audio.volume = 0.5;
  audio.play().catch(() => {
    // Browser may block autoplay — silently ignore.
  });

  return audio;
}

/**
 * Watches the sandbox task phase and triggers a notification (beep sound +
 * green-dot favicon) when either:
 * - the task transitions from an active phase to an attention phase, or
 * - a task finishes resuming and becomes interactive in an attention phase.
 *
 * Clears the modified favicon when the tab regains focus.
 */
export function useTaskCompletionNotification(
  phase: TaskPhase | undefined,
  options?: {
    sessionState?: string | null;
  },
): void {
  const prevPhaseRef = useRef<TaskPhase | undefined>(undefined);
  const prevSessionStateRef = useRef<string | null | undefined>(undefined);
  const pendingResumeReadyNotificationRef = useRef(false);
  const faviconStateRef = useRef<FaviconState | null>(null);
  const hasPendingHiddenNotificationRef = useRef(false);
  const pendingAudioRef = useRef<HTMLAudioElement | null>(null);

  // Lazily capture the original favicon hrefs once.
  const ensureFaviconState = useCallback(() => {
    if (!faviconStateRef.current) {
      faviconStateRef.current = saveFaviconState();
    }

    return faviconStateRef.current;
  }, []);

  const clearPendingNotification = useCallback(() => {
    hasPendingHiddenNotificationRef.current = false;
    pendingAudioRef.current?.pause();
    pendingAudioRef.current = null;

    if (faviconStateRef.current?.modified) {
      restoreFavicon(faviconStateRef.current);
    }
  }, []);

  const notifyHiddenAttention = useCallback(() => {
    if (!document.hidden) {
      return;
    }

    const state = ensureFaviconState();
    setNotificationFavicon(state);

    if (hasPendingHiddenNotificationRef.current) {
      return;
    }

    hasPendingHiddenNotificationRef.current = true;
    const audio = playNotificationSound();
    pendingAudioRef.current = audio;
    audio.addEventListener(
      'ended',
      () => {
        if (pendingAudioRef.current === audio) {
          pendingAudioRef.current = null;
        }
      },
      { once: true },
    );
  }, [ensureFaviconState]);

  // Handle focus to clear the notification favicon.
  useEffect(() => {
    const handleVisible = () => {
      if (!document.hidden) {
        clearPendingNotification();
      }
    };

    window.addEventListener('focus', handleVisible);
    document.addEventListener('visibilitychange', handleVisible);

    return () => {
      window.removeEventListener('focus', handleVisible);
      document.removeEventListener('visibilitychange', handleVisible);
      clearPendingNotification();
    };
  }, [clearPendingNotification]);

  const sessionState = options?.sessionState;

  // React to phase transitions.
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    if (!phase || !prev) {
      return;
    }

    // Only trigger when transitioning from an active phase to an attention phase
    // AND the tab is not currently visible (user is in another tab/window).
    const wasActive = ACTIVE_PHASES.has(prev);
    const isNowAttention = ATTENTION_PHASES.has(phase);

    if (wasActive && isNowAttention) {
      notifyHiddenAttention();
    }
  }, [phase, notifyHiddenAttention]);

  // Notify when a sleeping task finishes waking up and is ready again.
  useEffect(() => {
    const prevSessionState = prevSessionStateRef.current;
    prevSessionStateRef.current = sessionState;

    if (
      prevSessionState === RESUMING_SESSION_STATE &&
      sessionState === INTERACTIVE_SESSION_STATE
    ) {
      pendingResumeReadyNotificationRef.current = true;
    }

    if (!pendingResumeReadyNotificationRef.current || !phase) {
      return;
    }

    pendingResumeReadyNotificationRef.current = false;

    if (ATTENTION_PHASES.has(phase)) {
      notifyHiddenAttention();
    }
  }, [notifyHiddenAttention, phase, sessionState]);
}

/**
 * Exported utilities for Storybook / testing.
 */
export const _testUtils = {
  playNotificationSound,
  setNotificationFavicon,
  restoreFavicon,
  saveFaviconState,
};
