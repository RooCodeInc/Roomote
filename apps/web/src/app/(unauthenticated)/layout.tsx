'use client';

import { PreSessionBackdrop, RoomoteWordmark } from '@/components/layout';

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PreSessionBackdrop>
      <div className="light flex h-effective-viewport w-full flex-col overflow-x-hidden overflow-y-auto p-3 text-foreground scroll-minimal sm:p-5 md:items-center lg:p-8">
        <div className="relative flex w-full max-w-3xl flex-col md:min-h-full">
          <div className="pointer-events-none absolute inset-y-0 left-0 hidden border-black border-l-2 border-dotted md:block" />
          <div className="flex w-full flex-col space-y-4 px-4 py-6 md:my-auto md:px-0 md:py-10 md:pl-6">
            <RoomoteWordmark className="mb-8 h-14 w-fit shrink-0" />
            {children}
          </div>
        </div>
      </div>
    </PreSessionBackdrop>
  );
}
