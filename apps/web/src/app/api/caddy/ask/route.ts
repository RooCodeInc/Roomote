import { NextRequest, NextResponse } from 'next/server';
import { resolveEffectivePreviewRuntimeConfig } from '@roomote/db/server';

import { Env } from '@/lib/server';

const PREVIEW_SUBDOMAIN_LABEL_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

// Every preview subdomain starts with a 13-char base36 taskId (see
// buildPreviewProxyUrl in @roomote/types). Requiring that prefix keeps
// on-demand TLS issuance scoped to hostnames that can belong to a task —
// with flat preview hostnames the preview domain is the app domain itself,
// so approving arbitrary labels would let scanner probes of first-level
// subdomains burn the Let's Encrypt per-domain rate limit.
const PREVIEW_TASK_ID_PREFIX_PATTERN = /^[0-9a-z]{13}-/;

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

interface PreviewHostConfig {
  previewHostname: string | null;
  subdomainSuffix: string | null;
}

async function getPreviewHostConfig(): Promise<PreviewHostConfig> {
  const resolvedPreviewRuntimeConfig =
    await resolveEffectivePreviewRuntimeConfig({
      runtimeEnv: process.env,
      defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
      defaultPreviewDomains: Env.PREVIEW_DOMAINS,
    });

  return {
    previewHostname: normalizeHostname(
      resolvedPreviewRuntimeConfig.effective.roomotePreviewDomain ??
        resolvedPreviewRuntimeConfig.effective.previewProxyBaseUrl,
    ),
    subdomainSuffix:
      resolvedPreviewRuntimeConfig.effective.previewProxySubdomainSuffix ??
      null,
  };
}

export function isAllowedCaddyPreviewDomain(
  domain: string | null | undefined,
  previewHostname: string | null,
  subdomainSuffix?: string | null,
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

  if (
    previewLabel.includes('.') ||
    !PREVIEW_SUBDOMAIN_LABEL_PATTERN.test(previewLabel) ||
    !PREVIEW_TASK_ID_PREFIX_PATTERN.test(previewLabel)
  ) {
    return false;
  }

  return (
    !subdomainSuffix ||
    previewLabel.endsWith(`-${subdomainSuffix.toLowerCase()}`)
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { previewHostname, subdomainSuffix } = await getPreviewHostConfig();

  if (!previewHostname) {
    return new NextResponse('Preview domain is not configured', {
      status: 503,
    });
  }

  const domain = request.nextUrl.searchParams.get('domain');

  if (!domain) {
    return new NextResponse('Missing domain', { status: 400 });
  }

  if (!isAllowedCaddyPreviewDomain(domain, previewHostname, subdomainSuffix)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  return new NextResponse('OK');
}
