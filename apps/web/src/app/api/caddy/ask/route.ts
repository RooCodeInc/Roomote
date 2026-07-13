import { NextRequest, NextResponse } from 'next/server';
import { resolveEffectivePreviewRuntimeConfig } from '@roomote/db/server';

import { Env } from '@/lib/server';

const PREVIEW_SUBDOMAIN_LABEL_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function normalizeHostname(value: string | null | undefined): string | null {
  const rawValue = value?.trim();

  if (!rawValue) {
    return null;
  }

  try {
    return new URL(
      rawValue.includes('://') ? rawValue : `https://${rawValue}`,
    ).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function getPreviewHostname(): Promise<string | null> {
  const resolvedPreviewRuntimeConfig =
    await resolveEffectivePreviewRuntimeConfig({
      runtimeEnv: process.env,
      defaultPreviewProxyBaseUrl: Env.R_PREVIEW_PROXY_BASE_URL,
      defaultPreviewDomains: Env.R_PREVIEW_DOMAINS,
    });

  return normalizeHostname(
    resolvedPreviewRuntimeConfig.effective.roomotePreviewDomain ??
      resolvedPreviewRuntimeConfig.effective.previewProxyBaseUrl,
  );
}

export function isAllowedCaddyPreviewDomain(
  domain: string | null | undefined,
  previewHostname: string | null,
): boolean {
  const normalizedDomain = normalizeHostname(domain);

  if (!normalizedDomain || !previewHostname) {
    return false;
  }

  if (normalizedDomain === previewHostname) {
    return true;
  }

  const suffix = `.${previewHostname}`;

  if (!normalizedDomain.endsWith(suffix)) {
    return false;
  }

  const previewLabel = normalizedDomain.slice(0, -suffix.length);

  return (
    !previewLabel.includes('.') &&
    PREVIEW_SUBDOMAIN_LABEL_PATTERN.test(previewLabel)
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const previewHostname = await getPreviewHostname();

  if (!previewHostname) {
    return new NextResponse('Preview domain is not configured', {
      status: 503,
    });
  }

  const domain = request.nextUrl.searchParams.get('domain');

  if (!domain) {
    return new NextResponse('Missing domain', { status: 400 });
  }

  if (!isAllowedCaddyPreviewDomain(domain, previewHostname)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  return new NextResponse('OK');
}
