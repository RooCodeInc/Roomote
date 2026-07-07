import AuthenticatedLayoutClient from './AuthenticatedLayoutClient';

export const dynamic = 'force-dynamic';

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthenticatedLayoutClient>{children}</AuthenticatedLayoutClient>;
}
