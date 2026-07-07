'use client';

import { BrandIcon } from '@/components/system';

type McpIconProps = {
  icon: string;
  name: string;
};

export function McpIcon({ icon, name }: McpIconProps) {
  return (
    <BrandIcon
      icon={icon}
      name={name}
      className="size-4 shrink-0 text-foreground/80"
    />
  );
}
