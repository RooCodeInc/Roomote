import { proxyRemoteMcpRequest } from '@/lib/server/remote-mcp-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (request: Parameters<typeof proxyRemoteMcpRequest>[0]) =>
  proxyRemoteMcpRequest(request, 'metadata');
