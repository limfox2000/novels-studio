/** 图标按钮：title / aria-label 必填，图标固定 16px。 */
import type { ReactNode } from 'react';
import { Button, type ButtonProps, type ButtonVariant } from './Button';

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'size'> {
  icon: ReactNode;
  title: string;
  label?: string;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  danger?: boolean;
}

export function IconButton({
  icon,
  title,
  label,
  variant = 'ghost',
  size = 'sm',
  danger = false,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <Button
      variant={danger ? 'danger' : variant}
      size={size === 'md' ? 'icon' : 'iconSm'}
      icon={icon}
      title={title}
      aria-label={label ?? title}
      className={className}
      {...rest}
    />
  );
}
