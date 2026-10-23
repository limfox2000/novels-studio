/** 状态徽标与圆点：颜色只承担语义（成功/警告/危险/品牌），不承担装饰。 */
import type { ReactNode } from 'react';
import { cx } from './utils';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warn' | 'danger';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-600',
  brand: 'bg-brand-50 text-brand-700',
  success: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-700',
  danger: 'bg-rose-50 text-rose-600',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[12px] font-medium leading-none',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export type DotTone = 'ok' | 'warn' | 'down' | 'idle';

const DOT: Record<DotTone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  down: 'bg-rose-500',
  idle: 'bg-slate-300',
};

export function StatusDot({ tone = 'idle', pulse, className }: { tone?: DotTone; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', DOT[tone], pulse && 'animate-pulse', className)}
    />
  );
}
