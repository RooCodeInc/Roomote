export function buildSignInRedirectUrl(relativePath: string): string {
  const params = new URLSearchParams({
    redirect_url: relativePath || '/',
  });

  return `/sign-in?${params.toString()}`;
}
