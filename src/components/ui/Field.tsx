/** 表单原语：内部一律使用原生 input/textarea/select（React Flow 的 Delete/Backspace
 *  只对原生可编辑元素放行，替换成 contentEditable 会误删节点）。 */
import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from './utils';

const CONTROL =
  'w-full rounded-[10px] border border-slate-200 bg-white text-[13px] text-slate-700 placeholder:text-slate-300 ' +
  'transition focus:border-brand-400 focus:outline-none focus:ring-4 focus:ring-brand-500/10 ' +
  'disabled:bg-slate-50 disabled:text-slate-400';

export function Field({
  label,
  counter,
  hint,
  children,
  className,
}: {
  label?: ReactNode;
  counter?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('block', className)}>
      {(label || counter) && (
        <span className="mb-1 flex items-center justify-between text-[12px] font-medium text-slate-500">
          <span>{label}</span>
          {counter && <span className="font-normal text-slate-400">{counter}</span>}
        </span>
      )}
      {children}
      {hint && <span className="mt-1 block text-[12px] leading-relaxed text-slate-400">{hint}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(CONTROL, 'h-9 px-3', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx(CONTROL, 'resize-y px-3 py-2 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx(CONTROL, 'h-9 px-2.5', className)} {...rest}>
      {children}
    </select>
  );
});
