import type { ComponentProps, ReactNode } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTriangle,
  Info,
} from '@/components/system';
import { DOCS_BASE_URL } from '@/lib/docs';

function DocsLink({ href = '', ...props }: ComponentProps<'a'>) {
  if (href.startsWith('/')) {
    return <a href={`${DOCS_BASE_URL}${href}`} {...props} />;
  }

  return <a href={href} {...props} />;
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <Alert variant="warning" className="my-6">
      <AlertTriangle />
      <AlertDescription className="block [&_p]:m-0">
        {children}
      </AlertDescription>
    </Alert>
  );
}

function Tip({ children }: { children: ReactNode }) {
  return (
    <Alert variant="notice" className="my-6">
      <Info />
      <AlertDescription className="block [&_p]:m-0">
        {children}
      </AlertDescription>
    </Alert>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="my-6 space-y-5">{children}</ol>;
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="relative border-l border-border pl-5 before:absolute before:-left-2 before:grid before:size-4 before:place-items-center before:rounded-full before:bg-primary before:text-[10px] before:font-semibold before:text-primary-foreground before:content-[counter(list-item)]">
      <p className="font-medium">{title}</p>
      <div className="mt-1 [&_p]:my-0">{children}</div>
    </li>
  );
}

function IntegrationName({
  href,
  icon,
  name,
}: {
  href: string;
  icon: string;
  name: string;
}) {
  const manualIcons: Record<string, string> = {
    daytona: '/docs/logo/integrations/daytona.svg',
    e2b: '/docs/logo/integrations/e2b.svg',
    blaxel: '/docs/logo/integrations/blaxel.svg',
  };
  const iconSrc =
    manualIcons[icon] ??
    (icon.startsWith('/')
      ? `/docs${icon}`
      : `https://api.iconify.design/simple-icons:${icon}.svg?color=currentColor`);

  return (
    <DocsLink href={href} className="inline-flex items-center gap-1.5">
      {/* This mirrors the Mintlify snippet and external icons do not need Next optimization. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={iconSrc} alt="" aria-hidden className="size-4" />
      <span>{name}</span>
    </DocsLink>
  );
}

export const docsMdxComponents = {
  a: DocsLink,
  Warning,
  Tip,
  Steps,
  Step,
  IntegrationName,
};
