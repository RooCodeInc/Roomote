'use client';

import {
  type CSSProperties,
  type ElementType,
  type JSX,
  memo,
  useMemo,
} from 'react';
import { motion } from 'motion/react';

import { cn } from '@/lib/utils';

type ShimmerDirection = 'lr' | 'rl' | 'tb' | 'bt';

interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  direction?: ShimmerDirection;
}

const directionConfig: Record<
  ShimmerDirection,
  {
    angle: string;
    bgSize: string;
    initial: string;
    animate: string;
  }
> = {
  lr: {
    angle: '90deg',
    bgSize: '250% 100%',
    initial: '100% center',
    animate: '0% center',
  },
  rl: {
    angle: '270deg',
    bgSize: '250% 100%',
    initial: '0% center',
    animate: '100% center',
  },
  tb: {
    angle: '180deg',
    bgSize: '100% 250%',
    initial: 'center 0%',
    animate: 'center 100%',
  },
  bt: {
    angle: '0deg',
    bgSize: '100% 250%',
    initial: 'center 100%',
    animate: 'center 0%',
  },
};

const ShimmerComponent = ({
  children,
  as: Component = 'div',
  className,
  duration = 2,
  spread = 2,
  direction = 'lr',
}: TextShimmerProps) => {
  const MotionComponent = motion.create(
    Component as keyof JSX.IntrinsicElements,
  );

  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );

  const config = directionConfig[direction];

  return (
    <MotionComponent
      animate={{ backgroundPosition: config.animate }}
      className={cn(
        'relative inline-block bg-clip-text text-transparent',
        '[background-repeat:no-repeat,padding-box]',
        className,
      )}
      initial={{ backgroundPosition: config.initial }}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundSize: `${config.bgSize}, auto`,
          backgroundImage: `linear-gradient(${config.angle},#0000 calc(50% - var(--spread)),var(--color-background),#0000 calc(50% + var(--spread))), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))`,
        } as CSSProperties
      }
      transition={{
        repeat: Number.POSITIVE_INFINITY,
        duration,
        ease: 'linear',
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
