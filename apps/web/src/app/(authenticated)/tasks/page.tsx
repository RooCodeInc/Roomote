'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import { Tasks } from './Tasks';
import { useAuthorizedUser } from '@/hooks/useUser';

export default function Page() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { featureFlags } = useAuthorizedUser();
  const error = searchParams.get('error');

  useEffect(() => {
    if (error) {
      toast.error('An error occurred. Please try again.');
    }
  }, [error]);

  useEffect(() => {
    if (featureFlags?.sessions_ui !== true) return;
    const mapped = new URLSearchParams();
    mapped.set('scope', 'tasks');
    const mappings = [
      ['userId', 'user'],
      ['timePeriod', 'period'],
      ['repositoryName', 'repository'],
      ['pullRequest', 'pullRequest'],
      ['model', 'model'],
      ['view', 'view'],
    ] as const;
    for (const [from, to] of mappings) {
      const value = searchParams.get(from);
      if (value) mapped.set(to, value);
    }
    router.replace(`/sessions?${mapped.toString()}`);
  }, [featureFlags?.sessions_ui, router, searchParams]);

  if (featureFlags?.sessions_ui === true) return null;

  return <Tasks />;
}
