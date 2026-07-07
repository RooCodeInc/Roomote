'use client';

import { useRouter } from 'next/navigation';

import { useAuthorizedUser } from '@/hooks/useUser';
import { useMount } from '@/hooks/useMount';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { isAdmin } = useAuthorizedUser();

  useMount(() => {
    if (!isAdmin) {
      router.replace('/');
    }
  });

  return isAdmin ? children : null;
}
