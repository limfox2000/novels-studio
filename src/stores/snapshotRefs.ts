/** 🔗 快照引用解析（R3/R5/V3）：把快照条目解析回当前画布上的人物/状态；统计状态被哪些章节引用。
 *  不引入 store，便于 UI/引擎/测试共用。
 *
 *  解析原则：
 *  1. 先精确匹配快照自己的 boardId + characterId + stateId；
 *  2. 来源画布或人物缺失时，按 characterId 在全部画布查找；只有唯一匹配才回退；
 *  3. 多个匹配=歧义（不猜），源画布里人物存在但状态缺失=状态缺失（不从别的画布借状态）；
 *  4. 绝不按名字/卷名/数组顺序猜。 */
import type {
  ChapterSnapshotEntry,
  CharacterData,
  CharacterState,
  SimBoard,
  SimNodeType,
  SimVolume,
} from '../types/sim';
import type { SimChapter } from '../types/sim';
import { boardLabel } from './boardOps';

export type SnapshotResolveError = 'missing-board' | 'missing-character' | 'missing-state' | 'ambiguous-character';

export type ResolvedSnapshotEntry =
  | {
      ok: true;
      board: SimBoard;
      node: SimNodeType & { data: CharacterData };
      state: CharacterState;
      /** 人物当前名（未设置回「未命名」） */
      name: string;
      /** 状态属性相对采集时是否变化 */
      stateChanged: boolean;
    }
  | {
      ok: false;
      error: SnapshotResolveError;
      /** 源画布存在且人物存在时，提供人物供 UI 展示（状态缺失也返回） */
      node?: SimNodeType & { data: CharacterData };
    };

function okResult(
  board: SimBoard,
  node: SimNodeType & { data: CharacterData },
  state: CharacterState,
  entry: ChapterSnapshotEntry,
  fingerprintOf: (state: CharacterState) => string,
): ResolvedSnapshotEntry {
  return {
    ok: true,
    board,
    node,
    state,
    name: (node.data.name || '未命名').trim(),
    stateChanged: fingerprintOf(state) !== entry.stateFingerprintAtCapture,
  };
}

/** 快照条目解析：精确优先；源画布/人物缺失时只在全画布唯一匹配时回退；歧义不猜。 */
export function resolveSnapshotEntry(
  entry: ChapterSnapshotEntry,
  snapshotBoardId: string,
  boards: Record<string, SimBoard>,
  fingerprintOf: (state: CharacterState) => string,
): ResolvedSnapshotEntry {
  const board = boards[snapshotBoardId];
  if (board) {
    const found = board.nodes.find((n) => n.id === entry.characterId);
    if (found && found.data.kind === 'character') {
      const node = found as SimNodeType & { data: CharacterData };
      const state = node.data.states.find((s) => s.id === entry.stateId);
      // 源人物存在但状态缺失：不从其它画布借状态
      if (!state) return { ok: false, error: 'missing-state', node };
      return okResult(board, node, state, entry, fingerprintOf);
    }
  }

  // 回退：全画布按 characterId 查找；排除源画布上已确认不是该人物的同 ID 节点无意义，按全部画布计歧义
  const hits: { board: SimBoard; node: SimNodeType & { data: CharacterData } }[] = [];
  for (const b of Object.values(boards)) {
    const n = b.nodes.find((x) => x.id === entry.characterId);
    if (n && n.data.kind === 'character') {
      hits.push({ board: b, node: n as SimNodeType & { data: CharacterData } });
    }
  }
  if (hits.length === 0) return { ok: false, error: board ? 'missing-character' : 'missing-board' };
  if (hits.length > 1) return { ok: false, error: 'ambiguous-character' };
  const hit = hits[0];
  const state = hit.node.data.states.find((s) => s.id === entry.stateId);
  if (!state) return { ok: false, error: 'missing-state', node: hit.node };
  return okResult(hit.board, hit.node, state, entry, fingerprintOf);
}

export interface StateReferenceChapter {
  chapterId: string;
  title: string;
  boardId: string;
  stateLabelAtCapture: string;
}

export interface StateReferenceSummary {
  chapters: StateReferenceChapter[];
  count: number;
}

const EMPTY_REFERENCE: StateReferenceSummary = { chapters: [], count: 0 };

/** 某画布人物的某个状态被哪些章节快照引用。
 *  stateId 省略 = 该人物在快照中出现的任意状态。只统计源画布精确匹配的快照。 */
export function stateReferenceSummary(
  chapters: SimChapter[],
  boardId: string,
  characterId: string,
  stateId?: string,
): StateReferenceSummary {
  const out: StateReferenceChapter[] = [];
  for (const c of chapters) {
    const snap = c.snapshot;
    if (!snap || snap.boardId !== boardId) continue;
    const entry = snap.entries.find(
      (e) => e.characterId === characterId && (stateId === undefined || e.stateId === stateId),
    );
    if (!entry) continue;
    out.push({
      chapterId: c.id,
      title: c.title.trim() || '未命名章节',
      boardId: snap.boardId,
      stateLabelAtCapture: entry.stateLabelAtCapture,
    });
  }
  return out.length ? { chapters: out, count: out.length } : EMPTY_REFERENCE;
}

/** 某人物被哪些章节快照引用（不区分状态） */
export function characterReferenceSummary(
  chapters: SimChapter[],
  boardId: string,
  characterId: string,
): StateReferenceSummary {
  return stateReferenceSummary(chapters, boardId, characterId);
}

/** UI 提示用：把引用章节标题拼成一行，过长时省略 */
export function referenceChapterText(summary: StateReferenceSummary, max = 4): string {
  if (!summary.count) return '';
  const names = summary.chapters.slice(0, max).map((c) => `「${c.title}」`).join('、');
  return summary.count > max ? `${names} 等 ${summary.count} 章` : names;
}

/** 编辑 Agent 按需注入的状态引用摘要：只列被章节快照引用的状态，不含未引用状态。
 *  boardId 省略时只统计当前画布；绝不把“快照”说成可被 Agent 修改。 */
export function stateReferenceAgentContext(
  chapters: SimChapter[],
  boards: Record<string, SimBoard>,
  volumes: SimVolume[],
  opts: { boardId?: string; cap?: number } = {},
): string {
  const cap = Math.max(400, opts.cap ?? 2400);
  const lines: string[] = [];
  const boardsToScan = opts.boardId
    ? (boards[opts.boardId] ? [boards[opts.boardId]] : [])
    : Object.values(boards);
  let total = 0;
  for (const board of boardsToScan) {
    const bLabel = boardLabel(board, volumes);
    for (const n of board.nodes) {
      if (n.data.kind !== 'character') continue;
      const d = n.data as CharacterData;
      const name = (d.name || '未命名').trim();
      for (const st of d.states) {
        const ref = stateReferenceSummary(chapters, board.id, n.id, st.id);
        if (!ref.count) continue;
        total += 1;
        lines.push(
          `- 画布「${bLabel}」人物「${name}」状态「${st.label}」：被 ${ref.count} 章引用（${referenceChapterText(ref, 3)}）`,
        );
        if (lines.join('\n').length > cap) break;
      }
      if (lines.join('\n').length > cap) break;
    }
    if (lines.join('\n').length > cap) break;
  }
  if (!total) {
    return '【状态引用】当前画布没有被章节快照引用的人物状态。';
  }
  let body = lines.join('\n');
  if (body.length > cap) {
    body = `${body.slice(0, cap)}\n…（引用列表已截断，仅显示前 ${lines.length} 条中的一部分）`;
  }
  return `【状态引用（只读）】\n${body}\n修改/删除上述状态会改变历史章节的画布表现；快照只记录引用与冻结标签，不会自动更新。你只能修改工作画布上的状态，不得声称已修改章节快照、名单或区域。`;
}
