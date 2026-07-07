'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { EmphaticResult } from '@/components/EmphaticResult';
import { useUser } from '@/hooks/useUser';
import { useAuthState } from '@/hooks/useAuthState';
import { usePostAuthRedirect } from '@/hooks/usePostAuthRedirect';

export default function Page() {
  const router = useRouter();

  const { isSignedIn } = useUser();

  const authState = useAuthState();

  const { redirect, clear } = usePostAuthRedirect();
  const [capturedRedirect] = useState(() => redirect);

  useEffect(() => {
    let path;

    if (!isSignedIn) {
      path = authState.params
        ? `/sign-in?${authState.params.toString()}`
        : '/sign-in';
    } else if (capturedRedirect) {
      clear();
      path = capturedRedirect;
    } else {
      path = authState.params
        ? `/extension/sign-in?${authState.params.toString()}`
        : '/';
    }

    router.replace(path);
  }, [router, isSignedIn, authState.params, capturedRedirect, clear]);

  return (
    <div className="flex justify-center">
      <EmphaticResult success={isSignedIn} />
    </div>
  );
}
