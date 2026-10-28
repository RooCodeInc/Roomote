'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  HousePlug,
  Plug,
  Plus,
  Skeleton,
  UserRoundKey,
} from '@/components/system';

import { useCustomMcpServers } from './CustomMcpServers';
import { IntegrationListRow } from './integration-card';
import { Section } from './Section';
import { useYourIntegrations } from './YourIntegrations';

/**
 * Everything a member connected for themselves, in one list.
 *
 * This mirrors the deployment Integrations page, where custom MCP servers and
 * API-key integrations are rows in the same table behind a single Add action,
 * so the same two kinds of thing are not split across two sections here.
 */
export function PersonalIntegrations() {
  const keys = useYourIntegrations('personal');
  const mcp = useCustomMcpServers('owner');

  // An operator can turn custom MCP servers off; the section is still the
  // member's API-key integrations, with the picker collapsed back to one
  // action rather than a menu of one.
  const mcpEnabled = mcp.isEnabled;
  const items = mcpEnabled ? [...mcp.items, ...keys.items] : keys.items;
  const isLoading = keys.isLoading || (mcpEnabled && mcp.isLoading);
  const errors = [mcpEnabled ? mcp.error : null, keys.error].filter(
    (message): message is string => Boolean(message),
  );

  return (
    <Section
      icon={Plug}
      title="Personal integrations"
      action={
        mcpEnabled ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-label="Add personal integration"
              >
                <Plus />
                Add
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => mcp.openAddDialog()}>
                <HousePlug />
                Custom MCP
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => keys.openAddDialog()}>
                <UserRoundKey />
                API-key based
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            variant="outline"
            size="sm"
            aria-label="Add personal integration"
            onClick={keys.openAddDialog}
          >
            <Plus />
            Add
          </Button>
        )
      }
    >
      {errors.map((message) => (
        <p key={message} role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ))}
      {isLoading ? <Skeleton className="h-16 w-full" /> : null}
      {items.length > 0 ? (
        <div role="table" aria-label="Personal integrations">
          <div role="rowgroup" className="divide-y divide-background">
            {items.map((item) => (
              <IntegrationListRow key={item.id} item={item} stackDescription />
            ))}
          </div>
        </div>
      ) : null}
      {!isLoading && items.length === 0 && errors.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No personal integrations yet.
        </p>
      ) : null}
      {mcpEnabled ? mcp.dialogs : null}
      {keys.dialogs}
    </Section>
  );
}
