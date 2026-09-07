'use client';

import { useEffect, useState } from 'react';

interface LocalDateTimeProps {
  date: Date;
  dateStyle?: Intl.DateTimeFormatOptions['dateStyle'];
  timeStyle?: Intl.DateTimeFormatOptions['timeStyle'];
  className?: string;
}

/**
 * Renders a date in the viewer's locale and timezone without a hydration
 * mismatch. Locale-dependent formatting can't go into server-rendered HTML:
 * the server formats in its own locale/timezone while the browser formats in
 * the viewer's, and the differing text triggers React error #418. Server HTML
 * and the first client render therefore emit an empty <time> (with the ISO
 * timestamp in its dateTime attribute), and the localized text fills in after
 * mount.
 */
export function LocalDateTime({
  date,
  dateStyle = 'medium',
  timeStyle = 'short',
  className,
}: LocalDateTimeProps) {
  // Depend on the timestamp value: a Date prop is often a fresh object each
  // render, and identity-based deps would re-run the effect every render.
  const timestamp = date.getTime();
  const [formatted, setFormatted] = useState<string | null>(null);
  useEffect(() => {
    setFormatted(
      new Date(timestamp).toLocaleString(undefined, { dateStyle, timeStyle }),
    );
  }, [timestamp, dateStyle, timeStyle]);

  return (
    <time dateTime={date.toISOString()} className={className}>
      {formatted}
    </time>
  );
}
