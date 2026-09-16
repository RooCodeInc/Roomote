'use client';

import { useState } from 'react';

import { Integrations } from '@/components/settings/Integrations';
import { SettingsShell } from '@/components/settings/SettingsShell';
import {
  Blocks,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  HousePlug,
  Plus,
  UserRoundKey,
} from '@/components/system';

export type AddIntegrationRequest = {
  type: 'catalog' | 'custom-mcp' | 'api-key';
  sequence: number;
};

export function IntegrationsSettingsPage() {
  const [addRequest, setAddRequest] = useState<AddIntegrationRequest | null>(
    null,
  );
  const requestAdd = (type: AddIntegrationRequest['type']) =>
    setAddRequest((current) => ({
      type,
      sequence: (current?.sequence ?? 0) + 1,
    }));

  return (
    <SettingsShell
      pageId="integrations"
      boundedContentOnDesktop
      showHeaderActionOnMobile
      headerAction={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm">
              <Plus />
              Add integration
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => requestAdd('catalog')}>
              <Blocks />
              From the catalog
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => requestAdd('custom-mcp')}>
              <HousePlug />
              Custom MCP
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => requestAdd('api-key')}>
              <UserRoundKey />
              API-key based
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <Integrations addRequest={addRequest} />
    </SettingsShell>
  );
}
