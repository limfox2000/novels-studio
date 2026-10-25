/** 📐 章节区域入口动作（v2.31）：顶栏与章节面板共用。
 *  负责切到章节所属画布/场景、选中已有区域或进入绘制模式；不直接操作 React Flow。 */
import { useStudioStore } from '../../stores/studioStore';
import { useUiStore } from '../../stores/uiStore';
import { chapterBoardOf } from '../../stores/chapterRegions';
import { activateChapter } from './chapterSceneActions';
import type { SimViewport } from '../../types/sim';

export type BeginRegionResult =
  | { ok: true; mode: 'draw' | 'select'; boardId: string; regionId?: string }
  | { ok: false; message: string };

export function beginChapterRegion(
  chapterId: string | null,
  opts?: { viewport?: SimViewport },
): BeginRegionResult {
  const st = useStudioStore.getState();
  const ui = useUiStore.getState();
  if (!chapterId) {
    return {
      ok: false,
      message: st.chapters.length ? '请先选择一个章节（「大纲」或「正文」面板）' : '还没有章节：请先在「大纲」中添加章节',
    };
  }
  const chapter = st.chapters.find((c) => c.id === chapterId);
  if (!chapter) return { ok: false, message: '所选章节已不存在，请重新选择章节' };

  const boardId = chapterBoardOf(chapter.volumeId, st.volumes, st.boards);
  if (!st.boards[boardId]) return { ok: false, message: '章节所属画布不存在，请先检查卷画布' };

  // 统一切章：同步上一章场景、切到本章画布并回放本章人物位置
  const act = activateChapter(chapter.id, opts?.viewport ? { viewport: opts.viewport } : {});
  if (!act.ok) return { ok: false, message: '章节场景切换失败，请重新选择章节' };
  ui.setRegionsVisible(true);

  const board = useStudioStore.getState().boards[boardId];
  const existing = board?.regions.find((r) => r.chapterId === chapter.id);
  if (!board) return { ok: false, message: '章节所属画布不存在，请先检查卷画布' };
  if (existing) {
    ui.setSelectedRegionId(existing.id);
    ui.cancelRegionDraw();
    ui.requestRegionFocus(existing.id);
    return { ok: true, mode: 'select', boardId, regionId: existing.id };
  }

  ui.setSelectedRegionId(null);
  ui.startRegionDraw(chapter.id);
  return { ok: true, mode: 'draw', boardId };
}
