/** 📐 章节区域覆盖层（v2.31）：屏幕坐标绘制/交互，区域主体不拦截节点。
 *  存储仍是 board.regions（不是 React Flow 节点）；绘制/移动/缩放用 screenToFlowPosition 换算，
 *  边框、标签与手柄保持恒定尺寸，避免随缩放变细不可点。 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { useReactFlow, useViewport } from '@xyflow/react';
import {
  selectActiveRegions,
  useStudioStore,
} from '../../stores/studioStore';
import { useUiStore } from '../../stores/uiStore';
import {
  REGION_MIN_H,
  REGION_MIN_W,
  chapterBoardOf,
  sanitizeRegionRect,
  type RegionRect,
} from '../../stores/chapterRegions';
import { useActiveChapterId } from './useActiveChapter';
import { activateChapter } from './chapterSceneActions';
import type { ChapterRegion } from '../../types/sim';

type Point = { x: number; y: number };
type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';
type DraftRect = { x: number; y: number; width: number; height: number };

type DragState =
  | { kind: 'move'; id: string; start: Point; orig: RegionRect }
  | { kind: 'resize'; id: string; handle: ResizeHandle; start: Point; orig: RegionRect };

const HANDLE_CLASS: Record<ResizeHandle, string> = {
  nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  ne: 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  sw: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize',
  se: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize',
};

export function ChapterRegionsOverlay({ enabled }: { enabled: boolean }) {
  const boardId = useStudioStore((s) => s.activeBoardId);
  const boards = useStudioStore((s) => s.boards);
  const chapters = useStudioStore((s) => s.chapters);
  const volumes = useStudioStore((s) => s.volumes);
  const regions = useStudioStore(selectActiveRegions);
  const activeChapterId = useActiveChapterId();
  const selectedId = useUiStore((s) => s.selectedRegionId);
  const drawChapterId = useUiStore((s) => s.regionDrawChapterId);
  const regionsVisible = useUiStore((s) => s.regionsVisible);
  const regionFocus = useUiStore((s) => s.regionFocus);
  const { x: vx, y: vy, zoom } = useViewport();
  const reactFlow = useReactFlow();

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const drawStartRef = useRef<{ screen: Point; flow: Point } | null>(null);
  const [draft, setDraft] = useState<DraftRect | null>(null);

  const drawChapter = drawChapterId ? chapters.find((c) => c.id === drawChapterId) : null;
  const drawing = !!drawChapterId;
  const drawTitle = drawChapter?.title.trim() || '未命名章节';

  const localPoint = (e: ReactPointerEvent): Point => {
    const rect = overlayRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };
  const flowPoint = (e: ReactPointerEvent): Point => reactFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY });

  // 绘制/选中状态自愈：打开书架、切章、切板、章节被删 → 取消绘制；区域消失 → 清空选中
  useEffect(() => {
    if (!enabled) {
      useUiStore.getState().cancelRegionDraw();
      useUiStore.getState().setSelectedRegionId(null);
      dragRef.current = null;
      return;
    }
    if (drawChapterId) {
      const chapter = chapters.find((c) => c.id === drawChapterId);
      const expected = chapter ? chapterBoardOf(chapter.volumeId, volumes, boards) : null;
      if (!chapter || activeChapterId !== drawChapterId || expected !== boardId) {
        useUiStore.getState().cancelRegionDraw();
        drawStartRef.current = null;
        setDraft(null);
      }
    }
  }, [enabled, drawChapterId, activeChapterId, chapters, volumes, boards, boardId]);

  useEffect(() => {
    if (selectedId && !regions.some((r) => r.id === selectedId)) {
      useUiStore.getState().setSelectedRegionId(null);
    }
  }, [selectedId, regions]);

  // 切板时中止未完成的拖动/绘制（新画布的区域是另一套）
  useEffect(() => {
    dragRef.current = null;
    drawStartRef.current = null;
    setDraft(null);
  }, [boardId]);

  // Esc：取消绘制/拖动/选中（输入框内且无画布操作时不抢）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing && !drawStartRef.current && !dragRef.current) return;
      dragRef.current = null;
      drawStartRef.current = null;
      setDraft(null);
      useUiStore.getState().cancelRegionDraw();
      useUiStore.getState().setSelectedRegionId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 定位请求：等新画布 ReactFlow 挂载后再中心对齐
  useEffect(() => {
    if (!regionFocus) return;
    const target = useStudioStore
      .getState()
      .boards[boardId]?.regions.find((r) => r.id === regionFocus.regionId);
    if (!target) return;
    const timer = window.setTimeout(() => {
      reactFlow.setCenter(target.x + target.width / 2, target.y + target.height / 2, {
        zoom: reactFlow.getZoom(),
        duration: 250,
      });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [regionFocus?.nonce, boardId, reactFlow]);

  const startDrag = (e: ReactPointerEvent, region: ChapterRegion, handle: 'move' | ResizeHandle) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    useUiStore.getState().setSelectedRegionId(region.id);
    activateChapter(region.chapterId);
    const start = flowPoint(e);
    const orig = { x: region.x, y: region.y, width: region.width, height: region.height };
    dragRef.current =
      handle === 'move'
        ? { kind: 'move', id: region.id, start, orig }
        : { kind: 'resize', id: region.id, handle, start, orig };
  };

  const onDragMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const p = flowPoint(e);
    if (d.kind === 'move') {
      useStudioStore.getState().updateChapterRegionOnBoard(boardId, d.id, {
        x: Math.round(d.orig.x + p.x - d.start.x),
        y: Math.round(d.orig.y + p.y - d.start.y),
      });
      return;
    }
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    let { x, y, width, height } = d.orig;
    if (d.handle.includes('e')) width = Math.max(REGION_MIN_W, d.orig.width + dx);
    if (d.handle.includes('s')) height = Math.max(REGION_MIN_H, d.orig.height + dy);
    if (d.handle.includes('w')) {
      width = Math.max(REGION_MIN_W, d.orig.width - dx);
      x = d.orig.x + d.orig.width - width;
    }
    if (d.handle.includes('n')) {
      height = Math.max(REGION_MIN_H, d.orig.height - dy);
      y = d.orig.y + d.orig.height - height;
    }
    useStudioStore.getState().updateChapterRegionOnBoard(boardId, d.id, {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
  };

  const endDrag = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = null;
  };

  const onDrawDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || !drawChapterId) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const screen = localPoint(e);
    drawStartRef.current = { screen, flow: flowPoint(e) };
    setDraft({ x: screen.x, y: screen.y, width: 0, height: 0 });
  };

  const onDrawMove = (e: ReactPointerEvent) => {
    const d = drawStartRef.current;
    if (!d) return;
    const p = localPoint(e);
    setDraft({
      x: Math.min(d.screen.x, p.x),
      y: Math.min(d.screen.y, p.y),
      width: Math.abs(p.x - d.screen.x),
      height: Math.abs(p.y - d.screen.y),
    });
  };

  const onDrawUp = (e: ReactPointerEvent) => {
    const d = drawStartRef.current;
    if (!d || !drawChapterId) return;
    drawStartRef.current = null;
    setDraft(null);
    const p = localPoint(e);
    const dist = Math.hypot(p.x - d.screen.x, p.y - d.screen.y);
    if (dist < 6) return; // 误点：保持绘制模式，等下一笔
    const end = flowPoint(e);
    const rect = sanitizeRegionRect({
      x: Math.min(d.flow.x, end.x),
      y: Math.min(d.flow.y, end.y),
      width: Math.abs(end.x - d.flow.x),
      height: Math.abs(end.y - d.flow.y),
    });
    const res = useStudioStore.getState().addChapterRegionOnBoard(boardId, drawChapterId, rect);
    if (!res.ok) {
      window.alert(res.error === 'wrong-board' ? '本章已更换画布，请重新选择章节后再画。' : '区域创建失败，请重新选择章节。');
      useUiStore.getState().cancelRegionDraw();
      return;
    }
    useUiStore.getState().setSelectedRegionId(res.regionId);
    useUiStore.getState().cancelRegionDraw();
  };

  const removeRegion = (r: ChapterRegion) => {
    const chapter = chapters.find((c) => c.id === r.chapterId);
    const name = chapter?.title.trim() || '未命名章节';
    if (!window.confirm(`删除《${name}》的区域？（不会删除章节）`)) return;
    useStudioStore.getState().deleteChapterRegionOnBoard(boardId, r.id);
    if (useUiStore.getState().selectedRegionId === r.id) useUiStore.getState().setSelectedRegionId(null);
  };

  if (!enabled) return null;

  // 选中 > 当前章 > 其他，保证手柄/标签在重叠时优先可点
  const rank = (r: ChapterRegion) => (r.id === selectedId ? 2 : r.chapterId === activeChapterId ? 1 : 0);
  const ordered = [...regions].sort((a, b) => rank(a) - rank(b));

  return (
    <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {regionsVisible &&
        ordered.map((r) => {
          const active = r.chapterId === activeChapterId;
          const selected = r.id === selectedId;
          const chapter = chapters.find((c) => c.id === r.chapterId);
          const label = chapter?.title.trim() || '未命名章节';
          const left = r.x * zoom + vx;
          const top = r.y * zoom + vy;
          const width = r.width * zoom;
          const height = r.height * zoom;
          return (
            <div
              key={r.id}
              className="absolute"
              style={{ left, top, width, height }}
              data-chapter-region={r.chapterId}
            >
              <div
                className={`pointer-events-none absolute inset-0 rounded-[6px] border-2 ${
                  active
                    ? 'border-brand-500/80 bg-brand-500/[0.06]'
                    : 'border-dashed border-slate-400/40 bg-slate-400/[0.035]'
                } ${selected ? 'ring-2 ring-brand-500/40' : ''}`}
              />
              <div
                onPointerDown={(e) => startDrag(e, r, 'move')}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className={`pointer-events-auto absolute left-0 top-0 flex h-6 max-w-full cursor-move select-none items-center gap-1 overflow-hidden rounded-tl-[6px] rounded-br-[6px] px-1.5 text-[11px] font-semibold text-white ${
                  active ? 'bg-brand-500' : 'bg-slate-500/85'
                }`}
                style={{ touchAction: 'none' }}
                title={active ? '当前章节区域（拖动移动）' : '章节区域（点击选中并切换到该章，拖动移动）'}
              >
                <span className="min-w-0 truncate">{label}</span>
                {selected && (
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => removeRegion(r)}
                    className="pointer-events-auto ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-white/20 transition hover:bg-rose-500"
                    title="删除区域（不删除章节）"
                    aria-label="删除区域"
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
              {selected &&
                (['nw', 'ne', 'sw', 'se'] as const).map((h) => (
                  <div
                    key={h}
                    onPointerDown={(e) => startDrag(e, r, h)}
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    className={`pointer-events-auto absolute h-3 w-3 rounded-[3px] border-2 border-brand-500 bg-white shadow-sm ${HANDLE_CLASS[h]}`}
                    style={{ touchAction: 'none' }}
                    title="拖动缩放区域"
                    aria-label={`从${h}角缩放区域`}
                  />
                ))}
            </div>
          );
        })}

      {drawing && (
        <div
          onPointerDown={onDrawDown}
          onPointerMove={onDrawMove}
          onPointerUp={onDrawUp}
          onPointerCancel={() => {
            drawStartRef.current = null;
            setDraft(null);
          }}
          className="pointer-events-auto absolute inset-0 z-30 cursor-crosshair select-none bg-brand-500/[0.02]"
          style={{ touchAction: 'none' }}
        >
          <div className="pointer-events-none fixed left-1/2 top-40 -translate-x-1/2 rounded-full bg-slate-900/80 px-3 py-1.5 text-[12px] text-white shadow-panel">
            拖拽绘制《{drawTitle}》的区域 · Esc 取消
          </div>
          {draft && (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-brand-500 bg-brand-500/10"
              style={{ left: draft.x, top: draft.y, width: draft.width, height: draft.height }}
            />
          )}
        </div>
      )}
    </div>
  );
}
