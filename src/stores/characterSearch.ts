/** 🔎 跨卷查人 + 🕒 人物时间轴（P3）：纯逻辑，不引入 store，UI / 引擎 / 测试共用。
 *
 *  查人：按规范化人名在全部画布搜索；结果保留卷/画布归属，同名多处以 ambiguous 标出，绝不合并。
 *  时间轴：按全局章节顺序扫描章节快照，只收集该 characterId 的出现记录；
 *  解析失败时降级显示采集时的冻结标签，不读取、不编造当前属性。 */
import type {
  CastRole,
  CharacterData,
  CharacterGender,
  SimBoard,
  SimChapter,
  SimNodeType,
  SimVolume,
} from '../types/sim';
import { boardLabel } from './boardOps';
import { resolveSnapshotEntry, type SnapshotResolveError } from './snapshotRefs';

/** 人名检索归一化：全角/半角统一、忽略大小写与空白；不删姓名内部的标点 */
export function normalizeCharacterName(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export interface CharacterSearchHit {
  nodeId: string;
  /** 当前人名（空名显示「未命名」） */
  name: string;
  nameKey: string;
  gender: CharacterGender;
  boardId: string;
  boardLabel: string;
  volumeId?: string;
  volumeTitle?: string;
  activeStateLabel: string;
  stateCount: number;
  /** 全部画布中存在同名（规范化后相同）人物 */
  ambiguous: boolean;
  /** 同名结果数量（含自身） */
  sameNameCount: number;
}

/** 按人名跨全部画布搜索；空查询返回空数组。
 *  排序：完全匹配 → 前缀匹配 → 包含匹配，再按人名与画布标签稳定排序。 */
export function searchCharacters(
  boards: Record<string, SimBoard>,
  volumes: SimVolume[],
  query: string,
): CharacterSearchHit[] {
  const q = normalizeCharacterName(query);
  if (!q) return [];

  const all: CharacterSearchHit[] = [];
  for (const board of Object.values(boards)) {
    const label = boardLabel(board, volumes);
    const volume = board.volumeId ? volumes.find((v) => v.id === board.volumeId) : undefined;
    for (const node of board.nodes) {
      if (node.data.kind !== 'character') continue;
      const data = node.data as CharacterData;
      const name = (data.name || '未命名').trim() || '未命名';
      const active = data.states.find((s) => s.id === data.activeStateId) ?? data.states[0];
      all.push({
        nodeId: node.id,
        name,
        nameKey: normalizeCharacterName(name),
        gender: data.gender === 'female' ? 'female' : 'male',
        boardId: board.id,
        boardLabel: label,
        ...(board.volumeId ? { volumeId: board.volumeId } : {}),
        ...(volume ? { volumeTitle: volume.title || '未命名卷' } : {}),
        activeStateLabel: active?.label ?? '未命名状态',
        stateCount: data.states.length,
        ambiguous: false,
        sameNameCount: 1,
      });
    }
  }

  const nameCount = new Map<string, number>();
  for (const h of all) nameCount.set(h.nameKey, (nameCount.get(h.nameKey) ?? 0) + 1);
  const hits = all
    .filter((h) => h.nameKey.includes(q))
    .map((h) => {
      const n = nameCount.get(h.nameKey) ?? 1;
      return { ...h, ambiguous: n > 1, sameNameCount: n };
    });

  const rank = (h: CharacterSearchHit) => (h.nameKey === q ? 0 : h.nameKey.startsWith(q) ? 1 : 2);
  hits.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.name.localeCompare(b.name, 'zh-Hans-CN') ||
      a.boardLabel.localeCompare(b.boardLabel, 'zh-Hans-CN') ||
      a.nodeId.localeCompare(b.nodeId),
  );
  return hits;
}

export type TimelineResolution = 'ok' | SnapshotResolveError;
export type TimelineChange = 'role' | 'state' | 'board' | 'volume';

export interface CharacterTimelineRow {
  chapterId: string;
  chapterTitle: string;
  /** 全局章节顺序（0 起） */
  chapterIndex: number;
  chapterVolumeId: string;
  chapterVolumeTitle: string;
  sourceBoardId: string;
  sourceBoardLabel: string;
  role: CastRole;
  /** 快照记录的状态 ID */
  stateId: string;
  stateLabelAtCapture: string;
  nameAtCapture: string;
  /** 快照记录/最近刷新时间 */
  recordedAt: number;
  resolution: TimelineResolution;
  /** 解析成功时的当前名/状态；失败时回落采集标签 */
  displayName: string;
  displayStateLabel: string;
  /** 该章快照记录后，当前状态属性已被原地修改 */
  contentModified: boolean;
  /** 相对上一次出现的名单变化（首次出现为空） */
  changes: TimelineChange[];
}

export const TIMELINE_CHANGE_LABEL: Record<TimelineChange, string> = {
  role: '角色变化',
  state: '状态变化',
  board: '画布变化',
  volume: '卷变化',
};

export const TIMELINE_RESOLUTION_LABEL: Record<TimelineResolution, string> = {
  ok: '可解析',
  'missing-board': '来源画布缺失',
  'missing-character': '人物缺失',
  'missing-state': '状态缺失',
  'ambiguous-character': '跨卷同名歧义',
};

/** 人物在全部章节快照中的出现记录（全局章节顺序）。
 *  只匹配 characterId；解析走 resolveSnapshotEntry（精确优先，唯一跨画布回退，歧义不猜）。 */
export function characterTimeline(
  chapters: SimChapter[],
  boards: Record<string, SimBoard>,
  volumes: SimVolume[],
  characterId: string,
  fingerprintOf: (state: CharacterData['states'][number]) => string,
): CharacterTimelineRow[] {
  const rows: CharacterTimelineRow[] = [];
  chapters.forEach((chapter, chapterIndex) => {
    const snap = chapter.snapshot;
    if (!snap) return;
    const entry = snap.entries.find((e) => e.characterId === characterId);
    if (!entry) return;
    const r = resolveSnapshotEntry(entry, snap.boardId, boards, fingerprintOf);
    const sourceBoard = boards[snap.boardId];
    const chapterVolume = chapter.volumeId ? volumes.find((v) => v.id === chapter.volumeId) : undefined;
    const prev = rows[rows.length - 1];
    const changes: TimelineChange[] = [];
    if (prev) {
      if (prev.role !== entry.role) changes.push('role');
      if (prev.stateId !== entry.stateId) changes.push('state');
      if (prev.sourceBoardId !== snap.boardId) changes.push('board');
      if (prev.chapterVolumeId !== chapter.volumeId) changes.push('volume');
    }
    rows.push({
      chapterId: chapter.id,
      chapterTitle: chapter.title.trim() || '未命名章节',
      chapterIndex,
      chapterVolumeId: chapter.volumeId,
      chapterVolumeTitle: chapterVolume ? chapterVolume.title || '未命名卷' : '未分卷',
      sourceBoardId: snap.boardId,
      sourceBoardLabel: sourceBoard ? boardLabel(sourceBoard, volumes) : `已删除的画布（${snap.boardId}）`,
      role: entry.role,
      stateId: entry.stateId,
      stateLabelAtCapture: entry.stateLabelAtCapture,
      nameAtCapture: entry.nameAtCapture,
      recordedAt: snap.updatedAt || snap.capturedAt,
      resolution: r.ok ? 'ok' : r.error,
      displayName: r.ok ? r.name : entry.nameAtCapture,
      displayStateLabel: r.ok ? r.state.label : entry.stateLabelAtCapture,
      contentModified: r.ok ? r.stateChanged : false,
      changes,
    });
  });
  return rows;
}

/** 当前画布里该 ID 的人物（用于时间轴标题）；全画布唯一才返回，避免同名/复制混淆 */
export function findCharacterById(
  boards: Record<string, SimBoard>,
  characterId: string,
): (SimNodeType & { data: CharacterData }) | undefined {
  const hits = Object.values(boards)
    .flatMap((b) => b.nodes)
    .filter(
      (n): n is SimNodeType & { data: CharacterData } =>
        n.data.kind === 'character' && n.id === characterId,
    );
  return hits.length === 1 ? hits[0] : undefined;
}
