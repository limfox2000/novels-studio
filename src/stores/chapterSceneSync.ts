/** 🎬 章节场景自动同步（v2.32 · v3 人物库）：当前章的名单/位置/父环境/状态跟随画布自动写入快照。
 *  - 监听画布与人物库变化（人物属性/状态修改也要刷新快照指纹），300ms 合并；切章/保存/生成前由调用方强制同步；
 *  - 只有当前章所属画布正是正在编辑的画布时才自动写，避免把别的卷的画布写进当前章；
 *  - 所有写入仍是内存更新，是否落盘由手动保存决定；
 *  - 切章回放期间 suppress，避免回放后的画布反过来覆盖目标快照。 */
import { useStudioStore } from './studioStore';
import { useUiStore } from './uiStore';
import { chapterBoardOf } from './chapterRegions';

const SYNC_DELAY = 300;
let started = false;
let timer: number | null = null;
let suppressDepth = 0;

/** 当前章（若正在编辑其所属画布且有区域）同步快照；返回是否写入。 */
export function syncActiveChapterScene(): boolean {
  if (suppressDepth > 0) return false;
  const st = useStudioStore.getState();
  const chapterId = useUiStore.getState().activeChapterId;
  if (!chapterId) return false;
  const chapter = st.chapters.find((c) => c.id === chapterId);
  if (!chapter) return false;
  const boardId = chapterBoardOf(chapter.volumeId, st.volumes, st.boards);
  if (boardId !== st.activeBoardId) return false;
  const board = st.boards[boardId];
  if (!board?.regions.some((r) => r.chapterId === chapterId)) return false;
  const r = st.syncChapterScene(chapterId);
  return r.ok && r.changed;
}

function cancelTimer(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

function schedule(): void {
  if (suppressDepth > 0) return;
  cancelTimer();
  timer = window.setTimeout(() => {
    timer = null;
    if (suppressDepth > 0) return;
    syncActiveChapterScene();
  }, SYNC_DELAY);
}

/** 切章/载入存档/批量回放期间暂停自动同步；同步执行，结束后恢复。 */
export function withChapterSceneSyncSuppressed<T>(fn: () => T): T {
  suppressDepth++;
  cancelTimer();
  try {
    return fn();
  } finally {
    suppressDepth--;
  }
}

/** 在 StudioPage 挂载时启动一次；重复调用为 no-op。 */
export function startChapterSceneSync(): void {
  if (started) return;
  started = true;
  useStudioStore.subscribe((state, prev) => {
    // 人物库变化（属性/状态/形象修改）同样影响快照指纹与名单展示——一并触发
    if (state.boards !== prev.boards || state.characters !== prev.characters) schedule();
  });
}
