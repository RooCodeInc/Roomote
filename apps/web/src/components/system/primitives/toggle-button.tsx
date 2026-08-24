'use client';

import * as React from 'react';
import * as TogglePrimitive from '@radix-ui/react-toggle';

import { Button, type ButtonAsButtonProps } from './button';

type ToggleButtonProps = Omit<
  React.ComponentProps<typeof TogglePrimitive.Root>,
  'asChild' | 'children' | 'className'
> &
  Pick<ButtonAsButtonProps, 'children' | 'className' | 'size' | 'variant'> & {
    pressedVariant?: ButtonAsButtonProps['variant'];
  };

function ToggleButton({
  children,
  className,
  defaultPressed = false,
  onPressedChange,
  pressed,
  size = 'default',
  variant = 'ghost',
  pressedVariant = 'secondary',
  ...props
}: ToggleButtonProps) {
  const [uncontrolledPressed, setUncontrolledPressed] =
    React.useState(defaultPressed);
  const isControlled = pressed !== undefined;
  const isPressed = isControlled ? pressed : uncontrolledPressed;

  const handlePressedChange = (nextPressed: boolean) => {
    if (!isControlled) {
      setUncontrolledPressed(nextPressed);
    }

    onPressedChange?.(nextPressed);
  };

  return (
    <TogglePrimitive.Root
      asChild
      data-slot="toggle-button"
      pressed={isPressed}
      onPressedChange={handlePressedChange}
      {...props}
    >
      <Button
        variant={isPressed ? pressedVariant : variant}
        size={size}
        className={className}
      >
        {children}
      </Button>
    </TogglePrimitive.Root>
  );
}

export { ToggleButton };
export type { ToggleButtonProps };
