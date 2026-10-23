/** 浮层面板外壳。style 原样合并——阅读主题的 --rd-* 变量靠它透传。
 *  只使用 border/rounded/shadow，不加 transform/filter/backdrop-filter，
 *  避免成为 fixed 后代的包含块。 */
import type { CSSProperties, ReactNode } from 'react';
import { cx } from './utils';

export function PanelShell({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cx(
        'flex flex-col overflow-hidden rounded-[16px] border border-slate-200/80 bg-white shadow-panel',
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}

/** 面板头部：标题 + 副标题 + 右侧操作区。 */
export function PanelHeader({
  title,
  icon,
  subtitle,
  actions,
  className,
  style,
}: {
  title: ReactNode;
  icon?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cx('flex flex-shrink-0 items-center gap-2 border-b border-slate-100 px-3 py-2', className)}
      style={style}
    >
      {icon && <span className="shrink-0 text-slate-500 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
      <span className="whitespace-nowrap text-sm font-semibold">{title}</span>
      {subtitle && <span className="hidden whitespace-nowrap text-[12px] text-slate-400 sm:inline">{subtitle}</span>}
      <span className="flex-1" />
      {actions}
    </div>
  );
}
