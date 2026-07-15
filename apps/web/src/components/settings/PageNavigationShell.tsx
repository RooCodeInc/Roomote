'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import type { LucideIcon } from '@/components/system';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

type PageNavigationShellItem<T extends string = string> = {
  id: T;
  label: string;
  icon: LucideIcon;
  href?: string;
  newGroup?: boolean;
};

type PageNavigationShellProps<T extends string = string> = {
  items: PageNavigationShellItem<T>[];
  activeItemId: T;
  title: string;
  description?: string;
  mobileLabel: string;
  headerAction?: ReactNode;
  onItemSelect: (id: T) => void;
  children: ReactNode;
};

export function PageNavigationShell<T extends string = string>({
  items,
  activeItemId,
  title,
  description,
  mobileLabel,
  headerAction,
  onItemSelect,
  children,
}: PageNavigationShellProps<T>) {
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col gap-6 overflow-x-hidden overflow-y-auto px-4 py-6 md:py-8 lg:flex-row lg:items-start">
      <aside className="hidden lg:block lg:w-60 lg:shrink-0 lg:absolute">
        <nav className="space-y-1 pl-3">
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === activeItemId;
            const itemClassName = cn(
              'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-base transition-colors cursor-pointer',
              item.newGroup && 'mt-6',
              isActive
                ? 'bg-foreground font-medium text-accent-bright-foreground dark:bg-accent-foreground dark:text-card'
                : 'text-foreground hover:text-accent-foreground',
            );

            if (item.href) {
              return (
                <Link key={item.id} href={item.href} className={itemClassName}>
                  <Icon className="size-4" />
                  {item.label}
                </Link>
              );
            }

            return (
              <button
                key={item.id}
                type="button"
                className={itemClassName}
                onClick={() => onItemSelect(item.id)}
              >
                <Icon className="size-4" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="min-w-0 flex-1 space-y-6 lg:ml-68 max-w-6xl">
        <div className="space-y-4 lg:hidden">
          <Select
            value={activeItemId}
            onValueChange={(value) => onItemSelect(value as T)}
          >
            <SelectTrigger
              id={`${mobileLabel.toLowerCase().replace(/\s+/g, '-')}-switcher`}
              aria-label={mobileLabel}
              className="w-full text-lg py-6 px-4"
            >
              <SelectValue
                placeholder={`Choose ${mobileLabel.toLowerCase()}`}
              />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => {
                const Icon = item.icon;

                return (
                  <SelectItem key={item.id} value={item.id} className="py-3">
                    <Icon className="size-5" />
                    {item.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {description ? (
              <p className="max-w-3xl text-sm text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {headerAction ? (
            <div className="hidden shrink-0 md:block">{headerAction}</div>
          ) : null}
        </header>

        <div className="space-y-6">{children}</div>
      </div>
    </div>
  );
}
