/** 🔎 跨卷查人 + 🕒 人物时间轴（P3 · v3 人物库）：纯逻辑，不引入 store，UI / 引擎 / 测试共用。
 *
 *  查人：按人物库逐人一行（人物身份作品级）；每个人物携带其全部画布放置与章节引用数；
 *  同名不同人（规范化后同名、characterId 不同）照常分列，ambiguous 只做提示，绝不合并。
 *  时间轴：按全局章节顺序扫描章节快照，只收集该 characterId 的出现记录；
 *  解析失败时降级显示采集时的冻结标签，不读取、不编造当前属性。 */
import type {
  CastRole,
  CharacterGender,
  CharacterState,
  SimBoard,
  SimChapter,
  SimVolume,
  WorkCharacter,
} from '../types/sim';
import { boardLabel } from './boardOps';
import { resolveSnapshotEntry, type SnapshotResolveError } from './snapshotRefs';

/** 人名检索归一化：全角/半角统一、忽略大小写与空白；不删姓名内部的标点 */
export function normalizeCharacterName(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** 人物在一张画布上的放置摘要 */
export interface CharacterPlacementRef {
  nodeId: string;
  boardId: string;
  boardLabel: string;
  volumeId?: string;
  volumeTitle?: string;
  /** 该放置当前显示的状态标签（按放置独立 C1） */
  activeStateLabel: string;
}

export interface CharacterSearchHit {
  /** 人物库 ID */
  characterId: string;
  /** 当前人名（空名显示「未命名」） */
  name: string;
  nameKey: string;
  gender: CharacterGender;
  /** 首项状态标签（库级当前状态） */
  activeStateLabel: string;
  stateCount: number;
  /** 全部画布上的放置（空数组=未放置，人物可只存在于库中 C7） */
  placements: CharacterPlacementRef[];
  placed: boolean;
  /** 引用该人物的章节快照数 */
  chapterRefs: number;
  /** 全库中存在同名（规范化后相同）人物 */
  ambiguous: boolean;
  /** 同名结果数量（含自身） */
  sameNameCount: number;
}

/** 按人名搜索人物库（每人一行）；空查询返回空数组。
 *  排序：完全匹配 → 前缀匹配 → 包含匹配，再按人名稳定排序。 */
export function searchCharacters(
  characters: Record<string, WorkCharacter>,
  boards: Record<string, SimBoard>,
  volumes: SimVolume[],
  chapters: SimChapter[],
  query: string,
): CharacterSearchHit[] {
  const q = normalizeCharacterName(query);
  if (!q) return [];

  // 章节快照引用计数（按 characterId）
  const refCount = new Map<string, number>();
  for (const c of chapters) {
    for (const e of c.snapshot?.entries ?? []) {
      refCount.set(e.characterId, (refCount.get(e.characterId) ?? 0) + 1);
    }
  }

  const all: CharacterSearchHit[] = [];
  for (const character of Object.values(characters)) {
    const name = (character.name || '未命名').trim() || '未命名';
    const placements: CharacterPlacementRef[] = [];
    for (const board of Object.values(boards)) {
      for (const node of board.nodes) {
        if (node.data.kind !== 'character' || node.data.characterId !== character.id) continue;
        const label = boardLabel(board, volumes);
        const volume = board.volumeId ? volumes.find((v) => v.id === board.volumeId) : undefined;
        const active = character.states.find((s) => s.id === node.data.activeStateId) ?? character.states[0];
        placements.push({
          nodeId: node.id,
          boardId: board.id,
          boardLabel: label,
          ...(board.volumeId ? { volumeId: board.volumeId } : {}),
          ...(volume ? { volumeTitle: volume.title || '未命名卷' } : {}),
          activeStateLabel: active?.label ?? '未命名状态',
        });
      }
    }
    all.push({
      characterId: character.id,
      name,
      nameKey: normalizeCharacterName(name),
      gender: character.gender,
      activeStateLabel: character.states[0]?.label ?? '未命名状态',
      stateCount: character.states.length,
      placements,
      placed: placements.length > 0,
      chapterRefs: refCount.get(character.id) ?? 0,
      ambiguous: false,
      sameNameCount: 1,
    });
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
      a.characterId.localeCompare(b.characterId),
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
  'missing-character': '人物缺失',
  'missing-state': '状态缺失',
};

/** 人物在全部章节快照中的出现记录（全局章节顺序）。
 *  只匹配 characterId（人物库 ID）；解析走 resolveSnapshotEntry（库直查 + 放置可空）。 */
export function characterTimeline(
  chapters: SimChapter[],
  boards: Record<string, SimBoard>,
  volumes: SimVolume[],
  characters: Record<string, WorkCharacter>,
  characterId: string,
  fingerprintOf: (state: CharacterState) => string,
): CharacterTimelineRow[] {
  const rows: CharacterTimelineRow[] = [];
  chapters.forEach((chapter, chapterIndex) => {
    const snap = chapter.snapshot;
    if (!snap) return;
    const entry = snap.entries.find((e) => e.characterId === characterId);
    if (!entry) return;
    const r = resolveSnapshotEntry(entry, snap.boardId, boards, characters, fingerprintOf);
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

/** 人物库直查（用于时间轴标题/详情）；未命中返回 undefined */
export function findCharacterById(
  characters: Record<string, WorkCharacter>,
  characterId: string,
): WorkCharacter | undefined {
  return characters[characterId];
}
