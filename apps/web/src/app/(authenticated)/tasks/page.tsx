'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import { Tasks } from './Tasks';

// Sessions is the primary workspace; this page is intentionally unlinked from
// the primary nav but stays fully functional for direct URLs and deep links.
export default function Page() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

  useEffect(() => {
    if (error) {
      toast.error('An error occurred. Please try again.');
    }
  }, [error]);

  return <Tasks />;
}
