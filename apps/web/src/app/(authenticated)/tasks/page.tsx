'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import { Tasks } from './Tasks';

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
