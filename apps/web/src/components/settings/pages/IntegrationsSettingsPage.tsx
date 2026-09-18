'use client';

import { useState } from 'react';

import { Integrations } from '@/components/settings/Integrations';
import { PRODUCT_NAME } from '@roomote/types';
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

type AddIntegrationRequest = {
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
    <div className="min-h-full w-full overflow-auto bg-background px-4 py-8 md:h-full md:min-h-0 md:overflow-hidden md:px-8">
      <div className="max-w-8xl space-y-6 md:flex md:h-full md:min-h-0 md:flex-col md:gap-6 md:space-y-0">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-foreground">
              Integrations
            </h1>
            <p className="hidden max-w-3xl text-sm text-muted-foreground md:block">
              Connect {PRODUCT_NAME} with tools your team uses.
            </p>
          </div>
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
        </header>

        <Integrations addRequest={addRequest} />
      </div>
    </div>
  );
}
