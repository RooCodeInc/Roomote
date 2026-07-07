/**
 * Z-Index Scale
 *
 * This file defines the z-index hierarchy for the application to ensure
 * proper layering of UI elements across mobile and desktop.
 *
 * Hierarchy (from bottom to top):
 * - Base elevated elements (hover states, cards)
 * - Floating action buttons
 * - Sticky navigation header
 * - Mobile navigation drawer
 * - Sticky compact task header
 * - Dialogs, Modals, Popovers
 * - Toast notifications
 * - Critical system messages
 */

export const Z_INDEX = {
  // Base layer elements
  BASE: 10, // Hover states, elevated cards, etc.

  // Floating elements
  FLOATING_BUTTON: 20, // Scroll to bottom button, FABs
  MESSAGE_INPUT: 20, // Message input area (below nav but above content)

  // Navigation
  NAV_HEADER: 30, // Main sticky navigation header
  NAV_DRAWER: 40, // Mobile navigation drawer

  // Task-specific UI
  TASK_STICKY_HEADER: 60, // Compact sticky task header

  // Overlays and modals
  DIALOG: 70, // Dialogs, modals, and their overlays
  POPOVER: 70, // Popovers, dropdowns, tooltips

  // Notifications
  TOAST: 80, // Toast notifications

  // System-level
  SYSTEM: 90, // Critical system messages
  MAX: 999, // Maximum z-index (use sparingly)
} as const;

// Mapping of z-index levels to Tailwind static class names
const Z_INDEX_CLASS_MAP = {
  BASE: 'z-base',
  FLOATING_BUTTON: 'z-floating-button',
  MESSAGE_INPUT: 'z-message-input',
  NAV_HEADER: 'z-nav-header',
  NAV_DRAWER: 'z-nav-drawer',
  TASK_STICKY_HEADER: 'z-task-sticky-header',
  DIALOG: 'z-dialog',
  POPOVER: 'z-popover',
  TOAST: 'z-toast',
  SYSTEM: 'z-system',
  MAX: 'z-max',
} as const;

// Helper function to get z-index as Tailwind class
// Returns static class names that Tailwind JIT can detect at build time
export function zIndex(level: keyof typeof Z_INDEX): string {
  return Z_INDEX_CLASS_MAP[level];
}
