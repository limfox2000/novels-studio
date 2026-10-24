/** 📐 共享当前章节（v2.31）：大纲/正文/顶栏与画布区域高亮共用。
 *  章节删除或尚未选择时回落到首章，并写回非持久化 uiStore；立即返回有效 id，避免面板首帧空白。 */
import { useEffect } from 'react';
import { useStudioStore } from '../../stores/studioStore';
import { useUiStore } from '../../stores/uiStore';

export function useActiveChapterId(): string | null {
  const chapters = useStudioStore((s) => s.chapters);
  const active = useUiStore((s) => s.activeChapterId);
  const setActive = useUiStore((s) => s.setActiveChapterId);
  const valid = !!active && chapters.some((c) => c.id === active);
  const fallback = chapters[0]?.id ?? null;

  useEffect(() => {
    if (valid) return;
    if (active !== fallback) setActive(fallback);
  }, [active, fallback, setActive, valid]);

  return valid ? active : fallback;
}
