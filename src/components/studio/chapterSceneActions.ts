/** 🎬 统一切章动作（v2.32）：大纲、正文、区域标签都走这里。
 *  离开当前章前先把当前场景写回快照 → 切到目标章所属画布 → 回放目标章快照
 *  （位置/父环境/当前状态 id）→ 目标章还没有快照时把当前画布作为底稿自动记录，不搬动人物。
 *  快照外人物保持原位；环境布局不进入快照。 */
import { useStudioStore } from '../../stores/studioStore';
import { useUiStore } from '../../stores/uiStore';
import { chapterBoardOf } from '../../stores/chapterRegions';
import {
  syncActiveChapterScene,
  withChapterSceneSyncSuppressed,
} from '../../stores/chapterSceneSync';
import type { ChapterSceneApplyResult } from '../../stores/studioStore';
import type { SimViewport } from '../../types/sim';

export interface ActivateChapterResult {
  ok: boolean;
  boardId?: string;
  /** 回放结果（仅当目标章有快照且切到其所属画布时） */
  applied?: ChapterSceneApplyResult;
  /** 目标章没有可用快照时是否自动记录了当前画布底稿 */
  baselineCaptured?: boolean;
  error?: string;
}

/** 切章：所有入口共用；同一章重复点击不会回放，避免覆盖正在摆放的场景。 */
export function activateChapter(
  chapterId: string | null,
  opts: { viewport?: SimViewport } = {},
): ActivateChapterResult {
  const ui = useUiStore.getState();
  if (!chapterId) {
    ui.setActiveChapterId(null);
    return { ok: true };
  }

  const initial = useStudioStore.getState();
  const chapter = initial.chapters.find((c) => c.id === chapterId);
  if (!chapter) return { ok: false, error: 'chapter-not-found' };
  const targetBoardId = chapterBoardOf(chapter.volumeId, initial.volumes, initial.boards);
  if (!initial.boards[targetBoardId]) return { ok: false, error: 'board-not-found' };

  const sameChapter = ui.activeChapterId === chapterId;
  if (!sameChapter) syncActiveChapterScene();

  let applied: ChapterSceneApplyResult | undefined;
  let baselineCaptured = false;
  withChapterSceneSyncSuppressed(() => {
    const st = useStudioStore.getState();
    if (opts.viewport && st.boards[st.activeBoardId]) st.saveActiveViewport(opts.viewport);
    if (st.activeBoardId !== targetBoardId) st.switchBoard(targetBoardId);
    useUiStore.getState().setActiveChapterId(chapterId);

    const now = useStudioStore.getState();
    // 切章后清空节点选中：选中态的环境在 React Flow 中可拖动，若残留选中，拖动画布时
    // 会误移环境而章节区域固定在世界坐标，看起来像区域与内容脱离。
    if (!sameChapter) {
      const selected = now.boards[targetBoardId]?.nodes.filter((n) => n.selected) ?? [];
      if (selected.length) {
        now.onNodesChange(selected.map((n) => ({ type: 'select' as const, id: n.id, selected: false })));
      }
    }
    const target = now.chapters.find((c) => c.id === chapterId);
    const board = now.boards[targetBoardId];
    const region = board?.regions.find((r) => r.chapterId === chapterId);
    if (!target || !region) return;

    // 用户只是回到同一章（或手动切回其画布）：不回放，保留当前未保存的摆放；
    // 但本章还没有场景快照时（旧档/首次进入），把当前画布作为底稿自动记录。
    if (sameChapter) {
      if (!target.snapshot || target.snapshot.boardId !== targetBoardId) {
        const r = now.syncChapterScene(chapterId);
        baselineCaptured = r.ok && r.changed;
      }
      return;
    }

    if (target.snapshot && target.snapshot.boardId === targetBoardId) {
      applied = now.applyChapterScene(chapterId);
    } else {
      // 新章 / 快照源画布已变化：当前画布就是底稿，只留档不搬人
      const r = now.syncChapterScene(chapterId);
      baselineCaptured = r.ok && r.changed;
    }
  });

  return {
    ok: true,
    boardId: targetBoardId,
    ...(applied ? { applied } : {}),
    ...(baselineCaptured ? { baselineCaptured: true } : {}),
  };
}
