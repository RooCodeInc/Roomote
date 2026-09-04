import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Menu, Plus, X, Settings } from '@/components/system';
import { useAuthorizedUser } from '@/hooks/useUser';
import { NewTaskDialog } from '@/components/tasks/NewTaskDialog';

import {
  Button,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/system';

import { getVisiblePrimaryNavItems } from '../navigation-items';

export const NavbarDrawer = ({
  setupIncomplete = false,
}: {
  setupIncomplete?: boolean;
}) => {
  const pathname = usePathname();
  const { isAdmin } = useAuthorizedUser();
  const visibleNavItems = getVisiblePrimaryNavItems({
    isAdmin,
    setupIncomplete,
  });

  const [open, setOpen] = useState(false);
  const [isNewTaskDialogOpen, setIsNewTaskDialogOpen] = useState(false);

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
              <Button
                variant="ghost"
                size="lg"
                className="justify-start"
                onClick={() => {
                  setOpen(false);
                  setIsNewTaskDialogOpen(true);
                }}
              >
                <Plus className="size-5" />
                New Session
              </Button>

              {visibleNavItems.map((item) => {
                const Icon = item.icon;

                return (
                  <Button
                    key={item.href}
                    variant="ghost"
                    size="lg"
                    className="justify-start"
                    asChild
                  >
                    <Link href={item.href}>
                      <Icon className="size-5" />
                      {item.mobileLabel ?? item.label}
                    </Link>
                  </Button>
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
      <NewTaskDialog
        open={isNewTaskDialogOpen}
        onOpenChange={setIsNewTaskDialogOpen}
      />
    </>
  );
};
