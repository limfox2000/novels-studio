/** 创作台引擎——🎭 编辑室聊天（🏠 私有模型=设计/推演，双引擎分工；流式走 /api/qwen/chat，
 *  private=自建/租用 GPU 动作前 agentGate 预检、public=SaaS 中转常在线，gate/安全上限复用 agentShared 实现）。
 *  回复内嵌【人物设定】/【环境设定】/【区域规划】结构块 → parseSimBlocks 拆块 → 面板「📎 落为…」落到画布。
 *  📋 章节大纲生成 genChapterOutline（章节大纲规则+全文目标+本章所属卷介绍+画布舞台+前情大纲；v2.14c 起不带全文规则）；
 *  📝 正文生成 genChapterContent（大纲硬门槛，🏠 私有模型 / 🌐 公共模型 二选一，双引擎分工）。
 *  🎯 全文目标 mainGoal（v2.16）：大纲/正文/随机人物默认注入统一方向；🎭 编辑室 v2.19 起默认不注入任何规则/目标
 *  （创意环境不被默认约束），⚙「📜 附带规则与目标」开启后才以【项目资料（按需参考）】提供四类规则/目标；
 *  📚 卷（v2.17）：章节分卷+卷介绍——大纲生成注入本章所属卷介绍，控制整卷各章方向（替代已下线的长期目标节点方案）。 */
import { useStudioStore, ENV_MIN_W, ENV_MIN_H } from '../stores/studioStore';
import { useEditorRoomStore } from '../stores/editorRoomStore';
import { useUiStore } from '../stores/uiStore';
import { GenerationAborted } from '../shared/generation';
import { qwGenerate, REASONING_EFFORT_MAX_TOKENS, type QwenChatMessage, type QwenUsage, type ReasoningEffort } from '../shared/qwenClient';
import { startGeneration, stopGeneration } from '../shared/generation';
import { agentGate, promptCharBudget, QWEN_SAFE_LIMIT } from '../shared/agentShared';
import { ENV_TYPE_LABELS, ENV_TYPE_META, GENDER_LABELS, genderOf, type CharacterGender, type EnvironmentType, type SimChapter, type SimNodeType, type SimVolume } from '../types/sim';
import { imgSubmit, imgTask, imgConfigCached } from '../services/imgApi';

// ── 画布结构摘要（注入编辑室系统上下文）：地图名 + 环境层级链 + 人物（≤900 字符） ──

export function simCanvasSummary(opts: { full?: boolean } = {}): string {
  const cut = (s: string, n: number) => (opts.full ? s : s.slice(0, n));
  const { nodes, graphName } = useStudioStore.getState();
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
  const lines: string[] = [`地图名：${graphName || '未命名'}`];
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
      const at = p && p.data.kind === 'environment' ? `，在${ENV_TYPE_LABELS[p.data.etype]}「${p.data.name || '未命名'}」内` : '';
      // 年龄/关系信息（v2.20）：年龄是基础属性随手带上；关系信息让 AI 知道人物之间的关系
      const age = typeof d.age === 'number' && Number.isFinite(d.age) && d.age > 0 ? `/${d.age}岁` : '';
      // v2.27 人物设定两层：基础信息（样子/性情）+ 身份信息（世界位置与故事钩子）
      const basicAll = (d.basicInfo || '').trim();
      const identAll = (d.identityInfo || '').trim();
      const first = opts.full
        ? [basicAll, identAll].filter(Boolean).join('；')
        : basicAll.split('\n')[0] || identAll.split('\n')[0] || '';
      const relAll = (d.relations || '').trim();
      const rel = opts.full ? relAll : relAll.split('\n')[0] || '';
      lines.push(`🧑 ${d.name || '未命名'}（${GENDER_LABELS[genderOf(d.gender)]}${age}${at}）：${cut(first, 24) || '（无基础/身份信息）'}${rel ? `｜关系：${cut(rel, 32)}` : ''}`);
    }
  }
  return lines.join('\n').slice(0, opts.full ? READ_CAP : 900);
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
- 画布：环境（城镇＞建筑＞房间等嵌套）与人物构成故事舞台；编辑室产出的设定落到画布后，才进入后续创作流程
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

/** 编辑室回复里的结构块（设定块 | 规划块 | 卷块 | 生图块），kind 判别 */
export type SimBlock = EditorRoomBlock | SimPlanBlock | SimVolumeBlock | SimImageBlock;

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

/** 段名 → 块头（【人物设定】/【环境设定】/【区域规划】/【卷设定】/【生图】） */
const SIM_HEAD_RE = /【(人物设定|环境设定|区域规划|卷设定|生图)】/;

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

/** 解析编辑室输出 → 对话正文 + 结构块（设定块/规划块可多块连续输出；零宽字符/**加粗**容错） */
export function parseSimBlocks(text: string): { chat: string; blocks: SimBlock[] } {
  const clean = text.replace(/\*\*/g, '').replace(/[​‌‍﻿]/g, '').trim();
  const first = SIM_HEAD_RE.exec(clean);
  if (!first) return { chat: clean, blocks: [] };
  const chat = clean.slice(0, first.index).trim();
  const blocks: SimBlock[] = [];
  let skippedNoAge = 0;
  const re = /【(人物设定|环境设定|区域规划|卷设定|生图)】[^\n]*\n?([\s\S]*?)(?=\n【(?:人物设定|环境设定|区域规划|卷设定|生图|更新职责|更新记忆[^】]*)】|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const head = m[1];
    const body = m[2].trim();
    if (!body) continue;
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
    const name =
      fieldLine(body, kind === 'character' ? ['名字', '人名', '名称'] : ['名字', '环境名', '名称']).slice(0, kind === 'character' ? 12 : 16) ||
      '未命名';
    if (kind === 'character') {
      // 性别基础属性：AI 按协议输出「性别：男/女」，非女一律归默认男
      const gRaw = fieldLine(body, ['性别']);
      // 年龄是必填基础属性：取首个数字串（容错「32岁/约 32」）；缺失或非正数则丢弃该块，无年龄人物不得落到画布
      const aNum = fieldLine(body, ['年龄']).match(/\d+/);
      const age = aNum ? parseInt(aNum[0], 10) : 0;
      if (age <= 0) {
        skippedNoAge++;
        continue;
      }
      // 基础信息/身份信息（v2.27）为人物设定主体；关系信息（v2.20）可省略
      const { basicInfo, identityInfo, relations } = parseCharBody(body);
      blocks.push({
        kind,
        label: '人物',
        name,
        gender: /女/.test(gRaw) ? 'female' : 'male',
        age: Math.min(999, age),
        basicInfo,
        identityInfo,
        relations: relations || undefined,
      });
    } else {
      const rawType = fieldLine(body, ['类型']);
      const hit = (Object.entries(ENV_TYPE_LABELS) as Array<[EnvironmentType, string]>).find(([, label]) => rawType.includes(label));
      blocks.push({ kind, label: '环境', name, desc: fieldRest(body, ['描述', '详细信息', '设定']), etype: hit?.[0] ?? 'building' });
    }
  }
  const lead = chat || (blocks.length ? '已按模板整理出设定块，点下方按钮落地。' : skippedNoAge ? '' : clean);
  const note = skippedNoAge ? `⚠ ${skippedNoAge} 个人物设定缺少有效年龄，已忽略，请让编辑室重新生成。` : '';
  return { chat: [lead, note].filter(Boolean).join('\n\n'), blocks };
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
const WRITE_HEAD_RE = /【写入】([\s\S]*?)(?=\n【(?:人物设定|环境设定|区域规划|卷设定|生图|写入|更新职责|更新记忆[^】]*)】|$)/g;

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
  人物生成: { blockKinds: ['character'], writeFields: ['charGenRules'] },
  环境生成: { blockKinds: ['environment'], writeFields: [] },
  章节大纲规则: { blockKinds: [], writeFields: ['outlineRules', 'chapterOutline'] },
  章节需求: { blockKinds: [], writeFields: ['chapterRequirement'] },
  卷生成: { blockKinds: ['volume'], writeFields: [] },
  正文生成: { blockKinds: [], writeFields: [] },
};

/** 生图调用（v2.19a 复用生图画布链路；v2.24 双轨）：rail/模型取 imgconfig.json 默认轨
 *  （public=model_list 首项，private=private.model；读不到配置回落公共轨 gpt-image-2.5）。
 *  提交 /api/img/submit → 2.5s 轮询 → 完成返回落盘 URL。 */
export async function genImage(opts: {
  prompt: string;
  size?: string;
  onProgress?: (progress: number) => void;
}): Promise<{ ok: boolean; urls?: string[]; error?: string }> {
  try {
    let rail: 'public' | 'private' = 'public';
    let model = 'gpt-image-2.5';
    try {
      const c = await imgConfigCached();
      if (c.default === 'private' && c.private?.base_url && c.private?.model) {
        rail = 'private';
        model = c.private.model;
      } else {
        model = c.public?.model_list?.[0] || c.model_list?.[0] || model;
      }
    } catch {
      /* 读不到配置走内置默认（公共轨 gpt-image-2.5） */
    }
    const taskId = await imgSubmit({ model, prompt: opts.prompt, size: opts.size || '1:1', imageSize: '1K', rail });
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
  {
    re: /画布|地图|舞台|已有(人物|环境)|现有(人物|环境)/,
    build: MATERIAL_BUILDERS.canvas,
  },
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
  const parts = READ_TRIGGERS.filter((t) => t.re.test(userMsg)).map((t) => t.build());
  if (!parts.length) return '';
  return `\n【本轮读取的系统内容】（用户本轮明确提到，仅本轮参考）\n${parts.join('\n\n').slice(0, READ_CAP)}\n`;
}

// ── 🎭 编辑室单轮生成 ──

/** 编辑室对话中的一条消息（store 侧用；发上游时 agent → assistant） */
export interface SimChatMsg {
  role: 'user' | 'agent';
  text: string;
}

/** 编辑室系统消息：舞台搭建助手 + 系统说明 + 本轮读取 + 设定块/写入协议 + 画布状态 + 摘要。
 *  系统说明块始终注入（字段含义与读写规则）；模块正文默认不注入——仅本轮明确提到时附读取块（buildReadBlock），
 *  ⚙「📜 附带规则与目标」开启时才常驻【项目资料】（projectDataBlock）。 */
function buildSimSystem(summary: string, readBlock: string): string {
  const summaryBlock = summary.trim() ? `\n【早期对话摘要】（更早轮次的要点备忘，回答时遵守其中已定事项）\n${summary.trim()}\n` : '';
  return `你是创作台的「🎭 编辑室」：帮用户在画布（地图）上搭建故事舞台——设计环境（可嵌套成 镇＞建筑＞房间 的地图层级）与人物，产出可直接落到画布的设定。
${summaryBlock}${systemGuideBlock()}${readBlock}${projectDataBlock()}

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
- 章节的正文、归卷不支持写入，只能读取；画布不支持通过写入修改，需要改动时告诉用户在对应界面操作，或用设定块落画布；卷的新建用【卷设定】

【工作方式】
- 用中文自然对话；开放讨论自由发挥，创意具体、少空话
- 用户要你创建/设计人物、环境、设定时，严格按下方协议输出结构块；纯讨论/闲聊/修改建议不要输出结构块
- 一次创建多个时连续输出多个对应块；用户点回复下方的「📎 落为人物/环境」按钮落到画布（落点在某环境内会自动归入嵌套层级）
- 需要说明层级安排时，在块外用一句话建议「谁放进谁里面」（嵌套由用户在画布拖拽完成）

【人物产出协议】（段名一字不差）
【人物设定】
名字：（人名，12 字以内）
性别：（男/女 二选一）
年龄：（必填，数字年龄，如 32；人物的基础属性，不可省略）
基础信息：（长相/身材/习惯穿搭/性格，一段话——人物本身的样子与性情）
身份信息：（职业/身份/与故事相关的特殊设计，一段话——人物在世界中的位置与故事钩子）
关系信息：（此人物与其他人物之间的关系，如「李刚之父；与王明有旧怨」，一段话；用户没提到人物关系、或当前没有其他人物可关联时，省略整段）

【环境产出协议】（段名一字不差）
【环境设定】
名字：（环境名，16 字以内）
类型：（房间/建筑/社区/城镇/区域/床/物品 七选一；床=容纳人物休息睡觉的容器，如床/炕/通铺；物品=非容器的物件标记——告知此处存在一个东西，如一桌美味的饭菜/一头野兽/一堆火把）
描述：（外观/功能/氛围，一段话）

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
- 只在用户明确要图时输出本块；普通讨论/设定文字不要输出

【当前画布状态】
${simCanvasSummary()}`;
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
  const gate = await agentGate(engine);
  if (gate) return { ok: false, error: gate };
  const msgs: QwenChatMessage[] = [
    {
      role: 'system',
      content:
        buildSimSystem(opts.summary ?? '', buildReadBlock(opts.userMsg)) +
        mentorBlocks(opts.userMsg, opts.mentors),
    },
    ...opts.history.map((m) => ({ role: m.role === 'agent' ? ('assistant' as const) : ('user' as const), content: m.text })),
    { role: 'user', content: opts.userMsg },
  ];
  // 失控保险：总长超预算从最旧历史开始丢（保留 system 与本轮消息）；预算按模型 nCtx 动态预留补全空间，
  // 聊久后提示词不会挤占补全导致输出被服务端提前截断
  const maxTokens = REASONING_EFFORT_MAX_TOKENS[opts.reasoningEffort ?? 'off'];
  const budget = promptCharBudget(useEditorRoomStore.getState().meta?.nCtx ?? 0, maxTokens);
  let total = msgs.reduce((a, m) => a + m.content.length, 0);
  while (total > budget && msgs.length > 2) {
    total -= msgs[1].content.length;
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

/** 🎨 人物写真（v2.19b，属性面板写真区）：两步——先驱动文本双模型按人物设定写生图提示词，
 *  再调生图 API 出单人立绘（1:1）。提示词阶段占文本生成互斥（ui.generating，结束即释放）；
 *  出图阶段与编辑室【生图】块共用 genImage（不占文本互斥）。
 *  ⚠ 返回的 url 是服务器临时文件（media GC 10 分钟后回收）——调用方必须立即 localImgSaveFromUrl 转存浏览器本地。 */
export async function genCharacterPortrait(opts: {
  id: string;
  engine: 'private' | 'public';
  onStage?: (stage: 'prompt' | 'image') => void;
}): Promise<{ ok: boolean; url?: string; prompt?: string; error?: string }> {
  const n = useStudioStore.getState().nodes.find((x) => x.id === opts.id);
  if (!n || n.data.kind !== 'character') return { ok: false, error: '人物节点不存在' };
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
    const d = n.data;
    const age = typeof d.age === 'number' && Number.isFinite(d.age) && d.age > 0 ? `${d.age}岁` : '年龄未设定';
    const brief = [
      `人物名：${d.name || '未命名'}`,
      `性别：${GENDER_LABELS[genderOf(d.gender)]}`,
      `年龄：${age}`,
      d.basicInfo.trim() ? `基础信息：${d.basicInfo.trim()}` : '',
      d.identityInfo.trim() ? `身份信息：${d.identityInfo.trim()}` : '',
      d.relations?.trim() ? `关系：${d.relations.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    prompt = (
      await qwGenerate({
        messages: [
          {
            role: 'system',
            content: `你是生图提示词写手：根据【人物设定】写一段中文生图提示词，用于生成该人物的单人立绘。
【人物设定】
${brief}
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
  // 出图阶段：不占文本互斥（与【生图】块一致），期间可继续大纲/正文/聊天生成
  opts.onStage?.('image');
  const r = await genImage({ prompt, size: '1:1' });
  return r.ok && r.urls?.length ? { ok: true, url: r.urls[0], prompt } : { ok: false, error: r.error || '生成失败', prompt };
}

// ── 📋 章节大纲生成（大纲管理器：章节大纲规则+画布舞台+前情 → 单章大纲，流式） ──

/** 大纲设计 system：章节大纲规则 + 全文目标 + 本章所属卷 + 画布舞台 + 前情大纲（取前 3 章、各截 500 字控预算）。
 *  ⚠ 只带【章节大纲规则】不带【全文规则】（v2.14c 用户拍板：大纲生成不夹杂全文规则，全文规则只管正文）；
 *  【全文目标】是整部小说的统一方向（v2.16）；【本章所属卷】卷介绍控制整卷各章方向（v2.17 用户拍板：防止卷内各章偏离/彼此割裂）。 */
function buildChapterSystem(graphName: string, prev: SimChapter[], volume?: SimVolume): string {
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
  return `你是小说《${graphName || '未命名'}》的章节大纲设计师：根据章节大纲规则、全文目标、本章所属卷的介绍（如有）、画布上的舞台设定与本章需求，产出一个章节的章节大纲（供后续按章生成正文使用）。
${rulesBlock}${mainGoalBlock()}${volBlock}
【画布舞台】（当前地图上的环境与人物设定，供大纲取用）
${simCanvasSummary()}${prevBlock}
【输出要求】
- 直接输出大纲正文，不要寒暄和解释
- 结构遵循【章节大纲规则】的段落与顺序，不增删标题；可用「- 」列条目、**加粗**关键信息
- 事件与人物行为必须符合画布中已有的人物/环境设定
- 大纲只写【本章需求】所指的本章内容：不把卷介绍或全文目标里的整体进程展开成本章事件，不预支后续章节的情节；需求未写到的部分，只做本章内的自然过渡
- 【前情大纲】中已写过的事件不得在本章重复${volume ? '\n- 【本章所属卷】只作背景，用来保持方向一致，不是本章的内容清单' : ''}`;
}

/** 大纲管理器单章生成：agentGate 预检 → 全局生成互斥 → 流式 onDelta（组件节流写 store）。
 *  中止返回 ok:false（部分文本已随流写入，保留）；输入超预算做预截断（需求 2000/前情 3×500）。 */
export async function genChapterOutline(opts: {
  chapter: { title: string; requirement: string; volumeId?: string };
  prevChapters: SimChapter[];
  engine: 'private' | 'public';
  /** 推理强度（off=直接答；越高补全预算越大） */
  reasoningEffort?: ReasoningEffort;
  /** 🏛 章节大纲责任编辑（注入其职责与记忆，v2.19d） */
  responsible?: ResponsibleEditor;
  onDelta?: (acc: string) => void;
}): Promise<{ ok: boolean; error?: string; outline?: string }> {
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  const gate = await agentGate(opts.engine);
  if (gate) return { ok: false, error: gate };
  const st = useStudioStore.getState();
  const { graphName } = st;
  const req = opts.chapter.requirement.trim().slice(0, 2000);
  // 📚 本章所属卷（v2.17）：卷 id 有效才注入卷介绍（统一整卷方向）
  const volume = opts.chapter.volumeId ? st.volumes.find((v) => v.id === opts.chapter.volumeId) : undefined;
  const msgs: QwenChatMessage[] = [
    {
      role: 'system',
      content:
        buildChapterSystem(graphName, opts.prevChapters.slice(-3), volume) + responsibleBlock(opts.responsible, '章节大纲规则'),
    },
    {
      role: 'user',
      content: [
        `【本章需求】（本章的唯一章节专属依据，只写这一章）\n${req || '（未填写具体需求：按章节大纲规则与前情自然推进本章）'}`,
        `请生成《${opts.chapter.title || '本章'}》的章节大纲。`,
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
    });
    return { ok: true, outline: text.trim() };
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
function buildContentSystem(graphName: string): string {
  const st = useStudioStore.getState();
  const full = st.rules.trim();
  const rulesBlock = full
    ? `\n【全文规则】（硬约束：正文的世界设定、人物行为与文风写法必须符合这些约束，不得违背）\n${full}\n`
    : '';
  return `你是小说《${graphName || '未命名'}》的正文写手：根据本章大纲把剧情展开成小说正文。
${rulesBlock}${mainGoalBlock()}
【画布舞台】（当前地图上的环境与人物设定，供正文取用场景与人物细节）
${simCanvasSummary()}
【输出要求】
- 直接输出正文本身：不要输出章节名、标题、序号、解释或任何元话语，不要用 Markdown 标记
- 严格按本章大纲的事件顺序完整展开，写足场景、对话与细节；直接从场景写起
- 剧情走向遵循大纲，不得自行改写关键事件与结局；人物言行符合画布设定`;
}

/** 正文管理器单章生成：大纲硬门槛 → 互斥/预检（Qwen 才预检）→ 预算守卫（超限报错）→ 按引擎流式 onDelta。
 *  前情 = 前几章已生成正文的结尾（缺正文退回其大纲要点），保剧情衔接。中止返回 ok:false（部分文本已随流写入，保留）。 */
export async function genChapterContent(opts: {
  chapter: { title: string; requirement: string; outline: string };
  prevChapters: SimChapter[];
  engine: 'private' | 'public';
  /** 🏛 正文生成责编（注入其职责与记忆） */
  responsible?: ResponsibleEditor;
  onDelta?: (acc: string) => void;
}): Promise<{ ok: boolean; error?: string; content?: string }> {
  if (!opts.chapter.outline.trim()) return { ok: false, error: '本章还没有大纲：请先在「📋 大纲」中生成本章大纲' };
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  if (opts.engine === 'private') {
    const gate = await agentGate('private');
    if (gate) return { ok: false, error: gate };
  } // fallback（备用中转常在线）不预检
  const { graphName } = useStudioStore.getState();
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
    `【本章大纲】（本章剧情依据，严格按此展开）\n${opts.chapter.outline.trim().slice(0, b.outline)}`,
    opts.chapter.requirement.trim() ? `【本章需求补充】\n${opts.chapter.requirement.trim().slice(0, b.requirement)}` : '',
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
        { role: 'system', content: buildContentSystem(graphName) + responsibleBlock(opts.responsible, '正文生成') },
        { role: 'user', content: sections },
      ],
      maxTokens: 8192,
      temperature: 0.8,
      engine: opts.engine,
      signal,
      onDelta: opts.onDelta,
    });
    return { ok: true, content: text.trim() };
  } catch (e) {
    if (e instanceof GenerationAborted) return { ok: false, error: '已停止' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    stopGeneration();
    useUiStore.getState().setGenerating(false);
  }
}
