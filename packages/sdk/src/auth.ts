import { type AppRouterInput, client } from './client';

export const me = () => client.auth.me.query();

export const createJobToken = (
  options: AppRouterInput['auth']['createJobToken'],
) => client.auth.createJobToken.mutate(options);

export const createAuthToken = (
  options: AppRouterInput['auth']['createAuthToken'],
) => client.auth.createAuthToken.mutate(options);
