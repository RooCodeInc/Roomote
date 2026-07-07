'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { LucideIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A command that can be registered by any component / page. */
export interface PaletteCommand {
  /** Unique id for the command (used as React key and for deduplication). */
  id: string;
  /** Icon rendered next to the label. */
  icon: LucideIcon;
  /** Human-readable label shown in the palette. */
  label: string;
  /** Callback executed when the command is selected. */
  action: () => void;
  /**
   * Optional group heading. Commands sharing the same group are rendered
   * together under that heading. Defaults to "Actions".
   */
  group?: string;
  /**
   * Optional keywords that improve search matching but aren't displayed.
   * The cmdk library uses the `keywords` prop on CommandItem for this.
   */
  keywords?: string[];
}

// ---------------------------------------------------------------------------
// Context value
// ---------------------------------------------------------------------------

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** All currently-registered dynamic commands. */
  commands: PaletteCommand[];
  /**
   * Register one or more commands. Returns an unregister function that MUST be
   * called on cleanup (e.g. inside a useEffect return).
   */
  registerCommands: (commands: PaletteCommand[]) => () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue>({
  open: false,
  setOpen: () => {},
  commands: [],
  registerCommands: () => () => {},
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  // Map of registrant-id → commands they registered.
  // Using a Map keyed by a unique caller id avoids array scanning on cleanup.
  const [registry, setRegistry] = useState<Map<string, PaletteCommand[]>>(
    () => new Map(),
  );

  const registerCommands = useCallback(
    (cmds: PaletteCommand[]): (() => void) => {
      // Simple unique key per registration call
      const key = `reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setRegistry((prev) => {
        const next = new Map(prev);
        next.set(key, cmds);
        return next;
      });
      return () => {
        setRegistry((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      };
    },
    [],
  );

  // Flatten all registered commands into a single array.
  const commands = Array.from(registry.values()).flat();

  return (
    <CommandPaletteContext.Provider
      value={{ open, setOpen, commands, registerCommands }}
    >
      {children}
    </CommandPaletteContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useCommandPalette() {
  return useContext(CommandPaletteContext);
}

/**
 * Register page-specific (or component-specific) commands that appear in the
 * command palette while the calling component is mounted. Commands are
 * automatically removed when the component unmounts.
 *
 * @example
 * ```tsx
 * useRegisterCommands([
 *   { id: 'delete-task', icon: Trash, label: 'Delete Task', action: handleDelete },
 * ]);
 * ```
 */
export function useRegisterCommands(commands: PaletteCommand[]) {
  const { registerCommands } = useCommandPalette();
  // Serialize command ids to detect when the list actually changes.
  const key = commands.map((c) => c.id).join(',');

  useEffect(() => {
    if (commands.length === 0) return;
    return registerCommands(commands);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures identity
  }, [key, registerCommands]);
}
