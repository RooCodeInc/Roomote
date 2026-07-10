import { type AppRouterInput, client } from './client';

export const me = () => client.auth.me.query();

export const createRunToken = (
  options: AppRouterInput['auth']['createRunToken'],
) => client.auth.createRunToken.mutate(options);

export const createAuthToken = (
  options: AppRouterInput['auth']['createAuthToken'],
) => client.auth.createAuthToken.mutate(options);
