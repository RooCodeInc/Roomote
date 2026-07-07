'use client';

import { useEffect } from 'react';

export function LegacySettingsRedirectPage({
  targetPath,
}: {
  targetPath: string;
}) {
  useEffect(() => {
    const { hash, search } = window.location;
    window.location.replace(`${targetPath}${search}${hash}`);
  }, [targetPath]);

  return null;
}
