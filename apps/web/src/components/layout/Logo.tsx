'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { PRODUCT_NAME } from '@roomote/types';
import { cn } from '@/lib/utils';

type LogoProps = {
  scale?: number;
  className?: string;
  invert?: boolean;
};

const LOGO_SRC = '/logos/r.svg';
const LOGO_BASE_SIZE = 96;

export const Logo = ({
  scale = 0.4,
  invert = true,
  className,
  ...props
}: LogoProps) => {
  const router = useRouter();
  const iconSize = LOGO_BASE_SIZE * scale;

  return (
    <Image
      src={LOGO_SRC}
      alt={`${PRODUCT_NAME} logo`}
      width={iconSize}
      height={iconSize}
      priority
      onClick={() => router.push('/')}
      className={cn(
        'logo cursor-pointer transition-all duration-300 hover:scale-105 hover:opacity-80',
        invert && 'dark:invert',
        className,
      )}
      {...props}
    />
  );
};
