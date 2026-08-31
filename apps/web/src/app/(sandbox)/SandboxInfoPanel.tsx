import type { ReactNode } from 'react';

import { SandboxSidePanelHeader } from './SandboxSidePanelHeader';

export function SandboxInfoPanel({
  title,
  onClose,
  closeLabel,
  header,
  children,
}: {
  title: string;
  onClose: () => void;
  closeLabel?: string;
  header?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      {header ?? (
        <SandboxSidePanelHeader
          title={title}
          onClose={onClose}
          closeLabel={closeLabel}
        />
      )}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-6">{children}</div>
      </div>
    </>
  );
}

export function SandboxInfoRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <tr>
      <td className="py-1 pr-4 align-top whitespace-nowrap">{label}</td>
      <td className="ph-no-capture min-w-0 py-1 break-all">{children}</td>
    </tr>
  );
}

export function SandboxInfoTable({ children }: { children: ReactNode }) {
  return (
    <table className="text-sm">
      <tbody>{children}</tbody>
    </table>
  );
}
