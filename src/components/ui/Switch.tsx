/** 统一开关（内部是原生 checkbox，键盘与读屏行为不变）。 */
import type { ReactNode } from 'react';
import { cx } from './utils';

export function Switch({
  checked,
  onChange,
  label,
  title,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cx(
        'inline-flex cursor-pointer items-center gap-2 text-[13px] text-slate-600',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      title={title}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className="relative inline-flex h-5 w-9 shrink-0 rounded-full bg-slate-200 transition-colors peer-checked:bg-brand-600 peer-focus-visible:ring-4 peer-focus-visible:ring-brand-500/20"
      >
        <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
      </span>
      {label}
    </label>
  );
}
