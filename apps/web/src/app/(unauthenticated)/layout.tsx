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
      frameClassName="h-[calc(var(--effective-viewport-height)-0.25rem)] w-[calc(100svw-0.25rem)] scroll-minimal overflow-hidden"
      surfaceClassName="light flex flex-col !overflow-y-auto !overflow-x-hidden text-foreground md:items-center"
      style={{
        height: 'var(--effective-viewport-height)',
        minHeight: 'var(--effective-viewport-height)',
      }}
    >
      <div className="relative flex w-full max-w-3xl flex-col md:min-h-full">
        <div className="pointer-events-none absolute inset-y-0 left-0 hidden border-black border-l-2 border-dotted md:block" />
        <div className="flex w-full flex-col px-4 py-6 space-y-4 md:my-auto md:px-0 md:py-10 md:pl-6">
          <RoomoteWordmark className="mb-8 h-14 w-fit shrink-0" />
          {children}
        </div>
      </div>
    </FramedSurface>
  );
}
