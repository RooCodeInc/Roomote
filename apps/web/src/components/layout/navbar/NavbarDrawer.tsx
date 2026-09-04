import { Fragment, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  Menu,
  X,
  Settings,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/system';
import { useAuthorizedUser } from '@/hooks/useUser';

import {
  Button,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/system';

import {
  getVisiblePrimaryNavItems,
  SETUP_INCOMPLETE_NAV_TOOLTIP,
} from '../navigation-items';

export const NavbarDrawer = ({
  setupIncomplete = false,
}: {
  setupIncomplete?: boolean;
}) => {
  const pathname = usePathname();
  const { isAdmin } = useAuthorizedUser();
  const visibleNavItems = getVisiblePrimaryNavItems({ isAdmin });

  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <Drawer direction="left" open={open} onOpenChange={setOpen}>
        <Button
          variant="ghost"
          className="md:hidden"
          onClick={() => setOpen(true)}
        >
          <Menu />
        </Button>

        <DrawerContent>
          <div className="flex h-full flex-col">
            <DrawerHeader>
              <DrawerTitle className="sr-only">Navigation Menu</DrawerTitle>
              <div className="flex items-center justify-end">
                <Button variant="ghost" asChild>
                  <DrawerClose>
                    <X />
                  </DrawerClose>
                </Button>
              </div>
            </DrawerHeader>

            <div className="flex flex-1 flex-col gap-2 p-4">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const disabled = setupIncomplete && item.requiresSetup;
                const control = (
                  <Button
                    variant="ghost"
                    size="lg"
                    className="justify-start"
                    aria-disabled={disabled || undefined}
                    asChild={!disabled}
                  >
                    {disabled ? (
                      <>
                        <Icon className="size-5" />
                        {item.mobileLabel ?? item.label}
                      </>
                    ) : (
                      <Link href={item.href}>
                        <Icon className="size-5" />
                        {item.mobileLabel ?? item.label}
                      </Link>
                    )}
                  </Button>
                );

                return disabled ? (
                  <Tooltip key={item.href}>
                    <TooltipTrigger asChild>{control}</TooltipTrigger>
                    <TooltipContent side="right">
                      {SETUP_INCOMPLETE_NAV_TOOLTIP}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Fragment key={item.href}>{control}</Fragment>
                );
              })}

              <Button
                variant="ghost"
                size="lg"
                className="justify-start"
                asChild
              >
                <Link href="/settings">
                  <Settings className="size-5" />
                  Settings
                </Link>
              </Button>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
};
