'use client';

import { useEffect } from 'react';

export const useMount = (fn: () => void) => {
  useEffect(() => fn(), []); // eslint-disable-line react-hooks/exhaustive-deps
};
