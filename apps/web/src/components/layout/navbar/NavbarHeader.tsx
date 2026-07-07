'use client';

import Image from 'next/image';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { Button, Search } from '@/components/system';
import { useCommandPalette } from '@/components/layout/CommandPaletteContext';
import { useAuthorizedUser } from '@/hooks/useUser';

import { UserMenu } from '../UserMenu';

import { NavbarDrawer } from './NavbarDrawer';

type NavbarHeaderProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>;

const MOBILE_HEADER_LOGO_SRC = '/logos/r.svg';

export const NavbarHeader = ({ className, ...props }: NavbarHeaderProps) => {
  const { setOpen: openCommandPalette } = useCommandPalette();
  useAuthorizedUser();

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 h-(--header-height) mx-auto px-1 pr-5',
        className,
      )}
      {...props}
    >
      <NavbarDrawer />
      <Link href="/" className="shrink-0">
        <Image
          src={MOBILE_HEADER_LOGO_SRC}
          alt="Roomote"
          width={28}
          height={28}
          className="h-7 w-7 cursor-pointer transition-all duration-300 hover:scale-105 hover:opacity-80 dark:invert"
        />
      </Link>
      <div className="flex-1" />
      <div className="hidden md:flex items-center gap-2">
        <UserMenu />
      </div>
      <div className="flex md:hidden items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => openCommandPalette(true)}
          aria-label="Search"
          className="size-9 text-muted-foreground"
        >
          <Search className="size-5" />
        </Button>
        <UserMenu />
      </div>
    </div>
  );
};
