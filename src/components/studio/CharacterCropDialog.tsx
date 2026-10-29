/** ✂️ 人物头像裁切（v2.31 · v3 人物库）：在完整形象大图上拖出正方形区域，作为画布圆形头像。
 *  - 裁剪框可整体拖动、四角等比缩放；坐标换算为源图像素，保存后生成 256×256 头像写入 IndexedDB。
 *  - 桌面左右布局；移动端上下布局并铺满视口；所有指针操作使用 pointer capture + touch-action:none。 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ImageOff, Trash2, X } from 'lucide-react';
import { saveHeadshot } from '../../services/characterImages';
import { useStudioStore } from '../../stores/studioStore';
import type { CharacterImageCrop, CharacterStateImage } from '../../types/sim';
import { Button } from '../ui/Button';

const MIN_BOX_PX = 24;
const MIN_BOX_RATIO = 0.06;
const PREVIEW_SIZE = 128;

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';

type DragState = {
  mode: DragMode;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  scale: number;
  startCrop: CharacterImageCrop;
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function initialCrop(image: CharacterStateImage): CharacterImageCrop {
  const maxSize = Math.min(image.width, image.height);
  const existing = image.crop;
  if (existing && existing.size >= 1) {
    const size = clamp(Math.round(existing.size), 1, maxSize);
    return {
      size,
      x: clamp(Math.round(existing.x), 0, image.width - size),
      y: clamp(Math.round(existing.y), 0, image.height - size),
    };
  }
  const size = Math.max(1, Math.round(maxSize * 0.5));
  return {
    size,
    x: Math.round((image.width - size) / 2),
    y: Math.max(0, Math.min(image.height - size, Math.round(image.height * 0.08))),
  };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function CharacterCropDialog({
  characterId,
  stateId,
  stateLabel,
  image,
  fullDataUrl,
  onClose,
}: {
  characterId: string;
  stateId: string;
  stateLabel: string;
  image: CharacterStateImage;
  fullDataUrl: string;
  onClose: () => void;
}) {
  const [crop, setCrop] = useState<CharacterImageCrop>(() => initialCrop(image));
  const [display, setDisplay] = useState({ w: 0, h: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const scale = display.w > 0 ? display.w / image.width : 1;
  const minSize = useMemo(
    () => Math.max(1, Math.min(Math.round(Math.min(image.width, image.height) * MIN_BOX_RATIO), Math.round(MIN_BOX_PX / Math.max(scale, 0.0001)))),
    [image.width, image.height, scale],
  );

  // 锁滚动 + ESC 关闭
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 按舞台可用空间等比适配整张图：容器尺寸由我们计算，裁剪框坐标与图片显示区域严格重合
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const s = Math.min(rect.width / image.width, rect.height / image.height);
      const w = Math.max(1, Math.floor(image.width * s));
      const h = Math.max(1, Math.floor(image.height * s));
      setDisplay((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [image.width, image.height]);

  // 容器尺寸变化后把裁剪框夹回图像范围
  useEffect(() => {
    setCrop((c) => {
      const size = clamp(c.size, 1, Math.min(image.width, image.height));
      return {
        size,
        x: clamp(c.x, 0, image.width - size),
        y: clamp(c.y, 0, image.height - size),
      };
    });
  }, [image.width, image.height]);

  const beginDrag = (mode: DragMode, e: ReactPointerEvent<HTMLElement>) => {
    if (busy || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      scale: scale > 0 ? scale : 1,
      startCrop: crop,
    };
  };

  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    const dx = (e.clientX - drag.startClientX) / drag.scale;
    const dy = (e.clientY - drag.startClientY) / drag.scale;
    const s0 = drag.startCrop;
    const maxSize = Math.min(image.width, image.height);

    if (drag.mode === 'move') {
      setCrop({
        size: s0.size,
        x: clamp(Math.round(s0.x + dx), 0, image.width - s0.size),
        y: clamp(Math.round(s0.y + dy), 0, image.height - s0.size),
      });
      return;
    }

    let anchorX = s0.x;
    let anchorY = s0.y;
    let maxAllowed = maxSize;
    // 沿对角线取平均位移：只横向/纵向拖动也能缩放，斜拖时更跟手
    let delta = 0;
    if (drag.mode === 'se') {
      maxAllowed = Math.min(image.width - s0.x, image.height - s0.y);
      delta = (dx + dy) / 2;
    } else if (drag.mode === 'nw') {
      anchorX = s0.x + s0.size;
      anchorY = s0.y + s0.size;
      maxAllowed = Math.min(anchorX, anchorY);
      delta = (-dx - dy) / 2;
    } else if (drag.mode === 'ne') {
      anchorX = s0.x;
      anchorY = s0.y + s0.size;
      maxAllowed = Math.min(image.width - s0.x, anchorY);
      delta = (dx - dy) / 2;
    } else {
      anchorX = s0.x + s0.size;
      anchorY = s0.y;
      maxAllowed = Math.min(anchorX, image.height - s0.y);
      delta = (-dx + dy) / 2;
    }

    const upper = Math.max(1, Math.min(maxSize, maxAllowed));
    const lower = Math.min(minSize, upper);
    const size = clamp(Math.round(s0.size + delta), lower, upper);
    const next: CharacterImageCrop = {
      size,
      x: drag.mode === 'nw' || drag.mode === 'sw' ? anchorX - size : anchorX,
      y: drag.mode === 'nw' || drag.mode === 'ne' ? anchorY - size : anchorY,
    };
    setCrop({
      size,
      x: clamp(next.x, 0, image.width - size),
      y: clamp(next.y, 0, image.height - size),
    });
  };

  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针可能已释放 */
    }
  };

  const removeHead = () => {
    if (busy) return;
    const next: CharacterStateImage = { ...image };
    delete next.headKey;
    delete next.crop;
    useStudioStore.getState().updateCharacterState(characterId, { image: next }, stateId);
    onClose();
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = await saveHeadshot(characterId, stateId, image, crop, fullDataUrl);
      useStudioStore.getState().updateCharacterState(characterId, { image: r.image }, stateId);
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // 圆形预览：把整张图按「裁剪框铺满预览圆」的比例缩放，再按 crop 偏移
  const previewScale = PREVIEW_SIZE / crop.size;
  const previewStyle = {
    backgroundImage: `url(${fullDataUrl})`,
    backgroundSize: `${image.width * previewScale}px ${image.height * previewScale}px`,
    backgroundPosition: `${-crop.x * previewScale}px ${-crop.y * previewScale}px`,
    backgroundRepeat: 'no-repeat',
  } as const;

  const boxStyle = {
    left: crop.x * scale,
    top: crop.y * scale,
    width: crop.size * scale,
    height: crop.size * scale,
  };

  const handles: Array<{ mode: Exclude<DragMode, 'move'>; className: string; cursor: string }> = [
    { mode: 'nw', className: '-left-2 -top-2', cursor: 'nwse-resize' },
    { mode: 'ne', className: '-right-2 -top-2', cursor: 'nesw-resize' },
    { mode: 'sw', className: '-bottom-2 -left-2', cursor: 'nesw-resize' },
    { mode: 'se', className: '-bottom-2 -right-2', cursor: 'nwse-resize' },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[75] flex bg-slate-950/80 sm:items-center sm:justify-center sm:p-6"
      data-testid="character-image-crop-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="选取人物头像"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex h-full w-full flex-col overflow-hidden bg-white shadow-2xl sm:h-[82vh] sm:max-h-[760px] sm:min-h-[480px] sm:max-w-5xl sm:rounded-[18px]">
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-slate-700">选取人物头像</div>
            <div className="mt-0.5 truncate text-[11px] text-slate-400">
              {stateLabel} · 拖动方框选择头部区域，画布显示为圆形头像
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
            title="取消（不保存）"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-slate-900 p-3 md:p-5">
            <div ref={stageRef} className="flex h-full w-full items-center justify-center">
              {display.w > 0 && (
                <div
                  className="relative select-none"
                  style={{ width: display.w, height: display.h }}
                  data-testid="crop-stage"
                >
                  <img
                    src={fullDataUrl}
                    alt="人物形象大图"
                    draggable={false}
                    className="block h-full w-full object-contain"
                    style={{ touchAction: 'none' }}
                  />
                  <div
                    className="absolute cursor-move border-2 border-white"
                    style={{ ...boxStyle, boxShadow: '0 0 0 9999px rgba(2,6,23,.55)', touchAction: 'none' }}
                    onPointerDown={(e) => beginDrag('move', e)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    data-testid="crop-box"
                  >
                  {/* 三分线辅助定位 */}
                  <div className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/25" />
                  <div className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/25" />
                  <div className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/25" />
                  <div className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/25" />
                  {handles.map((h) => (
                    <div
                      key={h.mode}
                      className={`absolute h-5 w-5 rounded-full border-2 border-white bg-slate-500/80 shadow ${h.className}`}
                      style={{ cursor: h.cursor, touchAction: 'none' }}
                      title="拖动缩放裁剪区域"
                      data-crop-handle={h.mode}
                      onPointerDown={(e) => beginDrag(h.mode, e)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    />
                  ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-t border-slate-200 bg-white p-4 md:w-72 md:border-l md:border-t-0">
            <div className="flex items-center gap-3 md:flex-col md:items-start">
              <div
                className="shrink-0 rounded-full border-4 border-white bg-slate-100 shadow-lg ring-1 ring-slate-200"
                style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE, ...previewStyle }}
                data-testid="crop-preview"
                title="画布圆形头像预览"
              />
              <div className="min-w-0 text-[11px] leading-relaxed text-slate-500">
                <p className="font-medium text-slate-600">圆形头像预览</p>
                <p className="mt-1">
                  原图 {image.width}×{image.height}
                </p>
                <p>
                  选区 {crop.size}×{crop.size} px
                </p>
                <p className="text-slate-400">保存后会生成 256×256 的头像文件。</p>
              </div>
            </div>

            {err && <p className="text-[12px] leading-relaxed text-rose-500">{err}</p>}

            <div className="mt-auto flex flex-wrap gap-2 md:flex-col">
              <Button
                type="button"
                variant="primary"
                icon={<Check />}
                onClick={() => void save()}
                disabled={busy}
                title="保存裁切结果作为画布头像"
                data-testid="crop-save"
              >
                {busy ? '保存中…' : '保存头像'}
              </Button>
              {image.headKey && (
                <Button
                  type="button"
                  icon={<ImageOff />}
                  onClick={removeHead}
                  disabled={busy}
                  title="移除头像但保留人物形象大图（画布回落性别剪影）"
                  data-testid="crop-remove"
                >
                  移除头像
                </Button>
              )}
              <Button type="button" variant="ghost" icon={<Trash2 />} onClick={onClose} disabled={busy} data-testid="crop-cancel">
                取消
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
