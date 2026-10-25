/** 🎭 章节生成上下文（R4）：有快照时只注入本章名单，无快照才回退工作画布摘要。
 *  纯逻辑，不依赖 store——便于引擎/UI/临时脚本共用与断言。
 *
 *  快照名单是权威边界：
 *  - 在场可行动/说话/被直接描写；仅提及只能被提到；
 *  - 不新增具名人物；允许无名群演，但不得给姓名、独立台词或推动剧情；
 *  - 解析不到的条目标「资料缺失」，禁止猜测补全；
 *  - 环境使用快照冻结的描述，不受画布后续修改影响。 */
import type { ChapterRegion, ChapterSnapshot, ChapterSnapshotEntry, EnvironmentType, SimBoard, SimChapter, SimVolume } from '../types/sim';
import { ENV_TYPE_LABELS } from '../types/sim';
import { snapshotIssueLabel, snapshotStaleness, stateFingerprint } from '../stores/chapterSnapshots';
import { resolveSnapshotEntry } from '../stores/snapshotRefs';
import { boardLabel } from '../stores/boardOps';

export type StageMode = 'snapshot' | 'legacy';

export interface ChapterStageContext {
  block: string;
  mode: StageMode;
  warnings: string[];
  /** 快照中解析不到人物/状态的条目数 */
  missing: number;
  presentCount: number;
  mentionedCount: number;
}

export const SNAPSHOT_BLOCK_CAP = 3600;

const HARD_RULES = [
  '- 只有在场人物可行动、说话、被直接描写。',
  '- 仅提及人物只能被提到，不得写成在场，不得拥有现场行动或台词。',
  '- 不得新增具名人物；允许无名背景群演，但不得给群演姓名、独立台词，也不得让群演推动剧情。',
  '- 不得发明名单外人物、环境、属性、关系或身份。',
  '- 资料缺失的条目不得猜测补全。',
  '- 本章舞台以本快照为准，不用工作画布中的非名单人物替代。',
];

function cut(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function stateSummary(e: ChapterSnapshotEntry, state: { age?: number; basicInfo: string; identityInfo: string; relations?: string } | undefined, full: boolean): string {
  if (!state) return '';
  const parts: string[] = [];
  if (typeof state.age === 'number' && Number.isFinite(state.age) && state.age > 0) parts.push(`年龄 ${state.age}`);
  if (state.basicInfo.trim()) parts.push(`基础：${cut(state.basicInfo, full ? 120 : 40)}`);
  if (state.identityInfo.trim()) parts.push(`身份：${cut(state.identityInfo, full ? 100 : 40)}`);
  if (state.relations?.trim()) parts.push(`关系：${cut(state.relations, full ? 80 : 30)}`);
  return parts.join('｜');
}

function envLine(e: ChapterSnapshot['envRefs'][number], withDesc: boolean): string {
  const type = ENV_TYPE_LABELS[(e.etype ?? 'building') as EnvironmentType] ?? '环境';
  const path = e.path || `${type}「${e.name}」`;
  const desc = withDesc && e.desc.trim() ? `：${cut(e.desc, 120)}` : '';
  return `- ${e.name}（${type}）｜${path}${desc}`;
}

function render(snapshot: ChapterSnapshot, boards: Record<string, SimBoard>, sourceLabel: string, full: boolean): {
  text: string;
  missing: number;
  presentCount: number;
  mentionedCount: number;
  missingNames: string[];
} {
  const present = snapshot.entries.filter((e) => e.role === 'present');
  const mentioned = snapshot.entries.filter((e) => e.role === 'mentioned');
  let missing = 0;
  const missingNames: string[] = [];
  const missingLines: string[] = [];
  const presentLines: string[] = [];
  const mentionedLines: string[] = [];

  for (const e of snapshot.entries) {
    const r = resolveSnapshotEntry(e, snapshot.boardId, boards, stateFingerprint);
    const name = r.ok ? r.name : e.nameAtCapture;
    const stateLabel = r.ok ? r.state.label : e.stateLabelAtCapture;
    const path = e.envPathAtCapture || '区域边缘';
    if (!r.ok) {
      missing++;
      missingNames.push(name);
      missingLines.push(`- ${name}｜采集状态：${stateLabel}｜${path}｜资料缺失（不得猜补）`);
      continue;
    }
    const line = `- ${name}｜${stateLabel}｜${path}${stateSummary(e, r.state, full) ? `｜${stateSummary(e, r.state, full)}` : ''}`;
    if (e.role === 'present') presentLines.push(line);
    else mentionedLines.push(`${line}｜仅提及：不得写成在场或拥有现场行动`);
  }

  const lines = [
    '【本章舞台快照】（权威名单：只能使用以下人物与环境）',
    `快照来源：${sourceLabel}｜在场 ${present.length} 人｜仅提及 ${mentioned.length} 人`,
    '',
    '【在场】',
    ...(presentLines.length ? presentLines : ['- （无）']),
    '',
    '【仅提及】',
    ...(mentionedLines.length ? mentionedLines : ['- （无）']),
    '',
    '【环境】',
    ...(snapshot.envRefs.length
      ? snapshot.envRefs.map((e) => envLine(e, full))
      : ['- （快照未记录环境）']),
    ...(missingLines.length ? ['', '【资料缺失】（不得猜测补全）', ...missingLines] : []),
    '',
    '【硬性规则】',
    ...HARD_RULES,
  ];
  return {
    text: lines.join('\n'),
    missing,
    presentCount: present.length,
    mentionedCount: mentioned.length,
    missingNames,
  };
}

function boardTitle(snapshotBoardId: string, boards: Record<string, SimBoard>, sourceLabel?: string): string {
  if (sourceLabel) return sourceLabel;
  const b = boards[snapshotBoardId];
  return b ? b.id : `已删除的画布（${snapshotBoardId}）`;
}

/** 有快照时的生成舞台块。boards 用于把引用解析成当前属性；环境描述仍取冻结值。 */
export function buildChapterStageBlock(
  snapshot: ChapterSnapshot,
  boards: Record<string, SimBoard>,
  opts: { sourceLabel?: string } = {},
): ChapterStageContext {
  const label = boardTitle(snapshot.boardId, boards, opts.sourceLabel);
  let r = render(snapshot, boards, label, true);
  let block = r.text;
  // 超长：先压缩人物属性细节与环境描述，仍超长再整体截断（保留开头在场/硬规则依赖顺序）
  if (block.length > SNAPSHOT_BLOCK_CAP) {
    r = render(snapshot, boards, label, false);
    block = r.text;
  }
  let truncated = false;
  if (block.length > SNAPSHOT_BLOCK_CAP) {
    block = `${block.slice(0, SNAPSHOT_BLOCK_CAP)}\n（名单过长，后文条目已截断；但仍不得新增名单外具名人物）`;
    truncated = true;
  }
  const warnings: string[] = [];
  if (r.missing > 0) {
    warnings.push(`名单中有 ${r.missing} 条人物/状态资料缺失，生成时会保留采集标签、不得猜补`);
  }
  if (!boards[snapshot.boardId]) warnings.push('快照来源画布已删除，本次生成使用快照冻结资料');
  if (truncated) warnings.push('名单过长，提示词已截断部分条目');
  return {
    block,
    mode: 'snapshot',
    warnings,
    missing: r.missing,
    presentCount: r.presentCount,
    mentionedCount: r.mentionedCount,
  };
}

/** 无快照时退回工作画布摘要（明确告知模型与作者：本次不是按名单生成） */
export function buildLegacyStageBlock(summary: string, boardLabel: string): ChapterStageContext {
  return {
    block: `【画布舞台（工作画布，未记录本章名单）】
画布：${boardLabel}
${summary}

【注意】本章没有快照名单：人物出场不受名单约束。若需要严格限制本章人物与状态，请在画布上为本章绘制区域（区域内人物会自动成为名单）。`,
    mode: 'legacy',
    warnings: ['本章未记录快照，本次生成使用工作画布全部资料'],
    missing: 0,
    presentCount: 0,
    mentionedCount: 0,
  };
}

/** R6：给编辑 Agent 的当前章只读摘要（比生成块短；按需注入）。
 *  不包含属性长文；只说明章节、来源画布、同步状态、在场/仅提及/缺失与只读规则。 */
export function buildChapterAgentBrief(
  chapter: SimChapter,
  boards: Record<string, SimBoard>,
  volumes: SimVolume[],
  currentRegion: ChapterRegion | undefined,
  cap = 2200,
): string {
  const vol = chapter.volumeId ? volumes.find((v) => v.id === chapter.volumeId) : undefined;
  const head = `【本章上下文（只读）】\n章节：${chapter.title.trim() || '未命名章节'}${vol ? `（${vol.title || '未命名卷'}）` : ''}`;
  const snap = chapter.snapshot;
  if (!snap) {
    return `${head}\n快照：尚未记录${currentRegion ? '（已有区域；把人物移入区域后会自动记录）' : '（尚未绘制本章区域）'}。
- 回答本章人物/在场问题时，只能说明本章尚未记录场景；可从工作画布检索，但不得把工作画布人物说成本章已定名单。
- 你不得直接修改或声称已修改章节快照、名单、区域；当前章场景由系统随工作画布自动同步。`;
  }
  const board = boards[snap.boardId];
  const source = board ? boardLabel(board, volumes) : `已删除的画布（${snap.boardId}）`;
  const stale = snapshotStaleness(snap, board, currentRegion);
  const issue = stale.codes.length ? stale.codes.map(snapshotIssueLabel).join('；') : '与当前画布一致';
  const present: string[] = [];
  const mentioned: string[] = [];
  const missing: string[] = [];
  for (const e of snap.entries) {
    const r = resolveSnapshotEntry(e, snap.boardId, boards, stateFingerprint);
    if (!r.ok) {
      const why = r.error === 'ambiguous-character' ? '跨卷同名歧义（不得猜补）' : '资料缺失（不得猜补）';
      missing.push(`${e.nameAtCapture}｜采集状态：${e.stateLabelAtCapture}｜${why}`);
      continue;
    }
    const path = e.envPathAtCapture || '未归属环境';
    const line = `${r.name}｜${r.state.label}｜${path}${r.stateChanged ? '｜状态自采集后已修改' : ''}`;
    (e.role === 'present' ? present : mentioned).push(line);
  }
  const lines = [
    head,
    `快照来源：${source}｜${new Date(snap.updatedAt || snap.capturedAt).toLocaleString('zh-CN')}｜核对：${issue}`,
    '【在场】' + (present.length ? `\n- ${present.join('\n- ')}` : '（无）'),
    '【仅提及】' + (mentioned.length ? `\n- ${mentioned.join('\n- ')}` : '（无）'),
    ...(missing.length ? ['【资料缺失】\n- ' + missing.join('\n- ')] : []),
    '【只读规则】\n- 只有在场人物可行动/说话；仅提及人物只能被提到，不得写成在场。\n- 不得新增具名人物；可以有无名群演，但不得给姓名、独立台词或推动剧情。\n- 当前章场景随工作画布自动同步：你可以说明改画布会更新本章场景，但不得声称已修改快照/名单/区域，也不得把其他章节的历史场景说成已同步。',
  ];
  let text = lines.join('\n');
  if (text.length > cap) text = `${text.slice(0, cap)}\n…（本章摘要已截断）`;
  return text;
}
