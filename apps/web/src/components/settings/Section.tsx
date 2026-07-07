import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
  CardFooter,
} from '@/components/system';
import type { LucideIcon } from '@/components/system';
import { createElement, isValidElement } from 'react';

function isIconComponent(
  icon: LucideIcon | React.ReactNode,
): icon is LucideIcon {
  return (
    typeof icon === 'function' ||
    (typeof icon === 'object' &&
      icon !== null &&
      !isValidElement(icon) &&
      'render' in icon)
  );
}

type SectionProps = {
  icon?: LucideIcon | React.ReactNode;
  title: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
};

export const Section = ({
  icon,
  title,
  action,
  footer,
  children,
}: SectionProps) => {
  const iconElement = isIconComponent(icon)
    ? createElement(icon, { className: 'size-4' })
    : icon;

  return (
    <Card className="gap-0 p-0">
      <CardHeader className="px-4 flex items-center w-full h-14">
        <CardTitle className="flex items-center gap-2 w-full">
          {iconElement}
          <span className="grow">{title}</span>
          {action && <CardAction>{action}</CardAction>}
        </CardTitle>
      </CardHeader>
      <CardContent className="border-t-2 border-background space-y-3 p-4">
        {children}
      </CardContent>
      {footer && <CardFooter align="start">{footer}</CardFooter>}
    </Card>
  );
};
