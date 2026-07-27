'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import { MCP_INTEGRATIONS } from '@roomote/types';

import {
  getMcpOAuthResultMessage,
  parseMcpOAuthResult,
} from '@/lib/mcp-oauth-result';

const MCP_INTEGRATION_NAME_BY_ID = new Map(
  MCP_INTEGRATIONS.map((integration) => [integration.id, integration.name]),
);

export function McpOAuthResultFeedback() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const handledResultRef = useRef<string | null>(null);

  useEffect(() => {
    const currentSearchParams = new URLSearchParams(searchParamsString);
    const result = parseMcpOAuthResult(
      currentSearchParams.get('mcp'),
      currentSearchParams.get('reason'),
    );
    if (!result || handledResultRef.current === searchParamsString) {
      return;
    }
    handledResultRef.current = searchParamsString;

    const serviceId = currentSearchParams.get('service')?.trim() ?? '';
    const serviceName = MCP_INTEGRATION_NAME_BY_ID.get(serviceId) ?? null;
    const message = getMcpOAuthResultMessage(result, serviceName);
    if (result.status === 'connected') {
      toast.success(message);
    } else {
      toast.error(message);
    }

    currentSearchParams.delete('mcp');
    currentSearchParams.delete('reason');
    const nextSearch = currentSearchParams.toString();
    window.history.replaceState(
      null,
      '',
      nextSearch ? `${pathname}?${nextSearch}` : pathname,
    );
  }, [pathname, searchParamsString]);

  return null;
}
