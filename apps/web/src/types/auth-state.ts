export enum AuthStateParam {
  State = 'state',
  AuthRedirect = 'auth_redirect',
}

export type AuthState = {
  state?: string;
  authRedirect?: string;
  params?: URLSearchParams;
};
