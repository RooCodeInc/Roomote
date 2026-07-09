import { NextRequest } from 'next/server';

import { validateAuthToken, validateJobToken } from '@roomote/auth';
import { isUserToken } from '@roomote/types';
import { db, eq, users } from '@roomote/db/server';

import type {
  UserAuthSuccess,
  UserAuthTokenSuccess,
  JobAuthTokenSuccess,
  AuthError,
} from '@/types';

import { authorize } from './auth-context';

export async function authorizeUserToken(
  request: NextRequest,
): Promise<UserAuthTokenSuccess | UserAuthSuccess | AuthError> {
  const authHeader = request.headers.get('authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return authorize();
  }

  const token = authHeader.slice(7);

  if (!token) {
    return {
      success: false,
      error: 'Unauthorized: Malformed authorization header',
    };
  }

  try {
    const tokenContext = await validateAuthToken(token);

    if (!isUserToken(tokenContext)) {
      throw new Error('Unauthorized: Malformed authorization header');
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, tokenContext.userId),
    });

    // Removed users keep no standing access: their API keys die with them.
    if (!user || user.deletedAt != null) {
      return {
        success: false,
        error: 'Unauthorized: User has been removed',
      };
    }

    const response: Pick<
      UserAuthTokenSuccess,
      'success' | 'userType' | 'userId' | 'name' | 'primaryEmail'
    > = {
      success: true,
      userType: 'user',
      userId: tokenContext.userId,
      name: user.name,
      primaryEmail: user.email,
    };

    return {
      ...response,
      isAdmin: user.role === 'admin',
    };
  } catch {
    return authorize();
  }
}

export async function authorizeJobToken(
  request: NextRequest,
): Promise<JobAuthTokenSuccess | UserAuthSuccess | AuthError> {
  const authHeader = request.headers.get('authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return authorize();
  }

  const token = authHeader.slice(7);

  if (!token) {
    return {
      success: false,
      error: 'Unauthorized: Malformed authorization header',
    };
  }

  try {
    const tokenContext = await validateJobToken(token);

    // Deployment-principal job tokens carry no user; skip the lookup rather
    // than resolving an arbitrary user for them.
    const user = tokenContext.userId
      ? await db.query.users.findFirst({
          where: eq(users.id, tokenContext.userId),
        })
      : undefined;

    const response: Pick<
      JobAuthTokenSuccess,
      'success' | 'userType' | 'cloudJobId' | 'userId' | 'name' | 'primaryEmail'
    > = {
      success: true,
      userType: 'job',
      cloudJobId: tokenContext.cloudJobId,
      userId: tokenContext.userId,
      name: user?.name ?? 'Unknown',
      primaryEmail: user?.email ?? '',
    };

    return {
      ...response,
      isAdmin: false, // Job tokens are never admin.
    };
  } catch {
    return authorize();
  }
}
