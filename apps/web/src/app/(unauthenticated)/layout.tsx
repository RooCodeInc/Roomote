'use client';

import { FramedSurface, RoomoteWordmark } from '@/components/layout';

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <FramedSurface
      variant="bold"
      frameClassName="items-center justify-center"
      surfaceClassName="light flex items-center justify-center text-foreground"
      style={{
        height: 'var(--effective-viewport-height)',
        minHeight: 'var(--effective-viewport-height)',
      }}
    >
      <div className="flex max-h-full min-h-0 w-full flex-col items-center gap-8 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <RoomoteWordmark className="h-20 shrink-0" />
        {children}
      </div>
    </FramedSurface>
  );
}
