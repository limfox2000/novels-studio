/** 🔍 相邻章快照差异（R7）：按 characterId 对比上一章与当前章的名单快照。
 *  只比较快照记录的冻结标签/引用 ID，不读当前画布属性；未解析由 UI 降级显示。
 *  不做全文差异、不做属性历史版本。 */
import type { CastRole, ChapterSnapshot, ChapterSnapshotEntry } from '../types/sim';

export type ChapterDiffChange =
  | 'added'
  | 'removed'
  | 'role'
  | 'state'
  | 'state-content'
  | 'name'
  | 'env';

export interface ChapterDiffSide {
  characterId: string;
  name: string;
  role: CastRole;
  stateId: string;
  stateLabel: string;
  envPath: string;
  origin: 'region' | 'manual';
}

export interface ChapterDiffRow {
  characterId: string;
  /** 用于显示的名称：移除时取上一章名，其余取当前章名 */
  name: string;
  changes: ChapterDiffChange[];
  from?: ChapterDiffSide;
  to?: ChapterDiffSide;
}

function side(e: ChapterSnapshotEntry): ChapterDiffSide {
  return {
    characterId: e.characterId,
    name: e.nameAtCapture || '未命名',
    role: e.role,
    stateId: e.stateId,
    stateLabel: e.stateLabelAtCapture,
    envPath: e.envPathAtCapture || '',
    origin: e.origin,
  };
}

/** 返回所有有变化的行；顺序：新增、移除、其余（按当前名/ID）。完全相同的条目不出行。 */
export function diffChapterSnapshots(prev: ChapterSnapshot, curr: ChapterSnapshot): ChapterDiffRow[] {
  const prevMap = new Map(prev.entries.map((e) => [e.characterId, e]));
  const currMap = new Map(curr.entries.map((e) => [e.characterId, e]));
  const rows: ChapterDiffRow[] = [];
  for (const e of curr.entries) {
    const before = prevMap.get(e.characterId);
    if (!before) {
      rows.push({ characterId: e.characterId, name: side(e).name, changes: ['added'], to: side(e) });
      continue;
    }
    const changes: ChapterDiffChange[] = [];
    if (before.role !== e.role) changes.push('role');
    if (before.stateId !== e.stateId) changes.push('state');
    else if (before.stateFingerprintAtCapture !== e.stateFingerprintAtCapture) changes.push('state-content');
    if ((before.nameAtCapture || '') !== (e.nameAtCapture || '')) changes.push('name');
    if ((before.envPathAtCapture || '') !== (e.envPathAtCapture || '')) changes.push('env');
    if (changes.length) {
      rows.push({
        characterId: e.characterId,
        name: side(e).name,
        changes,
        from: side(before),
        to: side(e),
      });
    }
  }
  for (const e of prev.entries) {
    if (currMap.has(e.characterId)) continue;
    rows.push({ characterId: e.characterId, name: side(e).name, changes: ['removed'], from: side(e) });
  }
  const rank = (r: ChapterDiffRow) => (r.changes.includes('added') ? 0 : r.changes.includes('removed') ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh-CN') || a.characterId.localeCompare(b.characterId));
  return rows;
}

export const DIFF_CHANGE_LABEL: Record<ChapterDiffChange, string> = {
  added: '新增',
  removed: '移除',
  role: '角色变化',
  state: '状态切换',
  'state-content': '状态内容修改',
  name: '改名',
  env: '环境变化',
};
