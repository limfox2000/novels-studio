/** 🏷 统一标签内核 · 内置定义底稿（设计文档 §19）。
 *
 *  两种载体：**实体**（人物/环境）与**关系**（人物↔人物）；五种角色：trait / need / emotion / affordance / narrative。
 *  属性、衣着、物品、情绪不再各自成为概念——引擎固定理解六种原语（移动/需求/情绪/交互/感知/反应），标签只能映射到它们：
 *  - trait：`revokes` 撤销能力（残疾 = revoke move:walk）、`grantsMove` 授予移动模式（御剑 = fly）、
 *           `visibility` 决定可感知性（西装 always / 手枪 concealed）、`reaction` 决定被观察到时的反应；
 *  - emotion：0-100 + 每拍衰减；只影响决策权重，不参与判定；
 *  - affordance：环境标签 → 「目标 + 需求 + 耗时 + 缓解量」（冰箱=提供食物，床=可睡）；
 *  - narrative：只进叙述/事件，不进决策（脏乱）；
 *  - need：**沿用 SimProfile.desires**（§19.3「不另起系统」），标签表只引用需求 id。
 *
 *  契约（§19.5）：未知定义一律拒绝（sanitize 过滤）；每个可感知标签必须有消费者（reaction/affordance/narrative）；
 *  revoke 优先；题材只加数据，引擎源码不得出现题材分支。定义库（作品内联/可导出）是后续切片，
 *  本文件先以内置底稿提供 L0/L1 的演示集。 */
import type { SimRelation, SimTagInstance } from '../types/sim';

export type SimTagScope = 'character' | 'env' | 'relation';
export type SimTagRole = 'trait' | 'need' | 'emotion' | 'affordance' | 'narrative';
export type SimTagVisibility = 'always' | 'near' | 'concealed';

/** 反应规则（原语 6）：观察到该标签 + 条件 → 情绪Δ + 行为偏置。文案里的 {target} 替换为被观察者。 */
export interface SimReactionRule {
  /** 观察者自身必须携带的标签（如「喜欢穿西装的人」才对接吻西装起反应） */
  selfTag?: string;
  emotion?: string;
  delta?: number;
  behavior?: 'approach' | 'avoid';
  /** 事件日志文案 */
  text: string;
}

export interface SimTagDef {
  id: string;
  name: string;
  icon: string;
  scope: SimTagScope;
  role: SimTagRole;
  desc: string;
  /** 可感知性（感知原语）：always=一眼看到；near=进入感知范围；concealed=靠近或张望才发现 */
  visibility?: SimTagVisibility;
  /** 撤销的能力 id（撤销显式：残疾写 revokes:['move:walk']，不能靠「没写移动标签」表达） */
  revokes?: string[];
  /** 授予的移动模式（能力是许可，不是数值对抗） */
  grantsMove?: { mode: 'fly'; speedMultiplier: number };
  /** 被观察到时的反应 */
  reaction?: SimReactionRule;
  /** 环境交互：满足哪项需求、耗时（拍）、缓解量 */
  affordance?: { needId: string; relief: number; duration: number };
  /** 情绪每拍衰减量 */
  decay?: number;
  /** 情绪初值（0-100） */
  defaultEmotion?: number;
  /** 环境叙事标签被首次注意时的事件文案（{env} 替换为环境名） */
  discoverText?: string;
}

// ── 需求 id（定义在 simProfiles.ts，这里只引用，避免循环依赖） ──

export const NEED_HUNGER = 'builtin:hunger';
export const NEED_FATIGUE = 'builtin:fatigue';

// ── 人物 trait 标签 ──

export const TAG_SUIT = 'trait:suit';
export const TAG_GUN = 'trait:gun';
export const TAG_LIKES_SUIT = 'trait:likes_suit';
export const TAG_DISABLED = 'trait:disabled';
export const TAG_FLY = 'trait:fly';

// ── 情绪标签 ──

export const EMOTION_FEAR = 'emotion:fear';
export const EMOTION_JOY = 'emotion:joy';

// ── 环境标签 ──

export const ENV_FOOD = 'env:food';
export const ENV_SLEEP = 'env:sleep';
export const ENV_DIRTY = 'env:dirty';

// ── 关系标签 ──

export const REL_FRIEND = 'rel:friend';
export const REL_ENEMY = 'rel:enemy';
export const REL_LIKE = 'rel:like';

export const SIM_TAG_DEFS: SimTagDef[] = [
  // 人物 · trait
  {
    id: TAG_SUIT,
    name: '穿着西装',
    icon: '👔',
    scope: 'character',
    role: 'trait',
    desc: '衣着标签（无装备槽）：总是可见；喜欢西装的人看到会心情变好并想靠近。',
    visibility: 'always',
    reaction: {
      selfTag: TAG_LIKES_SUIT,
      emotion: EMOTION_JOY,
      delta: 45,
      behavior: 'approach',
      text: '看到「{target}」穿着西装，心情好起来，想靠近些',
    },
  },
  {
    id: TAG_GUN,
    name: '随身手枪',
    icon: '🔫',
    scope: 'character',
    role: 'trait',
    desc: '隐藏物品（concealed）：靠近或张望才发现；发现者会恐惧并想远离。',
    visibility: 'concealed',
    reaction: {
      emotion: EMOTION_FEAR,
      delta: 80,
      behavior: 'avoid',
      text: '发现「{target}」随身带着手枪，心里一紧',
    },
  },
  {
    id: TAG_LIKES_SUIT,
    name: '喜欢穿西装的人',
    icon: '💗',
    scope: 'character',
    role: 'trait',
    desc: '私人偏好（concealed，别人发现不了）：看到西装标签时触发喜悦 + 靠近。',
    visibility: 'concealed',
  },
  {
    id: TAG_DISABLED,
    name: '身体残疾',
    icon: '♿',
    scope: 'character',
    role: 'trait',
    desc: '撤销 move:walk（撤销显式）：无法走动，但可以在原地张望/休息/进食。',
    visibility: 'always',
    revokes: ['move:walk'],
  },
  {
    id: TAG_FLY,
    name: '御剑飞行',
    icon: '🗡',
    scope: 'character',
    role: 'trait',
    desc: '授予 move:fly：以 1.6 倍速度移动（通道寻路接入后飞行可无视门/路径）。',
    visibility: 'always',
    grantsMove: { mode: 'fly', speedMultiplier: 1.6 },
  },

  // 人物 · emotion
  {
    id: EMOTION_FEAR,
    name: '恐惧',
    icon: '😨',
    scope: 'character',
    role: 'emotion',
    desc: '被危险标签触发；达到 70 进入紧急层：远离恐惧来源。每拍衰减 3。',
    decay: 3,
    defaultEmotion: 0,
  },
  {
    id: EMOTION_JOY,
    name: '喜悦',
    icon: '😊',
    scope: 'character',
    role: 'emotion',
    desc: '被喜欢的标签触发；提高社交/靠近倾向。每拍衰减 2。',
    decay: 2,
    defaultEmotion: 0,
  },

  // 环境 · affordance / narrative
  {
    id: ENV_FOOD,
    name: '提供食物',
    icon: '🍚',
    scope: 'env',
    role: 'affordance',
    desc: '冰箱/饭桌等：饥饿达到阈值时来这里进食（2 拍，饥饿 −65）。',
    affordance: { needId: NEED_HUNGER, relief: 65, duration: 2 },
  },
  {
    id: ENV_SLEEP,
    name: '可以睡觉',
    icon: '🛏',
    scope: 'env',
    role: 'affordance',
    desc: '床/沙发等：疲劳达到阈值时在这里休息（4 拍，疲劳 −80，比就地休息多 −25）。',
    affordance: { needId: NEED_FATIGUE, relief: 80, duration: 4 },
  },
  {
    id: ENV_DIRTY,
    name: '脏乱',
    icon: '🗑',
    scope: 'env',
    role: 'narrative',
    desc: '只进事件叙述，不进决策：人物进入/注意到时产生一句描写。',
    discoverText: '进入「{env}」，注意到这儿又脏又乱',
  },

  // 关系
  { id: REL_FRIEND, name: '友善', icon: '🤝', scope: 'relation', role: 'trait', desc: '同场时会主动靠近并交谈。' },
  { id: REL_ENEMY, name: '敌对', icon: '⚔', scope: 'relation', role: 'trait', desc: '同场时会绕开对方。' },
  { id: REL_LIKE, name: '爱慕', icon: '❤', scope: 'relation', role: 'trait', desc: '同场时会主动靠近并交谈（与友善同一社交路径）。' },
];

export function tagDefOf(id: string | undefined): SimTagDef | undefined {
  if (!id) return undefined;
  return SIM_TAG_DEFS.find((d) => d.id === id);
}

/** 人物档案可携带的标签定义（trait + emotion；need 走 desires，不进 tags） */
export const SIM_CHARACTER_TAGS = SIM_TAG_DEFS.filter((d) => d.scope === 'character');
/** 人物 trait 标签（面板勾选项 = 「有哪些属性/物品」） */
export const SIM_CHARACTER_TRAITS = SIM_CHARACTER_TAGS.filter((d) => d.role === 'trait');
/** 环境标签（面板勾选项） */
export const SIM_ENV_TAGS = SIM_TAG_DEFS.filter((d) => d.scope === 'env');
/** 关系标签（每条关系取一个） */
export const SIM_RELATION_TAGS = SIM_TAG_DEFS.filter((d) => d.scope === 'relation');

/** C4 预算：每实体核心标签上限 / 每条关系标签上限 */
export const SIM_PROFILE_TAG_CAP = 8;
export const SIM_ENV_TAG_CAP = 4;
export const SIM_RELATION_TAG_CAP = 1;

const clamp100 = (v: unknown, fallback: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(100, Math.max(0, v));
};

/** 人物标签校验：只保留已定义、scope=character、role≠need 的实例；去重并限 8 条（C4）。
 *  未知标签一律拒绝（C2 准入）。 */
export function sanitizeProfileTags(raw: unknown): SimTagInstance[] {
  if (!Array.isArray(raw)) return [];
  const out: SimTagInstance[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const defId =
      typeof item === 'string' ? item : item && typeof item === 'object' ? (item as Record<string, unknown>).defId : '';
    if (typeof defId !== 'string') continue;
    const def = tagDefOf(defId);
    if (!def || def.scope !== 'character' || def.role === 'need' || seen.has(defId)) continue;
    seen.add(defId);
    const rawValue =
      typeof item === 'object' && item && 'value' in item ? (item as Record<string, unknown>).value : undefined;
    const value = rawValue === undefined ? undefined : clamp100(rawValue, def.defaultEmotion ?? 0);
    out.push(value === undefined ? { defId } : { defId, value });
    if (out.length >= SIM_PROFILE_TAG_CAP) break;
  }
  return out;
}

/** 环境标签校验：只保留已定义、scope=env 的 id；去重并限 4 条（C4） */
export function sanitizeEnvTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const def = tagDefOf(item);
    if (!def || def.scope !== 'env' || out.includes(item)) continue;
    out.push(item);
    if (out.length >= SIM_ENV_TAG_CAP) break;
  }
  return out;
}

/** 关系标签校验：只保留 scope=relation 的定义，限 1 条（每条关系一个） */
export function sanitizeRelationTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const def = tagDefOf(item);
    if (!def || def.scope !== 'relation' || out.includes(item)) continue;
    out.push(item);
    if (out.length >= SIM_RELATION_TAG_CAP) break;
  }
  return out;
}

/** 🔗 关系表校验（作品级）：未知人物/自环/重复/无标签一律丢弃；同一对规范为 a<b；
 *  按 (a,b) 排序保证标签顺序无关的确定性（C5）。 */
export function sanitizeRelations(
  raw: unknown,
  characters: Record<string, { id: string }>,
): SimRelation[] {
  if (!Array.isArray(raw)) return [];
  const out: SimRelation[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const a = typeof r.a === 'string' ? r.a : '';
    const b = typeof r.b === 'string' ? r.b : '';
    if (!a || !b || a === b || !characters[a] || !characters[b]) continue;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x}\u0000${y}`;
    if (seen.has(key)) continue;
    const tags = sanitizeRelationTags(r.tags);
    if (!tags.length) continue;
    seen.add(key);
    const value = typeof r.value === 'number' && Number.isFinite(r.value) ? Math.min(100, Math.max(0, r.value)) : undefined;
    out.push({ a: x, b: y, tags, ...(value !== undefined ? { value } : {}) });
  }
  out.sort((p, q) => (p.a === q.a ? (p.b < q.b ? -1 : p.b > q.b ? 1 : 0) : p.a < q.a ? -1 : 1));
  return out;
}

/** 查两人关系标签（一次线性查找；关系表是作品级稀疏图，规模远小于人物数） */
export function relationTagOf(relations: SimRelation[], aId: string, bId: string): string | undefined {
  for (const r of relations) {
    if ((r.a === aId && r.b === bId) || (r.a === bId && r.b === aId)) return r.tags[0];
  }
  return undefined;
}

/** 人物标签 → trait id 列表（引擎感知/移动用） */
export function traitIdsOf(tags: SimTagInstance[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const def = tagDefOf(t.defId);
    if (def?.role === 'trait') out.push(t.defId);
  }
  return out.sort();
}

/** 人物标签 → 情绪初值（只取 emotion 角色；缺省 0） */
export function emotionInitialsOf(tags: SimTagInstance[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of SIM_CHARACTER_TAGS) {
    if (def.role !== 'emotion') continue;
    const inst = tags?.find((t) => t.defId === def.id);
    out[def.id] = inst?.value ?? def.defaultEmotion ?? 0;
  }
  return out;
}
