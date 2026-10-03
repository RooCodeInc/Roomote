import { type AppRouterInput, client } from './client';

export const me = () => client.auth.me.query();

export const createAuthToken = (
  options: AppRouterInput['auth']['createAuthToken'],
) => client.auth.createAuthToken.mutate(options);
