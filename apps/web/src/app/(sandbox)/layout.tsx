import { CommandPalette } from '@/components/layout/CommandPalette';
import { CommandPaletteProvider } from '@/components/layout/CommandPaletteContext';

import { SandboxShell } from './SandboxShell';

interface SandboxLayoutProps {
  children: React.ReactNode;
}

export default function SandboxLayout({ children }: SandboxLayoutProps) {
  return (
    <CommandPaletteProvider>
      <SandboxShell>{children}</SandboxShell>
      <CommandPalette />
    </CommandPaletteProvider>
  );
}
