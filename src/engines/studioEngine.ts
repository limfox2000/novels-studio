/** 创作台引擎——🎭 编辑室聊天（🏠 私有模型=设计/推演，双引擎分工；流式走 /api/qwen/chat，
 *  private=自建/租用 GPU 动作前 agentGate 预检、public=SaaS 中转常在线，gate/安全上限复用 agentShared 实现）。
 *  回复内嵌【人物设定】/【环境设定】/【区域规划】结构块 → parseSimBlocks 拆块 → 面板「📎 落为…」落到画布；
 *  块带「更新：已有名字」时走「✏️ 更新…」修改已有对象（只覆盖块里写出的字段）；v3 人物库：人物身份作品级
 *  （画布节点只是放置，人名/性别/状态读库），画布摘要/检索/名单全部按放置查人物库。
 *  📋 章节大纲生成 genChapterOutline（章节大纲规则+全文目标+本章所属卷介绍+画布舞台+前情大纲；v2.14c 起不带全文规则）；
 *  📝 正文生成 genChapterContent（大纲硬门槛，🏠 私有模型 / 🌐 公共模型 二选一，双引擎分工）。
 *  🎯 全文目标 mainGoal（v2.16）：大纲/正文/随机人物默认注入统一方向；🎭 编辑室 v2.19 起默认不注入任何规则/目标
 *  （创意环境不被默认约束），⚙「📜 附带规则与目标」开启后才以【项目资料（按需参考）】提供四类规则/目标；
 *  📚 卷（v2.17）：章节分卷+卷介绍——大纲生成注入本章所属卷介绍，控制整卷各章方向（替代已下线的长期目标节点方案）。 */
import { useStudioStore, boardLabel, ENV_MIN_W, ENV_MIN_H } from '../stores/studioStore';
import { normalizeVolumeTitle } from '../stores/boardOps';
import { chapterBoardOf, findChapterRegion } from '../stores/chapterRegions';
import { stateReferenceAgentContext } from '../stores/snapshotRefs';
import {
  buildChapterAgentBrief,
  buildChapterStageBlock,
  buildLegacyStageBlock,
  type ChapterStageContext,
  type StageMode,
} from './chapterContext';
import { useEditorRoomStore } from '../stores/editorRoomStore';
import { useUiStore } from '../stores/uiStore';
import { GenerationAborted } from '../shared/generation';
import { qwGenerate, qwenUserContent, qwenMessageChars, REASONING_EFFORT_MAX_TOKENS, type QwenChatMessage, type QwenUsage, type ReasoningEffort } from '../shared/qwenClient';
import { startGeneration, stopGeneration } from '../shared/generation';
import { agentGate, characterImageBatchHint, characterImageHint, imageInputHint, promptCharBudget, QWEN_SAFE_LIMIT, type CharacterImageBatch, type CharacterVisionRef } from '../shared/agentShared';
import { CHARACTER_IMAGE_PRESET_DIMS, ENV_TYPE_LABELS, ENV_TYPE_META, GENDER_LABELS, genderOf, type CharacterGender, type CharacterImagePreset, type CharacterState, type CharacterStateImage, type EnvironmentType, type SimChapter, type SimNodeType, type SimVolume, type WorkCharacter } from '../types/sim';
import type { WritingSkill } from '../types/writingSkill';
import { buildWritingSkillsBlock } from './writingSkills';
import { characterActiveState, characterStateOf, STATE_LABEL_CAP } from '../stores/characterStates';
import { imgSubmit, imgTask, imgConfigCached } from '../services/imgApi';

// ── 画布结构摘要（注入编辑室系统上下文）：地图名 + 环境层级链 + 人物（≤900 字符） ──

/** 悬空放置兜底状态（sanitize 正常会滤除；防摘要/检索崩溃） */
const FALLBACK_STATE: CharacterState = { id: '', label: '未命名状态', basicInfo: '', identityInfo: '' };

/** 放置 → (人物库记录, 当前状态)：人名/性别/状态全部读库，activeStateId 按放置（每画布独立） */
function placementState(
  characters: Record<string, WorkCharacter>,
  n: SimNodeType,
): { character: WorkCharacter | undefined; state: CharacterState } {
  if (n.data.kind !== 'character') return { character: undefined, state: FALLBACK_STATE };
  const character = characters[n.data.characterId];
  return { character, state: character ? characterActiveState(character, n.data.activeStateId) : FALLBACK_STATE };
}

export function simCanvasSummary(opts: { full?: boolean; boardId?: string } = {}): string {
  const cut = (s: string, n: number) => (opts.full ? s : s.slice(0, n));
  const st = useStudioStore.getState();
  const board = opts.boardId ? st.boards[opts.boardId] : st.boards[st.activeBoardId];
  const nodes = board?.nodes ?? [];
  const graphName = st.graphName;
  const boardName = board ? boardLabel(board, st.volumes) : '画布不存在';
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 环境的祖先链：城镇「清风镇」＞建筑「铁匠铺」
  const envPath = (n: SimNodeType): string => {
    const chain: string[] = [];
    const guard = new Set<string>();
    let cur: SimNodeType | undefined = n;
    while (cur) {
      if (guard.has(cur.id)) break; // 环保护
      guard.add(cur.id);
      const d = cur.data;
      if (d.kind !== 'environment') break;
      chain.unshift(`${ENV_TYPE_LABELS[d.etype]}「${d.name || '未命名'}」`);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain.join('＞');
  };
  const lines: string[] = [`地图名：${graphName || '未命名'}；画布：${boardName}`];
  if (!nodes.length) lines.push('画布为空（尚无环境/人物）');
  for (const n of nodes) {
    const d = n.data;
    if (d.kind === 'environment') {
      const descAll = (d.desc || '').trim();
      const first = opts.full ? descAll : descAll.split('\n')[0] || '';
      // 图标随类型（v2.18：🛏床/📦物品/🏗其余容器）——AI 一眼分辨物件与可进入的容器
      lines.push(`${ENV_TYPE_META[d.etype].icon} ${envPath(n)}：${cut(first, 24) || '（无描述）'}`);
    } else {
      const p = n.parentId ? byId.get(n.parentId) : undefined;
      // 完整祖先链（镇＞建筑＞房间），否则「某建筑里都有谁」只能看到直属房间
      const at = p && p.data.kind === 'environment' ? `，在${envPath(p)}内` : '';
      // v3 人物库：人名/性别读库（作品级），状态按放置的 activeStateId（每画布独立）
      const character = st.characters[d.characterId];
      const state = character ? characterActiveState(character, d.activeStateId) : FALLBACK_STATE;
      const age = typeof state.age === 'number' && Number.isFinite(state.age) && state.age > 0 ? `/${state.age}岁` : '';
      // v2.27 人物设定两层：基础信息（样子/性情）+ 身份信息（世界位置与故事钩子）
      const basicAll = (state.basicInfo || '').trim();
      const identAll = (state.identityInfo || '').trim();
      const first = opts.full
        ? [basicAll, identAll].filter(Boolean).join('；')
        : basicAll.split('\n')[0] || identAll.split('\n')[0] || '';
      const relAll = (state.relations || '').trim();
      const rel = opts.full ? relAll : relAll.split('\n')[0] || '';
      const stateNote = (character?.states.length ?? 0) > 1 ? `｜状态：${state.label}` : '';
      lines.push(`🧑 ${character?.name || '未命名'}（${GENDER_LABELS[genderOf(character?.gender)]}${age}${at}）：${cut(first, 24) || '（无基础/身份信息）'}${rel ? `｜关系：${cut(rel, 32)}` : ''}${stateNote}`);
    }
  }
  return lines.join('\n').slice(0, opts.full ? READ_CAP : 900);
}

// ── 🌳 画布结构（索引 / 按名检索 / 完整树）：编辑上下文的归属信息统一从这里取 ──

/** 画布父子索引（一次构建，树/检索共用；环与悬空 parentId 自然落到根层/兜底） */
type CanvasIdx = {
  graphName: string;
  nodes: SimNodeType[];
  byId: Map<string, SimNodeType>;
  /** 人物库（人名/性别/状态的唯一来源；放置节点只是引用） */
  characters: Record<string, WorkCharacter>;
  /** characterId → 该画布上的放置（C4 一人一板一个；快照条目按库 ID 反查放置用） */
  charById: Map<string, SimNodeType>;
  envChildren: Map<string, SimNodeType[]>;
  charChildren: Map<string, SimNodeType[]>;
  rootEnvs: SimNodeType[];
  rootChars: SimNodeType[];
};

function canvasIdx(boardId?: string): CanvasIdx {
  const st = useStudioStore.getState();
  const board = boardId ? st.boards[boardId] : st.boards[st.activeBoardId];
  const nodes = board?.nodes ?? [];
  const graphName = st.graphName;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const charById = new Map<string, SimNodeType>();
  for (const n of nodes) {
    if (n.data.kind === 'character' && !charById.has(n.data.characterId)) charById.set(n.data.characterId, n);
  }
  const envChildren = new Map<string, SimNodeType[]>();
  const charChildren = new Map<string, SimNodeType[]>();
  const rootEnvs: SimNodeType[] = [];
  const rootChars: SimNodeType[] = [];
  const parentOf = (n: SimNodeType): string | undefined => (n.parentId && byId.has(n.parentId) ? n.parentId : undefined);
  for (const n of nodes) {
    if (n.data.kind === 'environment') {
      const pid = parentOf(n);
      if (pid) {
        const arr = envChildren.get(pid) ?? [];
        arr.push(n);
        envChildren.set(pid, arr);
      } else rootEnvs.push(n);
    } else if (n.data.kind === 'character') {
      const pid = parentOf(n);
      if (pid) {
        const arr = charChildren.get(pid) ?? [];
        arr.push(n);
        charChildren.set(pid, arr);
      } else rootChars.push(n);
    }
  }
  return { graphName, nodes, byId, characters: st.characters, charById, envChildren, charChildren, rootEnvs, rootChars };
}

const charLabel = (idx: CanvasIdx, n: SimNodeType): string => {
  if (n.data.kind !== 'character') return '';
  const { character, state } = placementState(idx.characters, n);
  const age = typeof state.age === 'number' && state.age > 0 ? `，${state.age}岁` : '';
  const st = (character?.states.length ?? 0) > 1 ? `｜${state.label}` : '';
  return `${character?.name || '未命名'}（${GENDER_LABELS[genderOf(character?.gender)]}${age}${st}）`;
};

const envLabel = (n: SimNodeType): string => {
  if (n.data.kind !== 'environment') return '';
  return `${ENV_TYPE_META[n.data.etype].icon} ${ENV_TYPE_LABELS[n.data.etype]}「${n.data.name || '未命名'}」`;
};

/** 环境祖先链（不含自己）：城镇「清风镇」＞建筑「铁匠铺」 */
function envAncestorPath(idx: CanvasIdx, n: SimNodeType): string {
  const chain: string[] = [];
  const guard = new Set<string>([n.id]);
  let cur = n.parentId ? idx.byId.get(n.parentId) : undefined;
  while (cur && cur.data.kind === 'environment' && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.unshift(envLabel(cur));
    cur = cur.parentId ? idx.byId.get(cur.parentId) : undefined;
  }
  return chain.join('＞');
}

/** 画布索引（常驻、极短）：只列顶层环境名与人数——具体归属在用户提到名字时按需检索，不整张画布注入 */
export function simCanvasIndex(boardId?: string): string {
  const st = useStudioStore.getState();
  const current = boardId ? st.boards[boardId] : st.boards[st.activeBoardId];
  const idx = canvasIdx(current?.id);
  const currentLabel = current ? boardLabel(current, st.volumes) : '画布不存在';
  // 卷名重名时明确标注：编辑室不能拿它当「卷：」目标
  const titleCount = new Map<string, number>();
  for (const v of st.volumes) {
    const key = normalizeVolumeTitle(v.title);
    titleCount.set(key, (titleCount.get(key) ?? 0) + 1);
  }
  const boardList = Object.values(st.boards)
    .map((b) => {
      const label = boardLabel(b, st.volumes);
      const dup = b.volumeId && (titleCount.get(normalizeVolumeTitle(label)) ?? 0) > 1 ? '，重名不可作为卷目标' : '';
      return `${b.id === current?.id ? '▶' : ''}${label}（${b.nodes.length} 节点${dup}）`;
    })
    .join('；');
  const head = `【画布索引】当前画布：${currentLabel}；地图名：${idx.graphName || '未命名'}；全部画布：${boardList || '（无）'}。`;
  if (!idx.nodes.length) {
    return `${head}当前画布为空（尚无环境/人物）。写【人物设定】/【环境设定】/【人物状态】可用「卷：卷名」指定其它卷（省略=当前画布）；卷名必须一字不差，找不到/重名时请用户确认，不得臆测。检索只覆盖当前画布`;
  }
  const top = idx.rootEnvs.slice(0, 12).map(envLabel);
  const more = idx.rootEnvs.length > top.length ? `…等共 ${idx.rootEnvs.length} 个` : '';
  const chars = idx.nodes.filter((n) => n.data.kind === 'character').length;
  const multi = idx.nodes.filter((n) => n.data.kind === 'character' && (idx.characters[n.data.characterId]?.states.length ?? 0) > 1).length;
  const loose = idx.rootChars.length ? `（其中 ${idx.rootChars.length} 人未归属环境）` : '';
  return `${head}当前画布顶层环境：${top.join('、') || '（无）'}${more}；人物 ${chars} 人${loose}${multi ? `，其中 ${multi} 人多状态（按当前状态工作，改指定状态用【人物状态】）` : ''}。提到某个环境/人物名时，系统会自动检索其成员、归属与当前状态（只检索当前画布，不要臆测其它卷成员）`;
}

/** 【画布结构】完整归属树（仅用户问全局/整体时才注入）：环境 → 子环境/人物，不含描述 */
export function simCanvasTree(cap = 12000, boardId?: string): string {
  const idx = canvasIdx(boardId);
  const lines: string[] = [`地图名：${idx.graphName || '未命名'}`];
  if (!idx.nodes.length) lines.push('（画布为空：尚无环境/人物）');
  const seen = new Set<string>();
  const walk = (env: SimNodeType, depth: number) => {
    if (seen.has(env.id)) return;
    seen.add(env.id);
    const pad = '  '.repeat(depth);
    const who = (idx.charChildren.get(env.id) ?? []).map((n) => charLabel(idx, n)).filter(Boolean);
    lines.push(`${pad}${envLabel(env)}${who.length ? `：${who.join('、')}` : ''}`);
    for (const child of idx.envChildren.get(env.id) ?? []) walk(child, depth + 1);
  };
  for (const e of idx.rootEnvs) walk(e, 0);
  for (const n of idx.nodes) if (n.data.kind === 'environment' && !seen.has(n.id)) walk(n, 0); // 环/悬空兜底
  if (idx.rootChars.length) lines.push(`🧑 人物（未归属环境）：${idx.rootChars.map((n) => charLabel(idx, n)).join('、')}`);
  const out = `【画布结构】（环境/人物的完整归属；问「某建筑里都有谁」「某人物在哪」以此为准）\n${lines.join('\n')}`;
  return out.length > cap ? `${out.slice(0, cap)}\n（画布结构较长，已截断）` : out;
}

// ── 🔎 按名检索：不整张画布注入，只检索用户本轮提到的环境/人物（含「医院」命中「仁和医院」这类部分匹配） ──

const normLookup = (s: string): string =>
  (s || '').replace(/[「」『』《》"'“”\s]/g, '').replace(/^(?:人物|环境)/, '');
/** 泛化类型词不做部分匹配，避免「房间」「建筑」这类词命中一堆节点 */
const GENERIC_LOOKUP = new Set(['房间', '病房', '建筑', '社区', '城镇', '区域', '物品', '床', '人物', '环境', '地图', '画布', '里面', '内部']);

/** 名字与消息的匹配分：完整出现优先；否则取名字中最长的 2+ 字片段是否出现在消息里（如「医院」→「仁和医院」） */
function lookupScore(name: string, msg: string): number {
  const n = normLookup(name);
  if (n.length < 2) return 0;
  if (msg.includes(n)) return 100 + n.length;
  let best = 0;
  for (let len = n.length - 1; len >= 2 && !best; len--) {
    for (let i = 0; i + len <= n.length; i++) {
      const sub = n.slice(i, i + len);
      if (GENERIC_LOOKUP.has(sub)) continue;
      if (msg.includes(sub)) { best = len; break; }
    }
  }
  return best;
}

/** 某环境（含全部下层）内的人物，带相对路径；path 为相对命中环境的子路径 */
function collectEnvChars(idx: CanvasIdx, env: SimNodeType): Array<{ n: SimNodeType; path: string[] }> {
  const out: Array<{ n: SimNodeType; path: string[] }> = [];
  const seen = new Set<string>();
  const walk = (e: SimNodeType, path: string[]) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    for (const c of idx.charChildren.get(e.id) ?? []) out.push({ n: c, path });
    for (const ce of idx.envChildren.get(e.id) ?? []) walk(ce, [...path, envLabel(ce)]);
  };
  walk(env, []);
  return out;
}

/** 环境处是否位于已命中环境的下层（避免同时输出「清风镇」和「清风镇」里的「铁匠铺」两份重复结果） */
function hasAncestorIn(idx: CanvasIdx, n: SimNodeType, hits: Set<string>): boolean {
  const guard = new Set<string>([n.id]);
  let cur = n.parentId ? idx.byId.get(n.parentId) : undefined;
  while (cur && !guard.has(cur.id)) {
    if (hits.has(cur.id)) return true;
    guard.add(cur.id);
    cur = cur.parentId ? idx.byId.get(cur.parentId) : undefined;
  }
  return false;
}

/** 用户问的是全局整体（不点名，如「画布上都有谁」「所有人都在哪」）→ 注入完整树 */
const GLOBAL_CANVAS_RE = /画布上|地图上|舞台上|整个画布|全部(?:人物|环境|节点)|所有(?:人物|环境|角色)|全体(?:人物|角色)|都有谁|都有什么人|都有哪些人|人物名单|谁在(?:画布|地图|哪里|哪)/;
/** 命中人物名时，问题若在问「同环境还有谁」也把所在环境的成员带出来 */
const ASK_OCCUPANTS_RE = /都有谁|都有什么人|还有谁|谁在|哪些人|几个人|几人|谁住|谁在住/;
/** 续问：本轮没点名，但显然在说上一轮检索过的对象（「其中的人物」「给他们统一加…」）→ 沿用最近一次命中的范围 */
const FOLLOWUP_RE = /其中|里面|内部|他们|她们|这些人|那些|人物|角色|全员|全体|全部|所有|统一|都(?:加|换|改|要|需要|安排|穿)|上述|刚才|这个|该(?:建筑|环境|医院|房间|城镇|村子)/;

type LookupMsg = { role: string; text: string };
type ScopeHit = { envHits: SimNodeType[]; charHits: SimNodeType[] };

/** 从一段文本里按名字检索环境/人物（当前消息与最近历史共用这一套） */
function matchScope(idx: CanvasIdx, text: string): ScopeHit {
  const msg = normLookup(text);
  if (!msg) return { envHits: [], charHits: [] };
  const pick = (kind: 'environment' | 'character') =>
    idx.nodes
      .filter((n) => n.data.kind === kind)
      .map((n) => ({ n, s: lookupScore(nameOf(idx, n), msg) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 6)
      .map((x) => x.n);
  return { envHits: pick('environment'), charHits: pick('character') };
}

/** 名字统一走这里：环境读节点 data.name，人物读库（放置只是引用） */
const nameOf = (idx: CanvasIdx, n: SimNodeType): string =>
  n.data.kind === 'character' ? (idx.characters[n.data.characterId]?.name || '').trim() : (n.data.name || '').trim();
/** 「（男，32岁）」——名单里姓名单独标注后，性别/年龄用这个后缀，避免和名字混在一起 */
const sexAge = (idx: CanvasIdx, n: SimNodeType): string => {
  if (n.data.kind !== 'character') return '';
  const { character, state } = placementState(idx.characters, n);
  const age = typeof state.age === 'number' && state.age > 0 ? `，${state.age}岁` : '';
  return `（${GENDER_LABELS[genderOf(character?.gender)]}${age}）`;
};

/** 按本轮消息检索画布：命中的环境给**确切人物名单**（含下层），命中的人物给完整归属路径。
 *  history 用于续问（「给他们统一加服装要求」）沿用上一轮点名的医院/环境；
 *  没有命中且不是全局问题 → 返回空串（只保留极短的【画布索引】）。 */
export function canvasLookupBlock(
  userMsg: string,
  history: ReadonlyArray<LookupMsg> = [],
  boardId?: string,
): string {
  const raw = (userMsg || '').trim();
  if (!raw) return '';
  const idx = canvasIdx(boardId);
  if (!idx.nodes.length) return '';

  let scope = matchScope(idx, raw);
  let carriedFrom = '';
  if (!scope.envHits.length && !scope.charHits.length && history.length && FOLLOWUP_RE.test(raw)) {
    // 最近一次提到具体节点的用户消息作为当前话题（避开更早的无关对象）
    const recent = history.filter((m) => m.role === 'user').slice(-12).reverse();
    for (const m of recent) {
      const s = matchScope(idx, m.text);
      if (s.envHits.length || s.charHits.length) {
        scope = s;
        carriedFrom = m.text.trim();
        break;
      }
    }
  }
  const { envHits, charHits } = scope;

  if (!envHits.length && !charHits.length) {
    return GLOBAL_CANVAS_RE.test(raw) ? `\n\n${simCanvasTree(8000, boardId)}` : '';
  }

  const parts: string[] = [];
  const hitIds = new Set(envHits.map((n) => n.id));
  const askWho = ASK_OCCUPANTS_RE.test(raw);
  for (const env of envHits) {
    if (env.data.kind !== 'environment') continue;
    if (hasAncestorIn(idx, env, hitIds)) continue; // 祖先已被命中，成员已在祖先结果里
    const chars = collectEnvChars(idx, env);
    const anc = envAncestorPath(idx, env);
    const head = `${envLabel(env)}${anc ? `（位于 ${anc} 内）` : ''}：内部共 ${chars.length} 人`;
    const desc = (env.data.desc || '').trim();
    const lines = [head];
    if (desc) lines.push(`- 当前描述：${desc.slice(0, 500)}${desc.length > 500 ? '…' : ''}`);
    if (chars.length) {
      const named = chars.filter((c) => !!nameOf(idx, c.n));
      const unnamed = chars.length - named.length;
      const roster = named.slice(0, 80).map((c) => nameOf(idx, c.n)).join('、');
      lines.push(
        named.length
          ? `- 人物名单（【人物设定】的「名字」行逐字使用这些名字；括号里的性别/年龄不属于名字；要统一修改时每人输出一个块）：${roster}${named.length > 80 ? `…等共 ${named.length} 人` : ''}`
          : '- 人物名单：无可按名更新的人物（内部人物都还没有名字）',
      );
      if (unnamed) lines.push(`- 另有 ${unnamed} 个未命名人物（画布上没有名字，无法按名更新；需先在属性面板命名）`);
      const multi = chars.filter((c) => c.n.data.kind === 'character' && (idx.characters[c.n.data.characterId]?.states.length ?? 0) > 1);
      if (multi.length) {
        const statesNote = multi
          .slice(0, 20)
          .map((c) => {
            const st = c.n.data.kind === 'character' ? idx.characters[c.n.data.characterId]?.states : undefined;
            return `${nameOf(idx, c.n) || '未命名'}：${(st ?? []).map((s) => s.label).join('/')}`;
          })
          .join('；');
        lines.push(
          `- 多状态人物（【人物设定】只改当前状态；要改指定状态必须用【人物状态】，「状态」行逐字使用下列状态名）：${statesNote}${multi.length > 20 ? `…等 ${multi.length} 人` : ''}`,
        );
      }
      for (const c of chars.slice(0, 60)) {
        const sub = c.path.length ? ` — ${c.path.join('＞')}` : '';
        const nm = nameOf(idx, c.n);
        const { state: cur } = placementState(idx.characters, c.n);
        const stCount = c.n.data.kind === 'character' ? (idx.characters[c.n.data.characterId]?.states.length ?? 0) : 0;
        const st = cur && stCount > 1 ? `｜当前状态：${cur.label}` : '';
        lines.push(
          nm ? `- 名字：${nm}${sexAge(idx, c.n)}${st}${sub}` : `- 未命名人物${sexAge(idx, c.n)}${st}（无名字，无法按名更新）${sub}`,
        );
      }
      if (chars.length > 60) lines.push(`- ……其余 ${chars.length - 60} 人见上方名单`);
    } else lines.push('- （内部暂无人物）');
    // 直属子环境及各自人数（一眼看清层级分布）
    const kids = idx.envChildren.get(env.id) ?? [];
    if (kids.length) {
      const kidCount = (k: SimNodeType) => collectEnvChars(idx, k).length;
      const list = kids.slice(0, 20).map((k) => `${envLabel(k)}（${kidCount(k)} 人）`);
      lines.push(`- 子环境：${list.join('、')}${kids.length > 20 ? `…等 ${kids.length} 个` : ''}`);
    }
    parts.push(lines.join('\n'));
  }
  for (const ch of charHits) {
    if (ch.data.kind !== 'character') continue;
    const anc = envAncestorPath(idx, ch);
    const shot = (s: string | undefined) => {
      const t = (s || '').trim();
      return t ? t.slice(0, 500) + (t.length > 500 ? '…' : '') : '';
    };
    const attrsOf = (st: CharacterState): string[] => [
      typeof st.age === 'number' && st.age > 0 ? `年龄：${st.age}岁` : '',
      shot(st.basicInfo) ? `基础信息：${shot(st.basicInfo)}` : '',
      shot(st.identityInfo) ? `身份信息：${shot(st.identityInfo)}` : '',
      shot(st.relations) ? `关系信息：${shot(st.relations)}` : '',
    ].filter(Boolean);
    const character = idx.characters[ch.data.characterId];
    const states = character?.states ?? [];
    const cur = character ? characterActiveState(character, ch.data.activeStateId) : undefined;
    // 「李刚重伤后是什么样」：先命中人物，再在消息里匹配状态标签（长标签优先，避免 状态1 命中 状态10）
    const wanted = states
      .slice()
      .sort((a, b) => normLookup(b.label).length - normLookup(a.label).length)
      .find((s) => {
        const label = normLookup(s.label);
        return label.length >= 2 && normLookup(raw).includes(label);
      });
    const wantedAttrs = wanted && wanted.id !== cur?.id ? attrsOf(wanted) : [];
    const stateInfo = character && cur
      ? states.length > 1
        ? `｜当前状态：${cur.label}（固定人名/性别；全部状态：${states.map((s) => s.label).join('、')}）`
        : ''
      : '';
    const nm = nameOf(idx, ch);
    const currentAttrs = cur ? attrsOf(cur) : [];
    parts.push(
      nm
        ? `名字：${nm}${sexAge(idx, ch)} — 位于 ${anc ? `${anc}内` : '画布根层（未归属环境）'}${stateInfo}${currentAttrs.length ? `\n  当前状态属性：${currentAttrs.join('；')}` : ''}${wantedAttrs.length ? `\n  状态「${wanted!.label}」：${wantedAttrs.join('；')}` : ''}`
        : `未命名人物${sexAge(idx, ch)}（无名字，无法按名更新） — 位于 ${anc ? `${anc}内` : '画布根层（未归属环境）'}${stateInfo}`,
    );
    // 「李刚那个房间都有谁」这类：顺带列出其所在环境（非根层）的成员
    if (askWho && ch.parentId) {
      const env = idx.byId.get(ch.parentId);
      if (env && env.data.kind === 'environment' && !hitIds.has(env.id)) {
        hitIds.add(env.id);
        const chars = collectEnvChars(idx, env);
        const roster = chars.slice(0, 40).map((c) => nameOf(idx, c.n) || '（未命名）').join('、');
        parts.push(`${envLabel(env)}内部共 ${chars.length} 人：${roster}${chars.length > 40 ? '…' : ''}`);
      }
    }
  }
  const carried = carriedFrom ? `（本轮未点名，沿用最近提到的「${carriedFrom.slice(0, 40)}」）` : '';
  return `\n\n【画布检索】${carried}（系统按名字从画布查出的真实名单与归属，以此为准；回答/修改必须使用名单中的实际名字，不要凭记忆自拟名字）\n${parts.join('\n')}`;
}

/** 本轮按名/按群组命中的人物中、有形象大图的状态（编辑室读图候选）。
 *  ⚠ 只有用户**明确要求读取形象图**时才检索画布；普通提到人物/长相/穿搭不会自动附图。
 *  agent 没有工具调用，因此按消息里点到的状态名优先，否则当前状态，再退到第一个有图的状态。 */
export interface CharacterImageCandidate {
  /** 人物库 ID（形象属库：同一人物的所有画布放置共享，改一处全局生效） */
  characterId: string;
  name: string;
  stateId: string;
  stateLabel: string;
  image: CharacterStateImage;
}

/** 批量读图的目标来源（气泡标注用）：named=本轮点名；environment=环境成员；history=回看最近提到的人；
 *  chapter=当前章名单；canvas=当前画布有形象图的人物（「所有人」等没点名时的兜底）。 */
export type CharacterImageScope = 'named' | 'environment' | 'history' | 'chapter' | 'canvas';

export interface CharacterImageSelection {
  /** 本轮实际选中的候选（按群组上限截断；store 再按批量大小拆成多次请求） */
  candidates: CharacterImageCandidate[];
  /** 命中且有形象大图的人物总数（可能大于 candidates.length） */
  total: number;
  /** 是否群组/批量请求（「这些人/他们/所有人/全员」） */
  group: boolean;
  source: CharacterImageScope;
}

/** 一次批量读图最多选多少人（store 会按每批 CHARACTER_VISION_MAX 张分多次请求）。
 *  避免「所有人物形象」在几十人的画布上一次读完。 */
export const CHARACTER_VISION_GROUP_MAX = 12;

/** 明确要求读取形象图/立绘/参考图；只提名字或讨论长相不算。
 *  也接受「看看李刚的图片」「参考他的立绘」这类 动词 + 图片/形象 的说法。 */
const IMAGE_READ_REQUEST_RE = /形象图|形象大图|人物形象图|人物形象大图|人物图|人物图片|人物立绘|立绘|画像|参考图|原图|(?:读取|读一下|看一下|看看|查看|展示|发我|给我|提供|参考|对照|比对)[^。！？\n]{0,8}(?:形象|立绘|画像|图片|图像)/;
/** 「根据其形象重新设置」「按照这些人的形象统一设计」：目的是按形象改设定，同样视为明确读图要求。
 *  必须带改/统一类动作，避免把「根据形象写一段外貌描写」这种纯文字请求也变成读图。 */
const IMAGE_BASIS_RE = /(?:根据|按照|依照|依据|基于|按|以|用)[^。！？\n]{0,10}(?:形象|立绘|画像|图片|图像|原图)[^。！？\n]{0,10}(?:重新|统一|改|调整|设置|设计|重做|重建|对照|核对|修改|为准)/;
/** 明确请求里用代词/群组指代人物时才回看最近消息定位是谁。 */
const IMAGE_REF_FOLLOWUP_RE = /他|她|他们|她们|其|这个人物|该人物|这个人|此人|上述|刚才|前面|该批|这批/;
/** 群组读图：这些人/他们/全员/所有人…（决定是否展开环境成员、回看名单、或兜底到章节/画布） */
const IMAGE_GROUP_REF_RE = /这些人|这批人|那些人|他们|她们|大家|全员|全体|所有(?:人物|角色|人)|全部(?:人物|角色|人)|每个人|各位|逐个|逐一/;
/** 提到环境且带「里面的人/所有人」时才展开成员（只说「读取医院的形象图」不展开） */
const IMAGE_ENV_GROUP_RE = /其中|里面|内部|里(?:的)?(?:人|人物|角色)|所有|全部|全员|全体|每个人|逐个|逐一/;

type ImageTargetRef = { n: SimNodeType; stateId?: string };

const allNamedChars = (idx: CanvasIdx): SimNodeType[] =>
  idx.nodes.filter((n) => n.data.kind === 'character' && !!nameOf(idx, n));

/** 在一段文本里找出所有被点到的画布人物（不限于 matchScope 的前 6 个），按出现位置排序。
 *  群组场景下用户可能一次列出 5~10 个名字，不能只取相似度前 6。 */
function matchAllChars(idx: CanvasIdx, text: string, limit: number): SimNodeType[] {
  const msg = normLookup(text);
  if (!msg) return [];
  const hits: Array<{ n: SimNodeType; score: number; at: number }> = [];
  for (const n of allNamedChars(idx)) {
    const name = nameOf(idx, n);
    const score = lookupScore(name, msg);
    if (!score) continue;
    const full = normLookup(name);
    hits.push({ n, score, at: full ? msg.indexOf(full) : -1 });
  }
  hits.sort((a, b) => {
    if (a.at >= 0 && b.at >= 0) return a.at - b.at;
    if (a.at >= 0) return -1;
    if (b.at >= 0) return 1;
    return b.score - a.score;
  });
  return hits.slice(0, limit).map((h) => h.n);
}

/** 命中环境 → 其内部（含下层）的有名人物；用于「医院里这些人」这种群组请求。
 *  去重按 characterId（人物库 ID）——同一人物不同画布放置只读一张图。 */
function envOccupantTargets(idx: CanvasIdx, envs: SimNodeType[], limit: number): ImageTargetRef[] {
  const out: ImageTargetRef[] = [];
  const seen = new Set<string>();
  for (const env of envs) {
    if (env.data.kind !== 'environment') continue;
    for (const c of collectEnvChars(idx, env)) {
      const key = c.n.data.kind === 'character' ? c.n.data.characterId : c.n.id;
      if (!nameOf(idx, c.n) || seen.has(key)) continue;
      seen.add(key);
      out.push({ n: c.n });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 回看最近消息（用户与 agent 都算）：先找点名的人物，再找「某环境里这些人」的成员。
 *  agent 消息也算，因为「这些人」经常指上一轮回复里列出的名单。 */
function historyImageTargets(
  idx: CanvasIdx,
  history: ReadonlyArray<{ role: string; text: string }>,
  allowEnv: boolean,
  limit: number,
): { refs: ImageTargetRef[]; text: string; source: CharacterImageScope } | undefined {
  const recent = history.filter((m) => !!m.text?.trim()).slice(-16).reverse();
  for (const m of recent) {
    const chars = matchAllChars(idx, m.text, limit);
    if (chars.length) return { refs: chars.map((n) => ({ n })), text: m.text, source: 'history' };
    if (!allowEnv) continue;
    const envs = matchScope(idx, m.text).envHits;
    if (envs.length) {
      const refs = envOccupantTargets(idx, envs, limit);
      if (refs.length) return { refs, text: m.text, source: 'history' };
    }
  }
  return undefined;
}

/** 群组请求完全没点名时：优先当前章名单，否则当前画布所有有名字的人物。
 *  只对「这些人/他们/全员/所有人」生效；单数代词（其/他）不兜底到全画布。 */
function defaultGroupTargets(
  idx: CanvasIdx,
  group: boolean,
): { refs: ImageTargetRef[]; source: 'chapter' | 'canvas' } | undefined {
  if (!group) return undefined;
  const st = useStudioStore.getState();
  const chapterId = useUiStore.getState().activeChapterId;
  const chapter = st.chapters.find((c) => c.id === chapterId) ?? st.chapters[0];
  const snap = chapter?.snapshot;
  if (snap && snap.boardId === st.activeBoardId && snap.entries.length) {
    const refs: ImageTargetRef[] = [];
    for (const e of snap.entries) {
      // 快照条目 characterId 已是人物库 ID：在本画布按 data.characterId 反查放置（未放置人物跳过）
      const n = idx.charById.get(e.characterId);
      if (n?.data.kind === 'character' && nameOf(idx, n)) refs.push({ n, stateId: e.stateId });
    }
    if (refs.length) return { refs, source: 'chapter' };
  }
  return { refs: allNamedChars(idx).map((n) => ({ n })), source: 'canvas' };
}

export function characterImageCandidates(
  userMsg: string,
  history: ReadonlyArray<{ role: string; text: string }> = [],
  boardId?: string,
): CharacterImageSelection {
  const empty: CharacterImageSelection = { candidates: [], total: 0, group: false, source: 'named' };
  const raw = (userMsg || '').trim();
  // 没有明确读图要求：不检索画布、不附图
  if (!raw || (!IMAGE_READ_REQUEST_RE.test(raw) && !IMAGE_BASIS_RE.test(raw))) return empty;
  const idx = canvasIdx(boardId);
  if (!idx.nodes.length) return empty;

  const group = IMAGE_GROUP_REF_RE.test(raw);
  let refs: ImageTargetRef[] = [];
  let source: CharacterImageScope = 'named';
  let scopeText = raw;

  // 1) 本轮点名的人物（全部，不限于前 6 个）
  const directChars = matchAllChars(idx, raw, 60);
  if (directChars.length) refs = directChars.map((n) => ({ n }));

  // 2) 本轮点名「某环境里的人/所有人」→ 展开成员（只说「读取医院的形象图」时不展开）
  const directEnvs = matchScope(idx, raw).envHits;
  if (directEnvs.length && (group || IMAGE_ENV_GROUP_RE.test(raw))) {
    const occ = envOccupantTargets(idx, directEnvs, 60);
    const seen = new Set(refs.map((r) => r.n.id));
    const extra = occ.filter((r) => !seen.has(r.n.id));
    if (extra.length) {
      refs.push(...extra);
      if (!directChars.length) source = 'environment';
    }
  }

  // 3) 没点名且用了代词/群组说法（这些人/他们/其）→ 回看最近消息里点到的人或环境成员
  const followup = IMAGE_REF_FOLLOWUP_RE.test(raw) || group;
  if (!refs.length && followup) {
    const carried = historyImageTargets(idx, history, group || IMAGE_ENV_GROUP_RE.test(raw), 60);
    if (carried) {
      refs = carried.refs;
      scopeText = carried.text;
      source = carried.source;
    }
  }

  // 4) 群组请求仍没目标 → 当前章名单 / 当前画布有图人物
  if (!refs.length) {
    const fallback = defaultGroupTargets(idx, group);
    if (fallback) {
      refs = fallback.refs;
      source = fallback.source;
    }
  }
  if (!refs.length) return { ...empty, group };

  // 去重（同一人物只读一张；镜像放置同 characterId）并按顺序解析最终状态
  const seen = new Set<string>();
  const uniq = refs.filter((r) => {
    const key = r.n.data.kind === 'character' ? r.n.data.characterId : r.n.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const normRaw = normLookup(raw);
  const normScope = normLookup(scopeText);
  const all: CharacterImageCandidate[] = [];
  for (const r of uniq) {
    if (r.n.data.kind !== 'character') continue;
    const character = idx.characters[r.n.data.characterId];
    const states = character?.states ?? [];
    const name = nameOf(idx, r.n);
    if (!name || !character) continue; // 未命名人物无法在提示里对应图片
    // 长标签优先，避免「状态1」命中「状态10」
    const findWanted = (normText: string) =>
      [...states]
        .sort((a, b) => normLookup(b.label).length - normLookup(a.label).length)
        .find((s) => {
          const label = normLookup(s.label);
          return label.length >= 2 && normText.includes(label);
        });
    const wantedNow = findWanted(normRaw);
    const wantedCarried = scopeText !== raw ? findWanted(normScope) : undefined;
    const preferred = r.stateId ? states.find((s) => s.id === r.stateId) : undefined;
    const cur = characterActiveState(character, r.n.data.activeStateId);
    const state =
      (wantedNow?.image ? wantedNow : undefined) ??
      (preferred?.image ? preferred : undefined) ??
      (wantedCarried?.image ? wantedCarried : undefined) ??
      (cur.image ? cur : states.find((s) => !!s.image));
    if (!state?.image) continue;
    all.push({ characterId: r.n.data.characterId, name, stateId: state.id, stateLabel: state.label, image: state.image });
  }
  return {
    candidates: all.slice(0, CHARACTER_VISION_GROUP_MAX),
    total: all.length,
    group,
    source,
  };
}

// ── 🎯 全文目标（v2.16）：各处生成的统一方向 ──

/** 【全文目标】块（store.mainGoal 非空才注入）：大纲/正文/随机人物各生成点共用
 *  （⚠ 编辑室 v2.19 起默认不注入——改走 projectDataBlock 按需参考，见下） */
function mainGoalBlock(): string {
  const g = useStudioStore.getState().mainGoal.trim();
  return g ? `\n【全文目标】（这部小说的主要目标：生成内容都要服务于这个统一方向）\n${g}\n` : '';
}

/** 📋 章节大纲默认结构：📜章节大纲规则未设置时，大纲生成与编辑室说明都以此为准 */
export const DEFAULT_OUTLINE_RULES = `■ 一句话概要

■ 情境

■ 本章事件链
1.
2.
3.
4.
5.

■ 本章结束状态

■ 钩子`;

/** 默认结构的写法要求：独立于模板文本，避免被当作正文输出 */
export const DEFAULT_OUTLINE_OUTPUT_NOTE = '【输出要求】各段直接写内容；事件链按本章需要写 5-9 条并连续编号，按发生顺序，可增减；不输出段落说明或括号提示。';

/** 【系统说明】块（编辑室专用）：始终注入——让编辑室知道本套件各字段的含义与流程，并能据此产出全文目标；
 *  规则/目标的正文仍不默认约束创意（见 projectDataBlock）。 */
function systemGuideBlock(): string {
  return `
【系统说明】（你所在的小说创作套件的结构，用于理解用户的需求；本对话默认自由创意，不要求遵守下列规则）
- 画布：环境（城镇＞建筑＞房间等嵌套）与人物构成故事舞台；编辑室产出的设定落到画布后，才进入后续创作流程；已有节点可用设定块的「更新：」行修改，不必新建
- 画布支持嵌套：设定块里写「所在：（父环境名）」可把新建的节点直接创建到该环境内部（成为其子节点）；用户说「在XX里/给XX增加」时按此填写
- 🎯 全文目标（上限 500 字）：整部小说的统一方向，大纲/正文/随机人物生成时默认参照
- 📜 全文规则（上限 3000 字）：正文生成的硬约束（世界观、文风等）
- 📋 章节大纲规则（上限 2000 字）：约束章节大纲的结构与写法。未设置时，大纲按以下默认结构生成（■ 为段落标题，事件链编号 5-9 条）：
${DEFAULT_OUTLINE_RULES}
- 🧬 人物生成规则（上限 1000 字）：顶栏「＋人物」自动随机生成人物时遵守
- 📚 卷：章节可分卷，每卷一段介绍，控制整卷各章方向（上限 1000 字）
- 📝 章节：每章有本章需求、大纲、正文；流程为 画布舞台 → 按章生成大纲 → 按章生成正文（正文须先有大纲）
【读写规则】
- 读：默认不读取任何模块内容。只有用户在消息中明确提到某模块（如「全文目标」「卷」「章节」「画布」）时，该模块的当前内容才会以【本轮读取的系统内容】附上；未附上时不要猜测其内容，需要时请用户提到
- 写：只有用户明确要求写入、修改或填入某模块时，才输出【写入】块（协议见下文）；写入需用户点击「📎 写入…」确认后生效。用户没有要求时不要输出【写入】块
`;
}

/** 【项目资料（按需参考）】块（编辑室专用，v2.19）：⚙ 设置「📜 附带规则与目标」开启且任一非空才注入——
 *  全文规则/章节大纲规则/人物生成规则只作为**可查阅资料**（用户提到、或需要与全局方向一致时才用），
 *  不构成默认约束——编辑室是功能与创意环境（用户拍板「可以读到这些内容，而不是默认就喂给它」）。 */
function projectDataBlock(): string {
  if (!useEditorRoomStore.getState().settings.carryRules) return '';
  const st = useStudioStore.getState();
  const parts: string[] = [];
  if (st.rules.trim()) parts.push(`【全文规则】\n${st.rules.trim()}`);
  if (st.outlineRules.trim()) parts.push(`【章节大纲规则】\n${st.outlineRules.trim()}`);
  if (st.charGenRules.trim()) parts.push(`【人物生成规则】\n${st.charGenRules.trim()}`);
  if (!parts.length) return '';
  return `\n【项目资料】（仅供按需参考：用户问到这些内容、或需要与全局方向保持一致时才查阅；默认自由创意，不构成约束）\n${parts.join('\n\n')}\n`;
}

// ── 设定结构块（编辑室回复 → 落画布） ──

export interface EditorRoomBlock {
  kind: 'character' | 'environment';
  label: string; // 展示名（人物/环境）
  name: string;
  /** 修改已有节点时的目标节点名（与【画布索引】/【画布检索】一字不差）；新建为空。
   *  落地时按「同名且同类」唯一定位，只覆盖块里写出的字段，未写字段保留原值。 */
  target?: string;
  /** 创建位置：目标父环境名/层级路径（与【画布索引】/【画布检索】一致，如「清风镇＞铁匠铺」）。
   *  新建时落地为父容器的子节点；修改时表示把节点移入该环境。省略=视口落点/保持原归属。 */
  parent?: string;
  /** 🗂 目标卷画布（v2.29）：卷标题，必须从【画布索引】一字不差抄写；省略=当前画布。
   *  找不到/重名时落地按钮禁用，绝不静默回退当前画布。 */
  volume?: string;
  /** 环境描述（环境块用；人物块改走 basicInfo/identityInfo，v2.27） */
  desc?: string;
  gender?: CharacterGender; // 仅人物块：性别基础属性（落节点随块带上）
  age?: number; // 仅人物块：年龄基础属性（v2.20）
  /** 仅人物块（v2.27）：基础信息（长相/身材/习惯穿搭/性格） */
  basicInfo?: string;
  /** 仅人物块（v2.27）：身份信息（职业/身份/与故事相关的特殊设计） */
  identityInfo?: string;
  relations?: string; // 仅人物块：关系信息（v2.20，随机生成不写、编辑室按用户要求填充）
  etype?: EnvironmentType; // 仅环境块
}

// ── 区域规划块（【区域规划】：一个容器 + 若干建筑的大小/位置，一键整组落地） ──

export interface SimPlanItem {
  name: string;
  etype: EnvironmentType;
  w: number; // 建筑尺寸（像素，已钳制）
  h: number;
  x: number; // 相对区域左上角的坐标（已钳制在区域内）
  y: number;
  desc: string;
}

export interface SimPlanBlock {
  kind: 'plan';
  label: '区域规划';
  name: string;
  etype: EnvironmentType;
  desc: string;
  w: number; // 区域整体尺寸（已钳制）
  h: number;
  items: SimPlanItem[];
}

// ── 卷块（【卷设定】：多章节的大方向与目标，落地即新建一卷；上限与卷管理界面的输入框一致） ──

export const VOLUME_TITLE_CAP = 20;
export const VOLUME_INTRO_CAP = 300;

export interface SimVolumeBlock {
  kind: 'volume';
  label: '卷';
  name: string;
  intro: string;
}

/** 生图块（【生图】：编辑室直接调用生图 API 产出图片；点「🎨 生成图片」才真正提交任务） */
export interface SimImageBlock {
  kind: 'image';
  label: '图片';
  prompt: string; // 画面提示词（≤1000 字）
  size: string; // 比例，如 1:1 / 4:3 / 16:9
}

// ── 人物状态块（【人物状态】：v2.30 只操作已有人的状态，不创建人物、不改人名/性别/所在） ──

export type EditorStateAction = 'create' | 'update' | 'switch' | 'rename' | 'delete' | 'invalid';

export interface EditorStateBlock {
  kind: 'characterState';
  label: '人物状态';
  /** 目标人物名（必须来自画布索引/检索，一字不差） */
  character: string;
  /** 目标卷画布（省略=当前画布） */
  volume?: string;
  action: EditorStateAction;
  /** create=新状态名；其余=已有状态名（update 省略=当前状态） */
  state?: string;
  /** create 的复制基准（省略=当前状态） */
  baseState?: string;
  /** rename 的新状态名 */
  newLabel?: string;
  age?: number;
  basicInfo?: string;
  identityInfo?: string;
  relations?: string;
  parseError?: string;
}

/** 编辑室回复里的结构块（设定块 | 规划块 | 卷块 | 生图块 | 人物状态块），kind 判别 */
export type SimBlock = EditorRoomBlock | SimPlanBlock | SimVolumeBlock | SimImageBlock | EditorStateBlock;

const clampN = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v)));

/** 解析「900×650」类尺寸串（容错 x/X/* 分隔） */
function parseSize(s: string): { w: number; h: number } | null {
  const m = s.match(/(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null;
}

/** 解析【区域规划】块体 → SimPlanBlock；一行建筑都没解析出来时返回 null（UI 提示重出）。
 *  几何钳制：建筑尺寸 ∈ [ENV_MIN,400]×[ENV_MIN,300]，位置钳在区域内；缺位置按 3 列网格兜底。 */
function parsePlanBody(body: string): SimPlanBlock | null {
  const rawType = fieldLine(body, ['类型']);
  const hit = (Object.entries(ENV_TYPE_LABELS) as Array<[EnvironmentType, string]>).find(([, label]) => rawType.includes(label));
  const range = parseSize(fieldLine(body, ['范围', '整体尺寸'])) ?? { w: 800, h: 600 };
  const w = clampN(range.w, 400, 2400);
  const h = clampN(range.h, 300, 1800);
  const layout = fieldRest(body, ['布局', '建筑']);
  const items: SimPlanItem[] = [];
  const lines = layout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-•*\d]/.test(l) && /名字|名称/.test(l));
  for (const line of lines.slice(0, 12)) {
    const nm = line.match(/\s*(?:名字|名称)\s*[：:]\s*(.+?)(?=\s+(?:类型|尺寸|位置|描述)\s*[：:]|$)/);
    const name = (nm?.[1] ?? '').trim().slice(0, 16) || `建筑${items.length + 1}`;
    const t = line.match(/\s*类型\s*[：:]\s*([^\s，,]+)/);
    const tHit = t ? (Object.entries(ENV_TYPE_LABELS) as Array<[EnvironmentType, string]>).find(([, label]) => t[1].includes(label)) : undefined;
    const sz = parseSize(line.match(/\s*尺寸\s*[：:]\s*([^\s，,]+)/)?.[1] ?? '') ?? { w: 150, h: 100 };
    const cw = clampN(sz.w, ENV_MIN_W, 400);
    const ch = clampN(sz.h, ENV_MIN_H, 300);
    const pm = line.match(/\s*位置\s*[：:]\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)/);
    let x = pm ? parseFloat(pm[1]) : NaN;
    let y = pm ? parseFloat(pm[2]) : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      // 缺位置：3 列网格兜底（间距 40）
      const col = items.length % 3;
      const row = Math.floor(items.length / 3);
      x = 40 + col * (cw + 40);
      y = 40 + row * (ch + 40);
    }
    x = clampN(x, 0, Math.max(0, w - cw));
    y = clampN(y, 0, Math.max(0, h - ch));
    const d = line.match(/\s*描述\s*[：:]\s*(.+)$/);
    items.push({ name, etype: tHit?.[0] ?? 'building', w: cw, h: ch, x, y, desc: (d?.[1] ?? '').trim() });
  }
  if (!items.length) return null;
  // 描述只取「范围/布局」段之前的正文——fieldRest 会一路吞到块尾，把布局行一起卷进容器描述
  const headPart = body.split(/\n(?=\s*(?:范围|整体尺寸|布局)\s*[：:]|\s*[-•*])/)[0] ?? body;
  return {
    kind: 'plan',
    label: '区域规划',
    name: fieldLine(body, ['名字', '区域名', '名称']).slice(0, 16) || '规划区域',
    etype: hit?.[0] ?? 'community',
    desc: fieldRest(headPart, ['描述', '详细信息', '设定']),
    w,
    h,
    items,
  };
}

/** 段名 → 块头（【人物设定】/【环境设定】/【人物状态】/【区域规划】/【卷设定】/【生图】） */
const SIM_HEAD_RE = /【(人物设定|环境设定|人物状态|区域规划|卷设定|生图)】/;

/** 单行字段：名字：xxx / 类型：xxx（只取该行） */
function fieldLine(block: string, names: string[]): string {
  for (const name of names) {
    const m = block.match(new RegExp(`^\\s*${name}\\s*[：:]\\s*([^\\n]*)`, 'm'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

/** 多行字段：段名：…（取到块尾） */
function fieldRest(block: string, names: string[]): string {
  for (const name of names) {
    const m = block.match(new RegExp(`^\\s*${name}\\s*[：:]\\s*([\\s\\S]*)$`, 'm'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

/** 「更新：人物「李刚」」→ 李刚（去引号与前置类型词，便于和画布节点名比对） */
function cleanTargetName(s: string): string {
  return s.replace(/[「」『』《》"'“”]/g, '').replace(/^(?:人物|环境)\s*/, '').trim().slice(0, 20);
}

/** 「卷：第二卷 初入宗门」→ 卷标题（去引号/首尾空白，最多 30 字） */
function cleanVolumeRef(s: string): string {
  return s.replace(/[「」『』《》"'“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
}

/** 「所在：清风镇＞铁匠铺」→ 路径文本（保留 ＞/ 作为层级分隔，去掉引号与空白，最多 80 字） */
function cleanParentRef(s: string): string {
  return s
    .replace(/[「」『』《》"'“”]/g, '')
    .replace(/\s+/g, '')
    .replace(/^(?:所在环境|父环境|所在|放入|放在)\s*[：:]?/, '')
    .trim()
    .slice(0, 80);
}

/** 人物块体 → { basicInfo, identityInfo, relations }（v2.27 三层）：
 *  三段都是多行字段，fieldRest 会一路吞到块尾——按段名首次出现位置切段再各自解析，段序颠倒也能正确拆开。
 *  兼容旧协议：未写「基础信息」时，把「详细信息」整体视作基础信息（身份信息留空待补）。 */
function parseCharBody(body: string): { basicInfo: string; identityInfo: string; relations: string } {
  const basic = body.search(/^\s*基础信息\s*[：:]/m);
  const legacy = body.search(/^\s*详细信息\s*[：:]/m);
  const slots = [
    { key: 'basicInfo' as const, idx: basic >= 0 ? basic : legacy, names: basic >= 0 ? ['基础信息'] : ['详细信息'] },
    { key: 'identityInfo' as const, idx: body.search(/^\s*身份信息\s*[：:]/m), names: ['身份信息'] },
    { key: 'relations' as const, idx: body.search(/^\s*关系信息\s*[：:]/m), names: ['关系信息', '关系'] },
  ].filter((s) => s.idx >= 0).sort((a, b) => a.idx - b.idx);
  const out = { basicInfo: '', identityInfo: '', relations: '' };
  slots.forEach((s, i) => {
    out[s.key] = fieldRest(body.slice(s.idx, slots[i + 1]?.idx ?? body.length), s.names);
  });
  if (!slots.length) out.basicInfo = fieldRest(body, ['描述', '设定']);
  return out;
}

/** 状态标签清洗：去引号、压空白、截断（与 characterStates.STATE_LABEL_CAP 同步） */
function cleanStateLabel(s: string): string {
  return s
    .replace(/[「」『』《》"'“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STATE_LABEL_CAP);
}

/** 解析【人物状态】块体 → EditorStateBlock（缺动作/状态等不丢弃，带 parseError 交给 UI 禁用并显示原因） */
function parseStateBody(body: string): EditorStateBlock {
  const character = cleanTargetName(fieldLine(body, ['人物', '人物名']));
  const volume = cleanVolumeRef(fieldLine(body, ['目标卷', '所属卷', '卷画布', '卷']));
  const actionRaw = fieldLine(body, ['动作', '操作']).replace(/\s+/g, '');
  const action: EditorStateAction =
    /^(新建|新增|创建|添加)/.test(actionRaw)
      ? 'create'
      : /^(更新|修改|编辑)/.test(actionRaw)
        ? 'update'
        : /^(切换|设为当前|启用)/.test(actionRaw)
          ? 'switch'
          : /^(重命名|改名)/.test(actionRaw)
            ? 'rename'
            : /^(删除|移除)/.test(actionRaw)
              ? 'delete'
              : 'invalid';
  const newLabelRaw = fieldLine(body, ['新状态名', '新名称']);
  const baseRaw = fieldLine(body, ['基于', '基准状态', '复制自']);
  const stateRaw = fieldLine(body, ['状态']);
  const newLabel = cleanStateLabel(newLabelRaw);
  // create 的「状态」= 新状态名；其余 = 已有状态名；create 未写状态时允许用「新状态名」兜底
  const state = cleanStateLabel(stateRaw) || (action === 'create' ? newLabel : '');
  const baseState = cleanStateLabel(baseRaw);

  // 控制行先剥掉，避免「状态：…」被多行属性字段吞进正文；控制行顺序不影响属性解析
  const content = body
    .replace(/^\s*(?:人物|人物名)\s*[：:].*$/m, '')
    .replace(/^\s*(?:目标卷|所属卷|卷画布|卷)\s*[：:].*$/m, '')
    .replace(/^\s*(?:动作|操作)\s*[：:].*$/m, '')
    .replace(/^\s*新状态名\s*[：:].*$/m, '')
    .replace(/^\s*(?:基于|基准状态|复制自)\s*[：:].*$/m, '')
    .replace(/^\s*状态\s*[：:].*$/m, '');
  const { basicInfo, identityInfo, relations } = parseCharBody(content);
  const wrote = (names: string[]) => names.some((name) => new RegExp(`^\\s*${name}\\s*[：:]`, 'm').test(content));
  const wroteAge = wrote(['年龄']);
  const wroteBasic = wrote(['基础信息']);
  const wroteIdentity = wrote(['身份信息']);
  const wroteRelations = wrote(['关系信息', '关系']);
  const aNum = fieldLine(content, ['年龄']).match(/\d+/);
  const age = aNum ? Math.min(999, parseInt(aNum[0], 10)) : undefined;

  let parseError = '';
  if (!character) parseError = '缺少「人物」行（必须写画布上已有的人物名）';
  else if (action === 'invalid') parseError = '缺少或无法识别「动作」行（新建/修改/切换/重命名/删除）';
  else if (action === 'create' && !state) parseError = '新建状态缺少「状态」行（新状态名）';
  else if (action !== 'create' && action !== 'update' && !state) parseError = '缺少「状态」行（已有状态名）';
  else if (action === 'rename' && !newLabel) parseError = '重命名缺少「新状态名」行';
  else if (action === 'update' && !wroteAge && !wroteBasic && !wroteIdentity && !wroteRelations) {
    parseError = '修改未写任何可更新属性（年龄/基础信息/身份信息/关系信息）';
  }

  return {
    kind: 'characterState',
    label: '人物状态',
    character,
    ...(volume ? { volume } : {}),
    action,
    ...(state ? { state } : {}),
    ...(baseState ? { baseState } : {}),
    ...(newLabel ? { newLabel } : {}),
    ...(wroteAge && age !== undefined ? { age } : {}),
    ...(wroteBasic ? { basicInfo } : {}),
    ...(wroteIdentity ? { identityInfo } : {}),
    ...(wroteRelations ? { relations } : {}),
    ...(parseError ? { parseError } : {}),
  };
}

/** 解析编辑室输出 → 对话正文 + 结构块（设定块/规划块可多块连续输出；零宽字符/**加粗**容错） */
export function parseSimBlocks(text: string): { chat: string; blocks: SimBlock[] } {
  const clean = text.replace(/\*\*/g, '').replace(/[​‌‍﻿]/g, '').trim();
  const first = SIM_HEAD_RE.exec(clean);
  if (!first) return { chat: clean, blocks: [] };
  const chat = clean.slice(0, first.index).trim();
  const blocks: SimBlock[] = [];
  const re = /【(人物设定|环境设定|人物状态|区域规划|卷设定|生图)】[^\n]*\n?([\s\S]*?)(?=\n【(?:人物设定|环境设定|人物状态|区域规划|卷设定|生图|更新职责|更新记忆[^】]*)】|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const head = m[1];
    const body = m[2].trim();
    if (!body) continue;
    if (head === '人物状态') {
      blocks.push(parseStateBody(body));
      continue;
    }
    if (head === '生图') {
      const prompt = fieldRest(body, ['描述', '提示词', '画面']).slice(0, 1000);
      if (prompt) blocks.push({ kind: 'image', label: '图片', prompt, size: fieldLine(body, ['尺寸', '比例']) || '1:1' });
      continue;
    }
    if (head === '卷设定') {
      const title = fieldLine(body, ['名字', '卷名', '名称']).slice(0, VOLUME_TITLE_CAP);
      if (title) blocks.push({ kind: 'volume', label: '卷', name: title, intro: fieldRest(body, ['介绍', '卷介绍', '描述']).slice(0, VOLUME_INTRO_CAP) });
      continue;
    }
    if (head === '区域规划') {
      const plan = parsePlanBody(body);
      if (plan) blocks.push(plan);
      continue;
    }
    const kind: 'character' | 'environment' = head === '人物设定' ? 'character' : 'environment';
    // 「更新：已有节点名」= 修改已有节点；该行只用于定位，从字段正文剥掉，避免被多行字段吞进去
    const target = cleanTargetName(fieldLine(body, ['更新对象', '更新节点', '更新']));
    // 「所在：父环境名/层级路径」= 创建位置（新建时挂为该环境子节点）或修改时移入目标环境；该行只用于定位
    const parent = cleanParentRef(fieldLine(body, ['所在环境', '父环境', '所在', '放入', '放在']));
    // 🗂「卷：卷名」= 目标卷画布（省略=当前画布）；该行只用于定位，必须先从正文剥掉，避免被描述字段吞进去
    const volume = cleanVolumeRef(fieldLine(body, ['目标卷', '所属卷', '卷画布', '画布', '卷']));
    const content = body
      .replace(/^\s*(?:更新对象|更新节点|更新)\s*[：:].*$/m, '')
      .replace(/^\s*(?:所在环境|父环境|所在|放入|放在)\s*[：:].*$/m, '')
      .replace(/^\s*(?:目标卷|所属卷|卷画布|画布|卷)\s*[：:].*$/m, '');
    // 更新块可省略「名字」（保持原名）；新建块未写名字仍按未命名处理
    const name =
      fieldLine(content, kind === 'character' ? ['名字', '人名', '名称'] : ['名字', '环境名', '名称']).slice(0, kind === 'character' ? 12 : 16) ||
      target ||
      '未命名';
    if (kind === 'character') {
      // 性别基础属性：AI 按协议输出「性别：男/女」；更新块未写时保留原值（不默认男）
      const gRaw = fieldLine(content, ['性别']);
      // 年龄：修改块可省略（只改其他字段）；新建缺年龄的块也保留——
      // 是否「修改」由 UI 按块名与画布节点自动判定，解析阶段拿不到画布，不能在这里丢弃
      const aNum = fieldLine(content, ['年龄']).match(/\d+/);
      const age = aNum ? parseInt(aNum[0], 10) : 0;
      // 基础信息/身份信息（v2.27）为人物设定主体；关系信息（v2.20）可省略
      const { basicInfo, identityInfo, relations } = parseCharBody(content);
      blocks.push({
        kind,
        label: '人物',
        name,
        target: target || undefined,
        ...(parent ? { parent } : {}),
        ...(volume ? { volume } : {}),
        ...(gRaw ? { gender: /女/.test(gRaw) ? 'female' as const : 'male' as const } : {}),
        ...(age > 0 ? { age: Math.min(999, age) } : {}),
        basicInfo,
        identityInfo,
        relations: relations || undefined,
      });
    } else {
      const rawType = fieldLine(content, ['类型']);
      const hit = rawType
        ? (Object.entries(ENV_TYPE_LABELS) as Array<[EnvironmentType, string]>).find(([, label]) => rawType.includes(label))
        : undefined;
      blocks.push({
        kind,
        label: '环境',
        name,
        target: target || undefined,
        ...(parent ? { parent } : {}),
        ...(volume ? { volume } : {}),
        desc: fieldRest(content, ['描述', '详细信息', '设定']),
        // 更新块未写「类型」时保留原值（不默认建筑）
        ...(hit ? { etype: hit[0] } : {}),
      });
    }
  }
  const lead = chat || (blocks.length ? '已按模板整理出设定块，点下方按钮落地。' : clean);
  return { chat: lead, blocks };
}

// ── 📝 写入块（编辑室 → 文本设定；仅用户明确要求时输出，落地需用户点击确认） ──

export type WriteField = 'mainGoal' | 'rules' | 'outlineRules' | 'charGenRules' | 'chapterRequirement' | 'chapterOutline';

export const WRITE_TARGETS: Record<WriteField, { label: string; cap: number; setter?: 'setMainGoal' | 'setRules' | 'setOutlineRules' | 'setCharGenRules' }> = {
  mainGoal: { label: '全文目标', cap: 500, setter: 'setMainGoal' },
  rules: { label: '全文规则', cap: 3000, setter: 'setRules' },
  outlineRules: { label: '章节大纲规则', cap: 2000, setter: 'setOutlineRules' },
  charGenRules: { label: '人物生成规则', cap: 1000, setter: 'setCharGenRules' },
  chapterRequirement: { label: '章节需求', cap: 120 },
  chapterOutline: { label: '本章大纲', cap: 2000 },
};

export interface SimWriteBlock {
  kind: 'write';
  field: WriteField;
  text: string; // 已按上限截断
  over: boolean; // 原文超上限被截断
  /** 章节需求写入的目标章节标题（与【章节】列表一字不差） */
  chapter?: string;
}

// 块终止 lookahead 必须含协议头（更新记忆[^】]*同时覆盖【更新记忆】/【更新记忆：模块名】）：
// 否则【写入】/设定块后跟协议块时，协议块被整段吞进块体（正文剥掉后看不见），记忆/职责提取也落空
const WRITE_HEAD_RE = /【写入】([\s\S]*?)(?=\n【(?:人物设定|环境设定|人物状态|区域规划|卷设定|生图|写入|更新职责|更新记忆[^】]*)】|$)/g;

function parseWriteBody(body: string): SimWriteBlock | null {
  const target = fieldLine(body, ['目标']);
  const field = (Object.keys(WRITE_TARGETS) as WriteField[]).find((k) => target.includes(WRITE_TARGETS[k].label));
  // 内容兜底清洗：协议块挤进内容体（未换行时上方 lookahead 拦不住）也不能写进设定
  const content = fieldRest(body, ['内容'])
    .replace(/【(?:更新记忆[^】]*|更新职责)】[\s\S]*?(?=\n【|$)/g, '')
    .trim();
  if (!field || !content) return null;
  const chapter =
    field === 'chapterRequirement' || field === 'chapterOutline' ? fieldLine(body, ['章节']).replace(/^《|》$/g, '').trim() : '';
  if ((field === 'chapterRequirement' || field === 'chapterOutline') && !chapter) return null;
  const cap = WRITE_TARGETS[field].cap;
  return { kind: 'write', field, text: content.slice(0, cap), over: content.length > cap, ...(chapter ? { chapter } : {}) };
}

/** 解析编辑室输出：先摘出【写入】块（仅用户要求时才有），其余交给 parseSimBlocks */
export function parseSimOutput(text: string): { chat: string; blocks: SimBlock[]; writes: SimWriteBlock[] } {
  const writes: SimWriteBlock[] = [];
  const rest = text.replace(WRITE_HEAD_RE, (_m, body: string) => {
    const w = parseWriteBody(body.replace(/\*\*/g, ''));
    if (w) writes.push(w);
    return '';
  });
  const parsed = parseSimBlocks(rest);
  const chat = !parsed.chat && writes.length ? '已按协议整理出写入内容，点下方按钮确认写入。' : parsed.chat;
  return { ...parsed, chat, writes };
}

// ── 🏛 生成能力权限表（v2.20）：blockKinds=可直接落画布的设定块，writeFields=可【写入】的字段。
//    v2.21 作家编辑全模块放行：编辑单独对话的全量执行通道见 meetingEngine.editorExecProtocol（由本表并集构建），
//    本表保留用于 per-模块 责编注入（responsibleBlock 的 scope）与引擎侧路由。 ──
export const EDITOR_MODULE_CAPS: Record<string, { blockKinds: string[]; writeFields: WriteField[] }> = {
  全文目标: { blockKinds: [], writeFields: ['mainGoal'] },
  全文规则: { blockKinds: [], writeFields: ['rules'] },
  人物生成: { blockKinds: ['character', 'characterState'], writeFields: ['charGenRules'] },
  环境生成: { blockKinds: ['environment'], writeFields: [] },
  章节大纲规则: { blockKinds: [], writeFields: ['outlineRules', 'chapterOutline'] },
  章节需求: { blockKinds: [], writeFields: ['chapterRequirement'] },
  卷生成: { blockKinds: ['volume'], writeFields: [] },
  正文生成: { blockKinds: [], writeFields: [] },
};

/** 生图调用（v2.19a 复用生图画布链路；v2.24 双轨）：rail/模型取 imgconfig.json 默认轨
 *  （public=model_list 首项，private=private.workflow_id 工作流 API；读不到配置回落公共轨 gpt-image-2.5）。
 *  提交 /api/img/submit → 2.5s 轮询 → 完成返回落盘 URL。 */
export async function genImage(opts: {
  prompt: string;
  /** 比例（如 '16:9'）；私有轨只接受比例，不接受精确像素 */
  size?: string;
  /** 私有轨清晰度档位 1K/2K/4K；缺省 1K（旧调用行为不变） */
  imageSize?: '1K' | '2K' | '4K';
  onProgress?: (progress: number) => void;
}): Promise<{ ok: boolean; urls?: string[]; error?: string }> {
  try {
    let rail: 'public' | 'private' = 'public';
    let model = 'gpt-image-2.5';
    try {
      const c = await imgConfigCached();
      if (c.default === 'private' && c.private?.base_url && (c.private?.workflow_id || c.private?.model)) {
        rail = 'private';
        // 工作流 API 由服务端按配置读取 workflow_id；model 仅旧版原生 ComfyUI checkpoint 兼容
        model = c.private.workflow_id ? '' : c.private.model || '';
      } else {
        model = c.public?.model_list?.[0] || c.model_list?.[0] || model;
      }
    } catch {
      /* 读不到配置走内置默认（公共轨 gpt-image-2.5） */
    }
    const taskId = await imgSubmit({ model, prompt: opts.prompt, size: opts.size || '1:1', imageSize: opts.imageSize ?? '1K', rail });
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      const t = await imgTask(taskId);
      if (t.status === 'completed' && t.images?.length) return { ok: true, urls: t.images };
      if (t.status === 'failed') return { ok: false, error: t.error || '生成失败' };
      if (t.progress) opts.onProgress?.(t.progress);
    }
    return { ok: false, error: '生成超时（10 分钟）' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── 📖 读取（默认不读；仅当用户本轮消息明确提到某模块时，附上该模块当前内容） ──

const READ_CAP = 6000;

export type MaterialKey = 'mainGoal' | 'rules' | 'outlineRules' | 'charGenRules' | 'volumes' | 'canvas';

export const MATERIAL_LABELS: Record<MaterialKey, string> = {
  mainGoal: '全文目标',
  rules: '全文规则',
  outlineRules: '章节大纲规则',
  charGenRules: '人物生成规则',
  volumes: '卷介绍',
  canvas: '画布舞台',
};

const MATERIAL_BUILDERS: Record<MaterialKey, () => string> = {
  mainGoal: () => `【全文目标】\n${useStudioStore.getState().mainGoal.trim() || '（未设置）'}`,
  rules: () => `【全文规则】\n${useStudioStore.getState().rules.trim() || '（未设置）'}`,
  outlineRules: () => `【章节大纲规则】\n${useStudioStore.getState().outlineRules.trim() || `（未设置，采用默认结构）\n${DEFAULT_OUTLINE_RULES}`}`,
  charGenRules: () => `【人物生成规则】\n${useStudioStore.getState().charGenRules.trim() || '（未设置）'}`,
  volumes: () => {
    const vols = useStudioStore.getState().volumes;
    return `【卷】\n${vols.length ? vols.map((v) => `《${v.title || '未命名卷'}》：${v.intro.trim() || '（介绍未填写）'}`).join('\n') : '（暂无分卷）'}`;
  },
  canvas: () => `【画布】\n${simCanvasSummary({ full: true })}`,
};

/** 会议用项目资料块：按勾选顺序拼接各模块当前内容 */
export function buildMaterialBlock(keys: MaterialKey[]): string {
  return keys.map((k) => MATERIAL_BUILDERS[k]()).join('\n\n');
}

const READ_TRIGGERS: Array<{ re: RegExp; build: () => string }> = [
  {
    re: /全文目标|主要目标|故事目标/,
    build: MATERIAL_BUILDERS.mainGoal,
  },
  {
    re: /全文规则|文风|世界规则/,
    build: MATERIAL_BUILDERS.rules,
  },
  {
    re: /章节大纲规则|大纲规则/,
    build: MATERIAL_BUILDERS.outlineRules,
  },
  {
    re: /人物生成规则|人物规则|随机人物/,
    build: MATERIAL_BUILDERS.charGenRules,
  },
  {
    re: /分卷|卷介绍|本卷|某卷|卷[一二三四五六七八九十\d]|第[一二三四五六七八九十\d]+卷/,
    build: MATERIAL_BUILDERS.volumes,
  },
  {
    re: /章节|大纲|正文|需求|第[一二三四五六七八九十\d]+章/,
    build: chaptersBlock,
  },
  // 画布不再整张注入：归属/成员由 canvasLookupBlock 按用户提到的名字检索（全局问题才回退完整树）
];

/** 【章节】列表块（v2.19e 从 READ_TRIGGERS 提取共用）：编辑室按需读取与章节大纲编辑单独对话共用 */
export function chaptersBlock(): string {
  const { chapters, volumes } = useStudioStore.getState();
  if (!chapters.length) return '【章节】\n（暂无章节）';
  const volName = (id: string) => volumes.find((v) => v.id === id)?.title || '未分卷';
  return `【章节】\n${chapters
    .map(
      (c) =>
        `《${c.title}》（${volName(c.volumeId)}）\n需求：${c.requirement.trim().slice(0, 200) || '（无）'}\n大纲：${c.outline.trim().slice(0, 600) || '（未生成）'}\n正文：${c.content.trim() ? `已成文 ${c.content.trim().length} 字` : '（未生成）'}`,
    )
    .join('\n')}`;
}

/** 本轮读取块：仅匹配到的模块才附上；未提到则返回空串 */
export function buildReadBlock(userMsg: string): string {
  const matched = READ_TRIGGERS.filter((t) => t.re.test(userMsg));
  const parts = matched.map((t) => t.build());
  if (!parts.length) return '';
  return `\n【本轮读取的系统内容】（用户本轮明确提到，仅本轮参考）\n${parts.join('\n\n').slice(0, READ_CAP)}\n`;
}

// ── 🎭 编辑室单轮生成 ──

/** 编辑室对话中的一条消息（store 侧用；发上游时 agent → assistant） */
export interface SimChatMsg {
  role: 'user' | 'agent';
  text: string;
  /** 该条用户消息附带的图片 data URL（仅视觉模型发送时由 IndexedDB 读回；agent 消息不带） */
  images?: string[];
}

/** 编辑室系统消息：舞台搭建助手 + 系统说明 + 本轮读取 + 设定块/写入协议 + 画布状态 + 摘要。
 *  系统说明块始终注入（字段含义与读写规则）；模块正文默认不注入——仅本轮明确提到时附读取块（buildReadBlock），
 *  ⚙「📜 附带规则与目标」开启时才常驻【项目资料】（projectDataBlock）。 */
/** R6：用户本轮问本章/名单/在场时，附当前章只读摘要（不自动采集、不改快照） */
export function chapterAgentBlockIfRelevant(userMsg: string): string {
  if (!/本章|这一章|当前章|第[0-9一二三四五六七八九十百千]+章|在场|提及|名单|快照|切章/.test(userMsg)) return '';
  const st = useStudioStore.getState();
  const activeId = useUiStore.getState().activeChapterId;
  const chapter = st.chapters.find((c) => c.id === activeId) ?? st.chapters[0];
  if (!chapter) return '';
  const preferred = chapterBoardOf(chapter.volumeId, st.volumes, st.boards);
  const hit = findChapterRegion(st.boards, chapter.id, preferred);
  return `\n${buildChapterAgentBrief(chapter, st.boards, st.volumes, st.characters, hit?.region)}\n`;
}

function buildSimSystem(summary: string, readBlock: string, userMsg: string, history: ReadonlyArray<SimChatMsg> = []): string {
  const summaryBlock = summary.trim() ? `\n【早期对话摘要】（更早轮次的要点备忘，回答时遵守其中已定事项）\n${summary.trim()}\n` : '';
  // R5：用户本轮涉及状态/引用/章节时才附引用摘要，避免每轮注入大列表
  const refBlock = /状态|引用|快照|名单|章节|本章|历史/.test(userMsg)
    ? (() => {
        const st = useStudioStore.getState();
        return `\n${stateReferenceAgentContext(st.chapters, st.characters)}\n`;
      })()
    : '';
  const chapterBlock = chapterAgentBlockIfRelevant(userMsg);
  return `你是创作台的「🎭 编辑室」：帮用户在画布（地图）上搭建故事舞台——设计环境（可嵌套成 镇＞建筑＞房间 的地图层级）与人物，产出可直接落到画布的设定。
${summaryBlock}${systemGuideBlock()}
${simCanvasIndex()}${canvasLookupBlock(userMsg, history)}
${readBlock}${projectDataBlock()}${chapterBlock}${refBlock}

【写入协议】（仅当用户明确要求写入、修改或填入某项设定时才输出；默认不要输出）
先在对话中给出草稿与简短说明，用户确认要写入时，在回复最末输出（段名一字不差）：
【写入】
目标：（全文目标 / 全文规则 / 章节大纲规则 / 人物生成规则 / 章节需求 / 本章大纲 六选一，一字不差）
章节：（目标为 章节需求 或 本章大纲 时填写：【章节】列表中《》内的标题，一字不差）
内容：
（要写入的完整正文，可多段；超上限时请先精简：全文目标≤500字、全文规则≤3000字、章节大纲规则≤2000字、人物生成规则≤1000字、章节需求≤120字、本章大纲≤2000字）
- 全文目标/全文规则/章节大纲规则/人物生成规则：一次回复只写入一项
- 章节需求：要写几章就每章输出一个【写入】块，同一回复全部输出；需求必须简短扼要，一两句话（80 字内）说清本章要发生什么，不写大纲、不写分段事件链；章节标题取自【章节】列表
- 本章大纲：一次写一章、每章一个【写入】块；写该章大纲的完整正文（结构遵循章节大纲规则如有）；章节标题取自【章节】列表
- 章节的正文、归卷不支持写入，只能读取；卷的新建用【卷设定】
- 修改画布上已有的人物/环境用【人物设定】/【环境设定】块：「名字」写当前名字（与【画布索引】/【画布检索】一字不差）即自动识别为修改，用户点「✏️ 更新…」确认后生效；不要为修改另建重复节点。只有要改名时才加「更新：（旧名）」行
- 人物身份属于整部作品（人物库）：同名同人是同一个人，修改其属性/状态会在该人物出现的所有画布同步生效；【人物设定】的「卷：」行只决定把人物**放置**到哪张画布，不会复制出另一个人
- 人物有多个状态时，【人物设定】的年龄/基础信息/身份信息/关系信息只作用于**当前状态**；要新建、切换、重命名、删除状态或修改**非当前状态**，必须用【人物状态】块，不能拿【人物设定】代替

【工作方式】
- 用中文自然对话；开放讨论自由发挥，创意具体、少空话
- 用户要你创建/设计人物、环境、设定时，严格按下方协议输出结构块；纯讨论/闲聊/修改建议不要输出结构块
- 用户要求修改画布上已有的人物/环境时：输出对应设定块，「名字」写该节点当前名字（与【画布索引】/【画布检索】一字不差），系统按名字自动识别为修改；只写要改的字段，未写的字段保留原值；要改名时另加「更新：（当前名字，一字不差）」行，再把「名字」写成新名字
- 一次创建多个时连续输出多个对应块；用户点回复下方的「📎 落为人物/环境」按钮落到画布
- 用户要求统一修改某个环境里的全部人物（如「给医院里所有人加统一的服装要求」）：以【画布检索】的「人物名单」为准确认目标，为名单里**每一个人**输出一个【人物设定】块（「名字」逐字抄名单里的名字），每块只写要统一修改的字段；这改的是各人的当前状态，不要回答「无法确定人物名字」——名单就是系统从画布查出的实际名字，用户点「全部更新」一次生效
- 检索里提示「未命名人物」的节点没有名字，无法按名更新：在对话里说明这些节点需要先在属性面板命名，其余有名人物照常输出更新块
- 用户要求在指定环境里创建（如「给铁匠铺增加两个房间」「在铁匠铺里建三个人」「清风镇的村民」）：每个块都加「所在：（父环境名）」行，系统会把节点创建为该环境的子节点并自动排好位置；名称从【画布索引】/【画布检索】一字不差抄写，同名环境用层级路径区分（如「清风镇＞铁匠铺」，用 ＞ 连接）
- 新建房间/建筑时，其父环境必须是容器类型（房间/建筑/社区/城镇/区域/床）；「物品」不是容器，不能作为所在环境
- 用户没说放进哪里时省略「所在」行，节点落到视口中心（落点在某环境内会自动归入）
- 🗂 用户明确要求写到其它卷画布时，每个块加「卷：（卷名）」行；卷名从【画布索引】的「全部画布」一字不差抄写，省略=当前画布。目标卷里的查找（同名人物/所在环境）只在目标画布内进行；找不到或重名时说明并请用户确认，绝不改落到当前画布
- 跨卷复制/移动由用户在画布顶栏用「复制到卷」手动执行；不要声称已经复制，也不要为复制而输出设定块。目标卷还不存在时，先用【卷设定】建卷（新建卷与空白画布），用户在后续回复再用「卷：」写内容
- 章节场景由系统按「章节区域」自动记录：当前章的名单/位置/父环境/状态随工作画布自动同步，切换到其他章节时会恢复该章记录。你只能修改工作画布上的人物/状态/环境；不得声称已直接修改某章快照、名单或区域，也不得把其他章节的历史场景说成已同步。修改被引用状态会影响历史章节的生成内容

【人物产出协议】（段名一字不差）
【人物设定】
更新：（仅修改人物库已有的人物时填写：目标人物当前名字，一字不差；同名多人时不要静默挑选，先向用户确认是哪一位；新建人物都省略本行）
所在：（可选：新建人物所在的环境名或层级路径，从【画布索引】/【画布检索】一字不差抄写；用户要求在某建筑/房间/城镇里创建人物时填写；省略=不归属环境；修改已有人物的普通更新不要写本行，只有用户明确要求移动归属时才写）
卷：（可选：放置目标卷画布名，从【画布索引】的「全部画布」一字不差抄写；省略=当前画布；用户要求把人物放到其它卷时必填；找不到/重名时不要猜，先请用户确认。人物身份全局唯一，「卷：」只是放置位置，不会产生第二个人）
名字：（人名，12 字以内；修改已有人物时写该人物当前名字；要改名则本行写新名字并加「更新：」行）
性别：（男/女 二选一；修改已有人物时可省略，省略则保留原值）
年龄：（新建必填，数字年龄，如 32；修改已有人物时可省略，省略则保留原值）
基础信息：（长相/身材/习惯穿搭/性格，一段话——人物本身的样子与性情；修改时写改动后的完整段落，省略则保留原值）
身份信息：（职业/身份/与故事相关的特殊设计，一段话——人物在世界中的位置与故事钩子；修改时写改动后的完整段落，省略则保留原值）
关系信息：（此人物与其他人物之间的关系，如「李刚之父；与王明有旧怨」，一段话；用户没提到人物关系、或当前没有其他人物可关联时，省略整段）
- 新建人物自动带默认状态「状态0」；更新已有人物的年龄/基础信息/身份信息/关系信息只改其当前状态（按放置逐画布独立）。人名、性别跨状态稳定，任何状态切换都不改变
- 画布上的同名人物是同一个人的多个放置：不要为新放置重复建人；跨画布同名不同人（人物库里的两个人）时，更新前必须让用户确认目标

【人物状态产出协议】（段名一字不差；只操作**人物库已有**人物的状态，不创建人物，也不改人名/性别/所在环境/形象/头像）
【人物状态】
人物：（已有人的当前名字，必须从【画布索引】/【画布检索】一字不差抄写，不得编造）
卷：（可选：目标卷画布名，从【画布索引】的「全部画布」一字不差抄写；省略=当前画布；找不到/重名时不要猜，先请用户确认）
动作：（新建 / 修改 / 切换 / 重命名 / 删除 五选一）
状态：（新建=新状态名，人物内必须唯一，如「重伤后」；修改/切换/重命名/删除=已有状态名，一字不差；修改省略=当前状态）
新状态名：（仅「重命名」填写：改后的状态名，人物内必须唯一）
基于：（仅「新建」可选：复制哪个已有状态，省略=当前状态）
年龄：（可选：当前状态年龄）
基础信息：（可选：只写要改成的完整段落）
身份信息：（可选：只写要改成的完整段落）
关系信息：（可选：只写要改成的完整段落）
- 新建：复制「基于」状态的全部属性与形象/头像引用，再覆盖写出的字段，创建后设为当前状态
- 形象与头像只由用户在属性面板上传、AI 生成或裁切；协议里不要输出图片字段，也不要编造图片 key
- 修改：只改「状态」指定状态的年龄/基础信息/身份信息/关系信息，未写的属性保留
- 切换：把指定状态设为当前状态（画布展示与后续章节生成使用它）
- 重命名：只改状态标签，状态 ID 与属性不变；默认状态也可以重命名
- 删除：删除指定的非默认状态；默认状态（首个）不能删除，人物至少保留一个状态
- 找不到人物/状态、状态名重复或动作不合法时，在对话里如实说明并请用户确认；不要猜测，不要改用【人物设定】冒充，也不要自动创建人物

【环境产出协议】（段名一字不差）
【环境设定】
更新：（仅改画布上已有名称时填写：目标环境的当前名字，一字不差；同名直接修改、新建环境都省略本行）
所在：（可选：新建环境所属的父环境名或层级路径；用户说「在XX里建」「给XX增加两个房间」时填写；省略=独立环境；修改已有节点时只有用户明确要求移动归属才写）
卷：（可选：目标卷画布名，从【画布索引】的「全部画布」一字不差抄写；省略=当前画布；用户要求写到其它卷时必填；找不到/重名时不要猜，先请用户确认）
名字：（环境名，16 字以内；修改已有节点时写该节点当前名字；要改名则本行写新名字并加「更新：」行）
类型：（房间/建筑/社区/城镇/区域/床/物品 七选一；床=容纳人物休息睡觉的容器，如床/炕/通铺；物品=非容器的物件标记——告知此处存在一个东西，如一桌美味的饭菜/一头野兽/一堆火把；修改已有节点时可省略，省略则保留原值）
描述：（外观/功能/氛围，一段话；修改时写改动后的完整段落，省略则保留原值）

【区域规划产出协议】当用户要求一次规划一个成组区域（村落/庄园/街区/营地等，多座建筑一起排布）时，输出段名【区域规划】（一字不差）：
【区域规划】
名字：（区域名）
类型：（社区/城镇/区域 五选一）
描述：（整体外观/氛围，一段话）
范围：（区域整体尺寸，如 900×650；建议宽 700~1100、高 500~800）
布局：（区域内建筑逐行列出，每行一座，格式严格如下）
- 名字：（建筑名，16 字内） 类型：（建筑/房间为主） 尺寸：150×100 位置：80,80 描述：（一句外观/功能，可省略）

- 坐标系：区域左上角为 (0,0)，x 向右、y 向下；「位置」是建筑左上角坐标
- 几何约束（必须遵守）：建筑完整落在范围内、互不重叠、间距 ≥30、距边 ≥30；建筑尺寸多在 140~220 × 90~150
- 排布要有构图意图（如成排、围合晒谷场、沿路两侧），但坐标必须是具体数字
- 一块规划 3~12 座建筑为宜；用户点回复下方的「📎 落为规划」整组落上画布，建筑自动成为区域的子节点（嵌套）

【卷产出协议】当用户要求创建卷（多章节的大方向与目标）时，每一卷输出一个段名【卷设定】（一字不差）：
【卷设定】
名字：（卷名，20 字以内，如「第一卷 初入宗门」）
介绍：（这一卷讲什么、主线推进到哪里、要达成的阶段目标，一段话，300 字以内；后续章节大纲都会服务于这段方向）
- 用户要几卷，就在同一次回复里全部输出，每卷一个【卷设定】块，按卷序排列，不要分多次回复
- 用户点回复下方的「📎 落为卷」即新建该卷，多卷时可点「📥 全部落为卷」一次建齐；已有卷不会被覆盖
- 卷是多章节的大方向，不是单章大纲：只写整卷的方向与目标，不要写具体章节的事件链

【生图协议】当用户要求生成图片（人物立绘、场景插图、封面、地图示意等）时，输出段名【生图】（一字不差）：
【生图】
尺寸：（画面比例，1:1 / 4:3 / 16:9 三选一，默认 1:1；无特殊要求可省略此行）
描述：（画面提示词，写清主体、外观、动作、场景、构图、风格与光线，具体不空泛，一段话）
- 用户要几张就输出几个【生图】块；图片不自动生成，用户点回复下方的「🎨 生成图片」才调用生图 API
- 只在用户明确要图时输出本块；普通讨论/设定文字不要输出`;
}

export interface SimTurnResult {
  ok: boolean;
  error?: string;
  chat?: string;
  blocks?: SimBlock[];
  writes?: SimWriteBlock[];
  /** 本轮实际服务引擎（公共模型时前端打 🌐 标） */
  engine?: 'private' | 'public';
}

/** 🏛 责任编辑（v2.19d）：某功能模块指定的把关编辑——其职责与记忆作为该模块内容生成的指导。
 *  纯数据由 editorialStore.getWorkResponsibleData 解析后传入（memory=该编辑对应模块的技能记忆），引擎不反向依赖编辑部 store。 */
export interface ResponsibleEditor {
  name: string;
  specialty: string;
  persona: string;
  memory?: string;
}

/** 责编/作家编辑注入块：scope 为模块名（生成能力名）；未设置返回空串；memCap 限制注入的技能记忆长度（防膨胀） */
export function responsibleBlock(r: ResponsibleEditor | undefined, scope: string, memCap?: number): string {
  if (!r) return '';
  const full = (r.memory ?? '').trim();
  const mem = memCap ? full.slice(0, memCap) : full;
  return `\n【责任编辑（${scope}）：${r.name}】${scope}的内容由「${r.name}」编辑（${r.specialty}）负责把关，其职责与技能记忆如下，生成时遵循：
【其职责】${r.persona.trim() || '（未设置）'}
【其技能记忆】
${mem || '（暂无记忆）'}`;
}

/** 模块触发词（v2.20）：按命中顺序排列，用于从自由文本中匹配相关生成能力 */
const MENTOR_TRIGGERS: Array<[string, RegExp]> = [
  ['全文目标', /全文目标|主要目标|故事.{0,2}目标/],
  ['全文规则', /全文规则|文风|世界观|世界法则|世界规则/],
  ['人物生成', /人物|角色|主角|配角|人设/],
  ['环境生成', /环境|建筑|房间|地图|场景|城镇|村庄|社区/],
  ['章节大纲规则', /大纲/],
  ['章节需求', /章节需求|需求/],
  ['卷生成', /分卷|归卷|第.{1,3}卷|卷介绍|卷设定/],
  ['正文生成', /正文|成文|写手/],
];

/** 从自由文本匹配相关生成能力模块名（按触发词表顺序，最多 max 个）；
 *  v2.21 作家编辑：总编辑对话注入责编（mentorBlocks）与编辑对话聚焦锚点（editorChatSystem）共用 */
export function matchMentorModules(text: string, max = 1): string[] {
  const picked: string[] = [];
  for (const [mod, re] of MENTOR_TRIGGERS) {
    if (picked.length >= max) break;
    if (re.test(text)) picked.push(mod);
  }
  return picked;
}

/** 总编辑对话按话题注入对应模块责编：命中模块且该模块设有责编时注入其职责与技能记忆（截 1200 字，最多 2 位防膨胀） */
export function mentorBlocks(userMsg: string, mentors?: Partial<Record<string, ResponsibleEditor>>): string {
  if (!mentors) return '';
  return matchMentorModules(userMsg, 2)
    .filter((mod) => mentors[mod])
    .map((mod) => responsibleBlock(mentors[mod], mod, 1200))
    .join('');
}

/** 编辑室单轮生成：agentGate 预检 → system(画布摘要+协议) + 历史 + 本轮消息 → 流式回调用透传；
 *  回复拆【人物设定】/【环境设定】块。中止返回 ok:false（store 保留部分文本）。 */
export async function genSimTurn(opts: {
  history: SimChatMsg[];
  userMsg: string;
  /** 本轮用户附带的图片 data URL（仅 🏠 私有视觉模型支持） */
  userImages?: string[];
  /** 系统自动附带的画布人物形象图（仅 🏠 私有视觉模型；排在用户附图之后） */
  charImages?: CharacterVisionRef[];
  /** 多批读图时的批次信息（系统按每批 ≤3 张分多次请求） */
  charImageBatch?: CharacterImageBatch;
  summary?: string;
  /** 推理强度（off=直接答；越高补全预算越大） */
  reasoningEffort?: ReasoningEffort;
  engine?: 'private' | 'public';
  /** 🏛 各生成能力责编表（总编辑对话时按本轮话题命中注入，见 mentorBlocks；编辑单独对话不注入） */
  mentors?: Partial<Record<string, ResponsibleEditor>>;
  onDelta?: (acc: string) => void;
  onThink?: (acc: string) => void;
  onUsage?: (u: QwenUsage) => void;
}): Promise<SimTurnResult> {
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  const engine = opts.engine ?? 'private';
  const charImages = opts.charImages ?? [];
  const turnImages = [...(opts.userImages ?? []), ...charImages.map((c) => c.url)];
  const hasImages = !!turnImages.length || opts.history.some((m) => !!m.images?.length);
  if (hasImages && engine !== 'private') return { ok: false, error: '图像分析需要使用 🏠 私有模型，请在模型中心切换后重试' };
  const gate = await agentGate(engine);
  if (gate) return { ok: false, error: gate };
  const msgs: QwenChatMessage[] = [
    {
      role: 'system',
      content:
        buildSimSystem(opts.summary ?? '', buildReadBlock(opts.userMsg), opts.userMsg, opts.history) +
        mentorBlocks(opts.userMsg, opts.mentors) +
        imageInputHint(turnImages.length, charImages.length) +
        characterImageHint(charImages) +
        characterImageBatchHint(opts.charImageBatch),
    },
    ...opts.history.map((m) => ({
      role: m.role === 'agent' ? ('assistant' as const) : ('user' as const),
      content: qwenUserContent(m.text, m.images),
    })),
    { role: 'user', content: qwenUserContent(opts.userMsg, turnImages.length ? turnImages : undefined) },
  ];
  // 失控保险：总长超预算从最旧历史开始丢（保留 system 与本轮消息）；预算按模型 nCtx 动态预留补全空间，
  // 聊久后提示词不会挤占补全导致输出被服务端提前截断。图片按固定字符成本计入。
  const maxTokens = REASONING_EFFORT_MAX_TOKENS[opts.reasoningEffort ?? 'off'];
  const budget = promptCharBudget(useEditorRoomStore.getState().meta?.nCtx ?? 0, maxTokens);
  let total = msgs.reduce((a, m) => a + qwenMessageChars(m.content), 0);
  while (total > budget && msgs.length > 2) {
    total -= qwenMessageChars(msgs[1].content);
    msgs.splice(1, 1);
  }
  ui.setGenerating(true);
  const signal = startGeneration();
  try {
    const text = await qwGenerate({
      messages: msgs,
      maxTokens,
      temperature: 0.8,
      reasoningEffort: opts.reasoningEffort,
      engine,
      signal,
      onDelta: opts.onDelta,
      onThinkDelta: opts.onThink,
      onUsage: opts.onUsage,
    });
    const parsed = parseSimOutput(text);
    return {
      ok: true,
      engine,
      chat: parsed.chat,
      ...(parsed.blocks.length ? { blocks: parsed.blocks } : {}),
      ...(parsed.writes.length ? { writes: parsed.writes } : {}),
    };
  } catch (e) {
    if (e instanceof GenerationAborted) return { ok: false, error: '已停止' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    useUiStore.getState().setGenerating(false);
  }
}

// ── 🧬 ＋人物随机生成（人物生成规则存在时，顶栏 ＋人物 依规则随机生成一个人物；v2.15） ──

/** 按人物生成规则随机生成单个人物：agentGate 预检 → 全局互斥 → 【人物设定】块协议输出（parseSimBlocks 解析）。
 *  画布摘要一并注入（避免与已有人物重名/重复）；编辑室批量生成走 genSimTurn（system 注入同一规则）。 */
export async function genRandomCharacter(opts: {
  engine: 'private' | 'public';
  /** 🏛 人物生成责任编辑（注入其职责与记忆，v2.19d） */
  responsible?: ResponsibleEditor;
}): Promise<{ ok: boolean; error?: string; block?: EditorRoomBlock }> {
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  const rule = useStudioStore.getState().charGenRules.trim();
  if (!rule) return { ok: false, error: '未设置人物生成规则' };
  const gate = await agentGate(opts.engine);
  if (gate) return { ok: false, error: gate };
  ui.setGenerating(true);
  const signal = startGeneration();
  try {
    const text = await qwGenerate({
      messages: [
        {
          role: 'system',
          content: `你是创作台的人物设计师：严格依照【人物生成规则】随机生成一个新人物，与画布上已有人物不重名、设定不重复。
【人物生成规则】（人物的名字/性别/年龄/基础信息/身份信息都必须符合这些要求）
${rule}${mainGoalBlock()}${responsibleBlock(opts.responsible, '人物生成')}
【画布舞台】（已有人物与环境，避免重复）
${simCanvasSummary()}
【输出要求】
- 只输出一个结构块，段名一字不差：
【人物设定】
名字：（人名，12 字以内）
性别：（男/女 二选一）
年龄：（必填，数字年龄，符合人物生成规则；不可省略）
基础信息：（长相/身材/习惯穿搭/性格，一段话）
身份信息：（职业/身份/与故事相关的特殊设计，一段话）
- 不要输出关系信息段（随机生成的人物暂无关系可写），不要输出任何解释、问候或多余内容`,
        },
        { role: 'user', content: '请按人物生成规则随机生成一个新人物。' },
      ],
      maxTokens: 2048,
      temperature: 0.9,
      engine: opts.engine,
      signal,
    });
    const block = parseSimBlocks(text).blocks.find((b) => b.kind === 'character');
    if (!block || block.kind !== 'character') return { ok: false, error: 'AI 未按协议返回人物设定块，请重试' };
    return { ok: true, block };
  } catch (e) {
    if (e instanceof GenerationAborted) return { ok: false, error: '已停止' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    stopGeneration();
    useUiStore.getState().setGenerating(false);
  }
}

/** 🎨 人物形象大图 AI 生成（v2.31，替代旧写真）：两步——先驱动文本双模型按**当前状态**写生图提示词，
 *  再按预设比例调用生图 API（2K 档），客户端再精确裁切/缩放到预设像素。
 *  提示词阶段占文本生成互斥（ui.generating，结束即释放）；出图阶段与编辑室【生图】块共用 genImage（不占文本互斥）。
 *  ⚠ 返回的 url 是服务器临时文件（media GC 10 分钟后回收）——调用方必须立即 prepareCharacterImageUrl 转存浏览器本地。 */
export async function genCharacterImage(opts: {
  /** 人物库 ID：形象属库，生成结果写入人物状态后，该人物所有画布放置同步生效 */
  characterId: string;
  /** 形象针对的状态；缺省=首项状态（每个状态独立形象） */
  stateId?: string;
  engine: 'private' | 'public';
  preset: CharacterImagePreset;
  onStage?: (stage: 'prompt' | 'image') => void;
}): Promise<{ ok: boolean; url?: string; prompt?: string; error?: string }> {
  const st0 = useStudioStore.getState();
  const character = st0.characters[opts.characterId];
  if (!character) return { ok: false, error: '人物库中不存在该人物' };
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  const gate = await agentGate(opts.engine);
  if (gate) return { ok: false, error: gate };
  // 提示词阶段：占文本生成互斥（文本双模型单通道），结束即释放
  ui.setGenerating(true);
  const signal = startGeneration();
  let prompt = '';
  try {
    opts.onStage?.('prompt');
    const state = characterStateOf(character, opts.stateId);
    const age = typeof state.age === 'number' && Number.isFinite(state.age) && state.age > 0 ? `${state.age}岁` : '年龄未设定';
    const brief = [
      `人物名：${character.name || '未命名'}`,
      `性别：${GENDER_LABELS[genderOf(character.gender)]}`,
      `年龄：${age}`,
      `状态：${state.label}${character.states.length > 1 ? '（同一人物的当前状态；只按这个状态的外貌与身份作画，不要混用其它状态）' : ''}`,
      state.basicInfo.trim() ? `基础信息：${state.basicInfo.trim()}` : '',
      state.identityInfo.trim() ? `身份信息：${state.identityInfo.trim()}` : '',
      state.relations?.trim() ? `关系：${state.relations.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const dims = CHARACTER_IMAGE_PRESET_DIMS[opts.preset];
    const framing: Record<CharacterImagePreset, string> = {
      '1:1': '方形 1:1：半身立绘，头部完整并略留顶部空间',
      '4:3': '横向 4:3：半身人物为主，背景可带简约环境',
      '16:9': '宽幅 16:9：人物置身场景中，主体清晰，完整保留头部',
      '9:16': '竖幅 9:16：全身站姿，头顶留白、脚下完整',
    };
    prompt = (
      await qwGenerate({
        messages: [
          {
            role: 'system',
            content: `你是生图提示词写手：根据【人物设定】写一段中文生图提示词，用于生成该人物的单张完整人物形象图。
【人物设定】
${brief}
【画面规格】
- ${framing[opts.preset]}（目标成图 ${dims.w}×${dims.h}）
- 画面中只有一个主体人物，头部完整、五官清晰；不要多人、文字、边框、水印、分屏或拼图
【要求】
- 一段话 60~150 字：外貌与年龄感、发型发色、服饰（贴合人物设定的时代背景）、神态气质、姿态动作、背景环境与光线
- 只描述画面本身，不要出现人名，不要解释，不要输出提示词以外的任何内容`,
          },
          { role: 'user', content: '请输出这个人物的生图提示词。' },
        ],
        maxTokens: 512,
        temperature: 0.8,
        engine: opts.engine,
        signal,
      })
    ).trim();
  } catch (e) {
    if (e instanceof GenerationAborted) return { ok: false, error: '已停止' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    stopGeneration();
    useUiStore.getState().setGenerating(false);
  }
  if (!prompt) return { ok: false, error: 'AI 未返回提示词，请重试' };
  // 出图阶段：不占文本互斥（与【生图】块一致），期间可继续大纲/正文/聊天生成；
  // 私有轨只接受比例与档位，统一请求 2K，再由客户端裁切到预设精确像素。
  opts.onStage?.('image');
  const r = await genImage({ prompt, size: opts.preset, imageSize: '2K' });
  return r.ok && r.urls?.length ? { ok: true, url: r.urls[0], prompt } : { ok: false, error: r.error || '生成失败', prompt };
}

// ── 📋 章节大纲生成（大纲管理器：章节大纲规则+画布舞台+前情 → 单章大纲，流式） ──

/** 大纲设计 system：章节大纲规则 + 全文目标 + 本章所属卷 + 画布舞台 + 前情大纲（取前 3 章、各截 500 字控预算）。
 *  ⚠ 只带【章节大纲规则】不带【全文规则】（v2.14c 用户拍板：大纲生成不夹杂全文规则，全文规则只管正文）；
 *  【全文目标】是整部小说的统一方向（v2.16）；【本章所属卷】卷介绍控制整卷各章方向（v2.17 用户拍板：防止卷内各章偏离/彼此割裂）。 */
/** 章节 volumeId → 画布 id：未分卷/卷已删除走默认主画布；卷存在则用其固定画布。 */
function chapterBoardId(volumeId: string | undefined): string {
  const st = useStudioStore.getState();
  return chapterBoardOf(volumeId, st.volumes, st.boards);
}

export interface ChapterStageResult {
  mode: StageMode;
  warnings: string[];
  /** 本次生成是否刚自动采集了快照 */
  capturedNow: boolean;
}

/** R4：本章生成舞台上下文。有区域时先按画布自动同步本章场景（名单/位置/状态），
 *  再只注入名单；无区域但有旧快照 → 用旧快照；无快照 → 回退工作画布并警告。 */
function chapterStageFor(opts: {
  chapterId?: string;
  volumeId?: string;
}): { stage: ChapterStageContext; capturedNow: boolean; chapter?: SimChapter } {
  const st = useStudioStore.getState();
  const chapter = opts.chapterId ? st.chapters.find((c) => c.id === opts.chapterId) : undefined;
  const volumeId = chapter?.volumeId ?? opts.volumeId;
  const boardId = chapterBoardId(volumeId);
  let snapshot = chapter?.snapshot;
  let capturedNow = false;
  if (chapter) {
    const board = st.boards[boardId];
    const hasRegion = !!board?.regions.some((r) => r.chapterId === chapter.id);
    if (hasRegion) {
      const r = useStudioStore.getState().syncChapterScene(chapter.id);
      if (r.ok && r.snapshot) {
        snapshot = r.snapshot;
        capturedNow = r.created;
      }
    }
  }
  if (snapshot) {
    const boards = useStudioStore.getState().boards;
    const sourceBoard = boards[snapshot.boardId];
    const stage = buildChapterStageBlock(snapshot, boards, st.characters, {
      ...(sourceBoard ? { sourceLabel: boardLabel(sourceBoard, st.volumes) } : {}),
    });
    return { stage, capturedNow, ...(chapter ? { chapter } : {}) };
  }
  const board = st.boards[boardId];
  const stage = buildLegacyStageBlock(
    simCanvasSummary({ boardId }),
    board ? boardLabel(board, st.volumes) : '画布不存在',
  );
  return { stage, capturedNow, ...(chapter ? { chapter } : {}) };
}

function buildChapterSystem(
  graphName: string,
  prev: SimChapter[],
  stage: ChapterStageContext,
  volume?: SimVolume,
): string {
  const st = useStudioStore.getState();
  const outline = st.outlineRules.trim();
  const prevBlock = prev.length
    ? `\n【前情大纲】（已确定的章节大纲，保持剧情连贯）\n${prev
        .map((c, i) => `《${c.title}》：${c.outline.trim().slice(0, 500) || '（无大纲，仅有需求：' + c.requirement.trim().slice(0, 120) + '）'}`)
        .join('\n')}\n`
    : '';
  const rulesBlock = outline
    ? `【章节大纲规则】（大纲的结构与写法必须严格遵守）\n${outline}`
    : `【章节大纲规则】（未设置，采用默认结构，必须严格按此分段输出）\n${DEFAULT_OUTLINE_RULES}\n${DEFAULT_OUTLINE_OUTPUT_NOTE}`;
  const volBlock = volume
    ? `\n【本章所属卷（整卷背景）】《${volume.title || '未命名卷'}》：${volume.intro.trim() || '（卷介绍未填写）'}\n（卷通常跨多章，这里只是整卷的背景方向；本章只写本章承担的那一段，卷内其他章的情节不写入本章）\n`
    : '';
  return `你是小说《${graphName || '未命名'}》的章节大纲设计师：根据章节大纲规则、全文目标、本章所属卷的介绍（如有）、本章舞台设定与本章需求，产出一个章节的章节大纲（供后续按章生成正文使用）。
${rulesBlock}${mainGoalBlock()}${volBlock}
${stage.block}${prevBlock}
【输出要求】
- 直接输出大纲正文，不要寒暄和解释
- 结构遵循【章节大纲规则】的段落与顺序，不增删标题；可用「- 」列条目、**加粗**关键信息
- 事件与人物行为必须符合本章舞台设定（有快照名单时，严格按名单的在场/仅提及规则）
- 大纲只写【本章需求】所指的本章内容：不把卷介绍或全文目标里的整体进程展开成本章事件，不预支后续章节的情节；需求未写到的部分，只做本章内的自然过渡
- 【前情大纲】中已写过的事件不得在本章重复${volume ? '\n- 【本章所属卷】只作背景，用来保持方向一致，不是本章的内容清单' : ''}`;
}

/** 大纲管理器单章生成：agentGate 预检 → 全局生成互斥 → 流式 onDelta（组件节流写 store）。
 *  中止返回 ok:false（部分文本已随流写入，保留）；输入超预算做预截断（需求 2000/前情 3×500）。 */
export async function genChapterOutline(opts: {
  /** 章节 id（R4）：生成前从 store 读取最新章节/快照，不依赖调用方传入的旧副本 */
  chapterId?: string;
  chapter: { title: string; requirement: string; volumeId?: string };
  prevChapters: SimChapter[];
  engine: 'private' | 'public';
  /** 推理强度（off=直接答；越高补全预算越大） */
  reasoningEffort?: ReasoningEffort;
  /** 🏛 章节大纲责任编辑（注入其职责与记忆，v2.19d） */
  responsible?: ResponsibleEditor;
  onDelta?: (acc: string) => void;
  /** 推理耗尽后自动关闭推理重试时回调（UI 提示本次结果来自降级重试） */
  onFallback?: (reason: string) => void;
}): Promise<{ ok: boolean; error?: string; outline?: string; stage?: ChapterStageResult }> {
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  const gate = await agentGate(opts.engine);
  if (gate) return { ok: false, error: gate };
  const st = useStudioStore.getState();
  const { graphName } = st;
  const latest = opts.chapterId ? st.chapters.find((c) => c.id === opts.chapterId) : undefined;
  const chapter = latest ?? opts.chapter;
  const req = chapter.requirement.trim().slice(0, 2000);
  // 📚 本章所属卷（v2.17）：卷 id 有效才注入卷介绍（统一整卷方向）
  const volume = chapter.volumeId ? st.volumes.find((v) => v.id === chapter.volumeId) : undefined;
  const { stage, capturedNow } = chapterStageFor({
    ...(opts.chapterId ? { chapterId: opts.chapterId } : {}),
    ...(chapter.volumeId ? { volumeId: chapter.volumeId } : {}),
  });
  const msgs: QwenChatMessage[] = [
    {
      role: 'system',
      content:
        buildChapterSystem(graphName, opts.prevChapters.slice(-3), stage, volume) +
        responsibleBlock(opts.responsible, '章节大纲规则'),
    },
    {
      role: 'user',
      content: [
        `【本章需求】（本章的唯一章节专属依据，只写这一章）\n${req || '（未填写具体需求：按章节大纲规则与前情自然推进本章）'}`,
        `请生成《${chapter.title || '本章'}》的章节大纲。`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
  ui.setGenerating(true);
  const signal = startGeneration();
  try {
    const text = await qwGenerate({
      messages: msgs,
      maxTokens: REASONING_EFFORT_MAX_TOKENS[opts.reasoningEffort ?? 'off'],
      temperature: 0.8,
      reasoningEffort: opts.reasoningEffort,
      engine: opts.engine,
      signal,
      onDelta: opts.onDelta,
      onFallback: opts.onFallback,
    });
    return {
      ok: true,
      outline: text.trim(),
      stage: { mode: stage.mode, warnings: stage.warnings, capturedNow },
    };
  } catch (e) {
    if (e instanceof GenerationAborted) return { ok: false, error: '已停止' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    useUiStore.getState().setGenerating(false);
  }
}

// ── 📝 正文生成（正文管理器：全文规则 + 本章大纲 + 画布舞台 + 前情正文 → 单章正文，流式；
//    硬门槛：本章必须有已生成的大纲——正文管理器的生成按钮同此条件禁用） ──

/** 正文写手各段预算（总守卫 12000 字，超限报错不静默降级） */
const CH_CONTENT_BUDGET = {
  qwen: { outline: 2200, requirement: 800, prevEach: 500, prevMax: 3 },
};

/** 文本双模型写正文的 system */
function buildContentSystem(graphName: string, stage: ChapterStageContext, skillsBlock = ''): string {
  const st = useStudioStore.getState();
  const full = st.rules.trim();
  const rulesBlock = full
    ? `\n【全文规则】（硬约束：正文的世界设定、人物行为与文风写法必须符合这些约束，不得违背）\n${full}\n`
    : '';
  return `你是小说《${graphName || '未命名'}》的正文写手：根据本章大纲把剧情展开成小说正文。
${rulesBlock}${mainGoalBlock()}
${stage.block}
${skillsBlock ? `${skillsBlock}\n` : ''}【输出要求】
- 直接输出正文本身：不要输出章节名、标题、序号、解释或任何元话语，不要用 Markdown 标记
- 严格按本章大纲的事件顺序完整展开，写足场景、对话与细节；直接从场景写起
- 剧情走向遵循大纲，不得自行改写关键事件与结局；人物言行符合本章舞台设定（有快照名单时严格按在场/仅提及规则）`;
}

/** 正文管理器单章生成：大纲硬门槛 → 互斥/预检（Qwen 才预检）→ 预算守卫（超限报错）→ 按引擎流式 onDelta。
 *  前情 = 前几章已生成正文的结尾（缺正文退回其大纲要点），保剧情衔接。中止返回 ok:false（部分文本已随流写入，保留）。 */
export async function genChapterContent(opts: {
  /** 章节 id（R4）：生成前从 store 读取最新章节/快照 */
  chapterId?: string;
  chapter: { title: string; requirement: string; outline: string; volumeId?: string };
  prevChapters: SimChapter[];
  engine: 'private' | 'public';
  /** 🏛 正文生成责编（注入其职责与记忆） */
  responsible?: ResponsibleEditor;
  /** ✨ 本章启用的写作技能（已按技能库解析；仅正文 system 使用，最多 3 个） */
  writingSkills?: WritingSkill[];
  onDelta?: (acc: string) => void;
}): Promise<{ ok: boolean; error?: string; content?: string; stage?: ChapterStageResult }> {
  const st0 = useStudioStore.getState();
  const latest = opts.chapterId ? st0.chapters.find((c) => c.id === opts.chapterId) : undefined;
  const chapter = latest ?? opts.chapter;
  if (!chapter.outline.trim()) return { ok: false, error: '本章还没有大纲：请先在「📋 大纲」中生成本章大纲' };
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  if (opts.engine === 'private') {
    const gate = await agentGate('private');
    if (gate) return { ok: false, error: gate };
  } // fallback（备用中转常在线）不预检
  const { graphName } = useStudioStore.getState();
  // 画布取本章所属卷，而不是用户当前打开的标签——切章生成也能读到正确舞台
  const { stage, capturedNow } = chapterStageFor({
    ...(opts.chapterId ? { chapterId: opts.chapterId } : {}),
    ...(chapter.volumeId ? { volumeId: chapter.volumeId } : {}),
  });
  const b = CH_CONTENT_BUDGET.qwen;
  // 前情：前几章——有正文取结尾，无正文退回大纲要点
  const prevBlock = opts.prevChapters
    .slice(-b.prevMax)
    .map((c) => {
      const con = c.content.trim();
      const body = con ? `……${con.slice(-b.prevEach)}` : `（未生成正文，大纲要点：${c.outline.trim().slice(0, 200)}）`;
      return `《${c.title || '未命名'}》${body}`;
    })
    .join('\n');
  const sections = [
    `【本章大纲】（本章剧情依据，严格按此展开）\n${chapter.outline.trim().slice(0, b.outline)}`,
    chapter.requirement.trim() ? `【本章需求补充】\n${chapter.requirement.trim().slice(0, b.requirement)}` : '',
    prevBlock ? `【前情】（已写章节的衔接，保持剧情连贯）\n${prevBlock}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  if (sections.length > QWEN_SAFE_LIMIT) {
    return { ok: false, error: `提示词 ${sections.length} 字超出写手模型上限 ${QWEN_SAFE_LIMIT}，请精简全文规则或本章大纲` };
  }
  ui.setGenerating(true);
  const signal = startGeneration();
  try {
    const text = await qwGenerate({
      messages: [
        {
          role: 'system',
          content:
            buildContentSystem(graphName, stage, buildWritingSkillsBlock(opts.writingSkills ?? [])) +
            responsibleBlock(opts.responsible, '正文生成'),
        },
        { role: 'user', content: sections },
      ],
      maxTokens: 8192,
      temperature: 0.8,
      engine: opts.engine,
      signal,
      onDelta: opts.onDelta,
    });
    return {
      ok: true,
      content: text.trim(),
      stage: { mode: stage.mode, warnings: stage.warnings, capturedNow },
    };
  } catch (e) {
    if (e instanceof GenerationAborted) return { ok: false, error: '已停止' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    stopGeneration();
    useUiStore.getState().setGenerating(false);
  }
}
