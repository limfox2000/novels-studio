/** 统一弹窗：portal 到 body（避免被顶栏/面板的 transform/backdrop-filter 困住）、
 *  ESC 关闭（仅最上层弹窗、输入法组合中不触发）、点遮罩关闭、nv-in 入场。 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';
import { cx } from './utils';

const WIDTH = {
  sm: 'w-[min(380px,calc(100vw-2rem))]',
  md: 'w-[min(560px,calc(100vw-2rem))]',
  lg: 'w-[min(620px,calc(100vw-2rem))]',
} as const;

/** ESC 只关最上层弹窗（灯箱/裁切等浮层可以叠在其它弹窗之上） */
const stack: symbol[] = [];

export interface DialogProps {
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  width?: keyof typeof WIDTH;
  /** body=整卡内容区滚动；inner=调用方自管内部滚动（内容区不滚） */
  scroll?: 'body' | 'inner';
  z?: number;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function Dialog({
  onClose,
  title,
  subtitle,
  icon,
  width = 'md',
  scroll = 'body',
  z = 50,
  footer,
  className,
  bodyClassName,
  children,
}: DialogProps) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const id = Symbol('dialog');
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (stack[stack.length - 1] !== id) return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: z }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 遮罩不吃指针事件：点卡片外部时 target 才是外层容器，才能触发「点遮罩关闭」 */}
      <div className="pointer-events-none absolute inset-0 bg-slate-900/35 backdrop-blur-[1px]" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cx(
          'nv-in relative flex max-h-[85vh] flex-col overflow-hidden rounded-[16px] border border-slate-200/80 bg-white shadow-panel',
          WIDTH[width],
          className,
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-start gap-2.5 px-4 pb-3 pt-4">
          {icon && <span className="mt-0.5 shrink-0 text-slate-500 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-6 text-slate-800">{title}</div>
            {subtitle && <p className="mt-1 text-[12px] leading-relaxed text-slate-500">{subtitle}</p>}
          </div>
          <IconButton icon={<X />} title="关闭" onClick={onClose} />
        </div>
        <div
          className={cx(
            'min-h-0 flex-1 px-4 pb-4',
            scroll === 'body' ? 'overflow-y-auto' : 'flex flex-col overflow-hidden',
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer && (
          <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-slate-100 px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
