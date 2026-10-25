/** 📌 上次保存时的当前章节（UI 记忆）：只在手动保存成功后写入，用于刷新后让章节高亮、
 *  画布场景与存档保持一致。它不属于作品内容，不参与“未保存改动”判断。 */
const ACTIVE_CHAPTER_KEY = 'nc2-active-chapter-v1';

export function readSavedActiveChapterId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const id = window.localStorage.getItem(ACTIVE_CHAPTER_KEY);
    return id && id.trim() ? id : null;
  } catch {
    return null;
  }
}

export function persistActiveChapterId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_CHAPTER_KEY, id);
    else window.localStorage.removeItem(ACTIVE_CHAPTER_KEY);
  } catch {
    /* 隐私模式写不进去：只影响刷新后的章节定位，不影响作品内容 */
  }
}
