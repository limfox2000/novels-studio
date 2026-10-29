/** 🔗 快照引用解析（R3/R5/V3 · v3 人物库）：把快照条目解析回人物库记录与画布放置；统计人物/状态被哪些章节引用。
 *  不引入 store，便于 UI/引擎/测试共用。
 *
 *  解析原则（人物库全局唯一，无歧义分支）：
 *  1. 人物 = characters[entry.characterId] 直查；缺失 → missing-character（快照保留陈旧条目供 UI 提示）；
 *  2. 状态在人物库内查找；缺失 → missing-state（不从别的状态借）；
 *  3. 放置 = 快照 boardId 画布上按 characterId 匹配；**可空**——未放置的人物仍可读出属性，只是无位置；
 *  4. 绝不按名字/卷名/数组顺序猜。 */
import type {
  ChapterSnapshotEntry,
  CharacterState,
  SimBoard,
  SimNodeType,
  WorkCharacter,
} from '../types/sim';
import type { SimChapter } from '../types/sim';

export type SnapshotResolveError = 'missing-character' | 'missing-state';

export type ResolvedSnapshotEntry =
  | {
      ok: true;
      character: WorkCharacter;
      state: CharacterState;
      /** 该章快照画布上的放置节点；人物未放置时为 undefined（属性仍可读） */
      node: SimNodeType | undefined;
      /** 人物当前名（未设置回「未命名」） */
      name: string;
      /** 状态属性相对采集时是否变化 */
      stateChanged: boolean;
    }
  | {
      ok: false;
      error: SnapshotResolveError;
      /** 人物在库中（状态缺失）时提供，供 UI 展示 */
      character?: WorkCharacter;
    };

function okResult(
  character: WorkCharacter,
  state: CharacterState,
  node: SimNodeType | undefined,
  entry: ChapterSnapshotEntry,
  fingerprintOf: (state: CharacterState) => string,
): ResolvedSnapshotEntry {
  return {
    ok: true,
    character,
    state,
    node,
    name: (character.name || '未命名').trim(),
    stateChanged: fingerprintOf(state) !== entry.stateFingerprintAtCapture,
  };
}

/** 快照条目解析：人物库直查 + 快照画布放置（可空）。 */
export function resolveSnapshotEntry(
  entry: ChapterSnapshotEntry,
  snapshotBoardId: string,
  boards: Record<string, SimBoard>,
  characters: Record<string, WorkCharacter>,
  fingerprintOf: (state: CharacterState) => string,
): ResolvedSnapshotEntry {
  const character = characters[entry.characterId];
  if (!character) return { ok: false, error: 'missing-character' };
  const state = character.states.find((s) => s.id === entry.stateId);
  if (!state) return { ok: false, error: 'missing-state', character };
  const board = boards[snapshotBoardId];
  const node = board?.nodes.find(
    (n) => n.data.kind === 'character' && n.data.characterId === entry.characterId,
  );
  return okResult(character, state, node, entry, fingerprintOf);
}

export interface StateReferenceChapter {
  chapterId: string;
  title: string;
  stateLabelAtCapture: string;
}

export interface StateReferenceSummary {
  chapters: StateReferenceChapter[];
  count: number;
}

const EMPTY_REFERENCE: StateReferenceSummary = { chapters: [], count: 0 };

/** 某人物库人物的某个状态被哪些章节快照引用。
 *  stateId 省略 = 该人物在快照中出现的任意状态；引用全局按人物（人物身份作品级，无画布维度）。 */
export function stateReferenceSummary(
  chapters: SimChapter[],
  characterId: string,
  stateId?: string,
): StateReferenceSummary {
  const out: StateReferenceChapter[] = [];
  for (const c of chapters) {
    const snap = c.snapshot;
    if (!snap) continue;
    const entry = snap.entries.find(
      (e) => e.characterId === characterId && (stateId === undefined || e.stateId === stateId),
    );
    if (!entry) continue;
    out.push({
      chapterId: c.id,
      title: c.title.trim() || '未命名章节',
      stateLabelAtCapture: entry.stateLabelAtCapture,
    });
  }
  return out.length ? { chapters: out, count: out.length } : EMPTY_REFERENCE;
}

/** 某人物被哪些章节快照引用（不区分状态） */
export function characterReferenceSummary(chapters: SimChapter[], characterId: string): StateReferenceSummary {
  return stateReferenceSummary(chapters, characterId);
}

/** UI 提示用：把引用章节标题拼成一行，过长时省略 */
export function referenceChapterText(summary: StateReferenceSummary, max = 4): string {
  if (!summary.count) return '';
  const names = summary.chapters.slice(0, max).map((c) => `「${c.title}」`).join('、');
  return summary.count > max ? `${names} 等 ${summary.count} 章` : names;
}

/** 编辑 Agent 按需注入的状态引用摘要：只列被章节快照引用的状态，不含未引用状态。
 *  遍历人物库（人物身份作品级）；绝不把“快照”说成可被 Agent 修改。 */
export function stateReferenceAgentContext(
  chapters: SimChapter[],
  characters: Record<string, WorkCharacter>,
  opts: { cap?: number } = {},
): string {
  const cap = Math.max(400, opts.cap ?? 2400);
  const lines: string[] = [];
  let total = 0;
  for (const character of Object.values(characters)) {
    const name = (character.name || '未命名').trim();
    for (const st of character.states) {
      const ref = stateReferenceSummary(chapters, character.id, st.id);
      if (!ref.count) continue;
      total += 1;
      lines.push(
        `- 人物「${name}」状态「${st.label}」：被 ${ref.count} 章引用（${referenceChapterText(ref, 3)}）`,
      );
      if (lines.join('\n').length > cap) break;
    }
    if (lines.join('\n').length > cap) break;
  }
  if (!total) {
    return '【状态引用】当前作品没有被章节快照引用的人物状态。';
  }
  let body = lines.join('\n');
  if (body.length > cap) {
    body = `${body.slice(0, cap)}\n…（引用列表已截断，仅显示前 ${lines.length} 条中的一部分）`;
  }
  return `【状态引用（只读）】\n${body}\n修改/删除上述状态会改变历史章节的画布表现；快照只记录引用与冻结标签，不会自动更新。你只能修改人物库中的状态，不得声称已修改章节快照、名单或区域。`;
}
