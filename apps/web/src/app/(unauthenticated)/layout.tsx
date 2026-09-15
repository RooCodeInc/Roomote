'use client';

import {
  FramedSurface,
  PreSessionBackdrop,
  RoomoteWordmark,
} from '@/components/layout';

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PreSessionBackdrop>
      <FramedSurface
        variant="bold"
        frameClassName="h-effective-viewport w-full scroll-minimal overflow-hidden bg-transparent p-3 sm:p-5 lg:p-8"
        surfaceClassName="light flex flex-col !overflow-y-auto !overflow-x-hidden border border-white/70 bg-white/90 text-foreground shadow-2xl backdrop-blur-xl md:items-center"
      >
        <div className="relative flex w-full max-w-3xl flex-col md:min-h-full">
          <div className="pointer-events-none absolute inset-y-0 left-0 hidden border-black border-l-2 border-dotted md:block" />
          <div className="flex w-full flex-col space-y-4 px-4 py-6 md:my-auto md:px-0 md:py-10 md:pl-6">
            <RoomoteWordmark className="mb-8 h-14 w-fit shrink-0" />
            {children}
          </div>
        </div>
      </FramedSurface>
    </PreSessionBackdrop>
  );
}
