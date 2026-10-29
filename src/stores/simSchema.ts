/** 🏷 推演世界模型定义库（SimSchema）：作品级数据 + 校验 + 索引 + 实例清洗。
 *
 *  **内核零内容**：本文件不包含任何题材定义（没有「食物/手枪/友善」这类东西）。
 *  引擎固定理解六种原语（移动/需求/情绪/交互/感知/反应），作者在设计页定义标签、需求、
 *  情绪、affordance、反应与关系，引擎只遍历定义。新作品 schema 为空。
 *
 *  契约（设计文档 §19.5）：
 *  - C2 准入：未知/悬空定义一律拒绝（sanitize 过滤），每个可感知标签应有消费者（只警告不阻断）；
 *  - C4 预算：标签 ≤128、反应 ≤50、关系定义 ≤16、每条关系标签 ≤3、每人标签 ≤8、每环境标签 ≤4；
 *  - C5 确定性：输出一律按 id/优先级排序，引擎遍历顺序与数组原始顺序无关。
 */
import type {
  SimAffordanceParams,
  SimEmotionParams,
  SimNeedParams,
  SimReactionDef,
  SimRelation,
  SimRelationDef,
  SimSchema,
  SimStanceKind,
  SimTagDef,
  SimTagInstance,
  SimTagRole,
  SimTagScope,
  SimTimeDef,
  SimTimePhase,
} from '../types/sim';

export const SIM_TAG_CAP = 128;
export const SIM_REACTION_CAP = 50;
export const SIM_RELATION_DEF_CAP = 16;
export const SIM_PROFILE_TAG_CAP = 8;
export const SIM_ENV_TAG_CAP = 4;
export const SIM_RELATION_TAG_CAP = 3;
export const SIM_RELATION_VALUE_DEFAULT = 50;
export const SIM_TAG_ID_CAP = 64;

/** 空定义库（新作品默认；共享常量，便于脏检查识别「无变化」） */
export const EMPTY_SIM_SCHEMA: SimSchema = Object.freeze({
  tags: Object.freeze([]) as unknown as SimTagDef[],
  reactions: Object.freeze([]) as unknown as SimReactionDef[],
  relations: Object.freeze([]) as unknown as SimRelationDef[],
}) as SimSchema;

/** 缺省时间：单相「全天」——没有定义时间维度时引擎与旧行为一致 */
export const DEFAULT_SIM_TIME: SimTimeDef = {
  ticksPerDay: 120,
  phases: [{ id: 'always', name: '全天', from: 0, to: 1 }],
};

const STANCES: readonly SimStanceKind[] = ['approach', 'avoid', 'talk'];
const VISIBILITIES = ['always', 'near', 'concealed'] as const;
const ROLES: readonly SimTagRole[] = ['trait', 'need', 'emotion', 'affordance', 'narrative'];

// ── 基础工具 ──

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function text(v: unknown, cap: number): string {
  return typeof v === 'string' ? v.trim().slice(0, cap) : '';
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function int(v: unknown, min: number, max: number, fallback: number): number {
  return Math.round(num(v, min, max, fallback));
}

/** id 合法性：非空、≤64、不含空白（空白会让模板/日志/导出难读） */
export function isValidSchemaId(id: string): boolean {
  return !!id && id.length <= SIM_TAG_ID_CAP && !/\s/.test(id);
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byPriorityThenId = (a: { id: string; priority?: number }, b: { id: string; priority?: number }) =>
  (b.priority ?? 0) - (a.priority ?? 0) || byId(a, b);

// ── 子对象解析（缺省值） ──

function parseNeedParams(raw: unknown): SimNeedParams | null {
  if (!isObj(raw)) return null;
  const relieversRaw = isObj(raw.relievers) ? raw.relievers : {};
  const relievers: SimNeedParams['relievers'] = {};
  for (const k of ['novelty', 'observe', 'social'] as const) {
    if (typeof relieversRaw[k] === 'number' && Number.isFinite(relieversRaw[k])) {
      relievers[k] = num(relieversRaw[k], 0, 100, 0);
    }
  }
  return {
    initial: num(raw.initial, 0, 100, 0),
    growth: num(raw.growth, 0, 20, 0),
    threshold: num(raw.threshold, 0, 100, 50),
    emergency: num(raw.emergency, 0, 100, 100),
    ...(Object.keys(relievers).length ? { relievers } : {}),
  };
}

function parseEmotionParams(raw: unknown): SimEmotionParams | null {
  if (!isObj(raw)) return null;
  const stance = STANCES.includes(raw.stance as SimStanceKind) ? (raw.stance as SimStanceKind) : 'none';
  return {
    initial: num(raw.initial, 0, 100, 0),
    decay: num(raw.decay, 0, 20, 0),
    breakThreshold: num(raw.breakThreshold, 0, 100, 100),
    clearThreshold: num(raw.clearThreshold, 0, 100, 0),
    stance,
  };
}

function parseAffordanceParams(raw: unknown): SimAffordanceParams | null {
  if (!isObj(raw)) return null;
  const needId = text(raw.needId, SIM_TAG_ID_CAP);
  if (!needId) return null;
  const phases = Array.isArray(raw.activePhases)
    ? [...new Set(raw.activePhases.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()))]
    : [];
  return {
    needId,
    relief: num(raw.relief, 0, 100, 30),
    duration: int(raw.duration, 1, 20, 2),
    ...(typeof raw.uses === 'number' && Number.isFinite(raw.uses) ? { uses: int(raw.uses, 0, 999, 0) } : {}),
    ...(phases.length ? { activePhases: phases } : {}),
  };
}

// ── 标签定义解析 ──

interface TagParseCtx {
  errors: string[];
  warnings: string[];
}

function parseTag(raw: unknown, ctx: TagParseCtx): SimTagDef | null {
  if (!isObj(raw)) return null;
  const id = text(raw.id, SIM_TAG_ID_CAP);
  if (!isValidSchemaId(id)) {
    ctx.errors.push(`标签 id 非法（空/含空白/超长）：${id || '(空)'}`);
    return null;
  }
  const scope = raw.scope === 'env' ? 'env' : raw.scope === 'character' ? 'character' : null;
  if (!scope) {
    ctx.errors.push(`标签「${id}」载体非法（应为 character/env）`);
    return null;
  }
  const role = ROLES.includes(raw.role as SimTagRole) ? (raw.role as SimTagRole) : null;
  if (!role) {
    ctx.errors.push(`标签「${id}」角色非法`);
    return null;
  }
  if (scope === 'character' && (role === 'affordance' || role === 'narrative')) {
    ctx.errors.push(`标签「${id}」：affordance/narrative 只能挂在环境上`);
    return null;
  }
  if (scope === 'env' && (role === 'trait' || role === 'need' || role === 'emotion')) {
    ctx.errors.push(`标签「${id}」：${role} 只能挂在人物上`);
    return null;
  }
  const def: SimTagDef = {
    id,
    name: text(raw.name, 40) || id,
    scope: scope as SimTagScope,
    role,
  };
  const icon = text(raw.icon, 8);
  if (icon) def.icon = icon;
  const desc = text(raw.desc, 300);
  if (desc) def.desc = desc;

  if (role === 'trait') {
    const visibility = VISIBILITIES.includes(raw.visibility as never) ? (raw.visibility as SimTagDef['visibility']) : 'always';
    def.visibility = visibility;
    if (Array.isArray(raw.revokes)) {
      const revokes = raw.revokes.filter((x): x is string => x === 'move:walk');
      if (revokes.length) def.revokes = revokes;
      if (revokes.length !== raw.revokes.length) ctx.warnings.push(`标签「${id}」：仅支持撤销 move:walk，其余能力已忽略`);
    }
    if (isObj(raw.grantsMove)) {
      const mode = raw.grantsMove.mode === 'fly' ? 'fly' : 'walk';
      def.grantsMove = { mode, speedMultiplier: num(raw.grantsMove.speedMultiplier, 0.2, 5, 1.6) };
    }
  } else if (role === 'need') {
    const need = parseNeedParams(raw.need);
    if (!need) {
      ctx.errors.push(`需求「${id}」缺少 need 参数`);
      return null;
    }
    def.need = need;
  } else if (role === 'emotion') {
    const emotion = parseEmotionParams(raw.emotion);
    if (!emotion) {
      ctx.errors.push(`情绪「${id}」缺少 emotion 参数`);
      return null;
    }
    def.emotion = emotion;
  } else if (role === 'affordance') {
    const affordance = parseAffordanceParams(raw.affordance);
    if (!affordance) {
      ctx.errors.push(`环境交互「${id}」缺少 affordance 参数或 needId`);
      return null;
    }
    def.affordance = affordance;
  } else if (role === 'narrative') {
    const narr = isObj(raw.narrative) ? raw.narrative : {};
    const discoverText = text(narr.discoverText, 400);
    def.narrative = discoverText ? { discoverText } : {};
  }
  return def;
}

// ── 反应规则解析 ──

function parseReaction(raw: unknown, ctx: TagParseCtx): SimReactionDef | null {
  if (!isObj(raw)) return null;
  const id = text(raw.id, SIM_TAG_ID_CAP);
  if (!isValidSchemaId(id)) {
    ctx.errors.push(`反应 id 非法：${id || '(空)'}`);
    return null;
  }
  const triggerTag = text(raw.triggerTag, SIM_TAG_ID_CAP);
  const triggerScope = raw.triggerScope === 'env' ? 'env' : 'actor';
  if (!triggerTag) {
    ctx.errors.push(`反应「${id}」缺少触发标签`);
    return null;
  }
  const def: SimReactionDef = { id, triggerScope, triggerTag };
  const selfTag = text(raw.selfTag, SIM_TAG_ID_CAP);
  if (selfTag) def.selfTag = selfTag;
  if (isObj(raw.emotion)) {
    const defId = text(raw.emotion.defId, SIM_TAG_ID_CAP);
    if (defId) def.emotion = { defId, delta: num(raw.emotion.delta, -100, 100, 0) };
  }
  if (isObj(raw.need)) {
    const defId = text(raw.need.defId, SIM_TAG_ID_CAP);
    if (defId) def.need = { defId, delta: num(raw.need.delta, -100, 100, 0) };
  }
  if (isObj(raw.stance) && STANCES.includes(raw.stance.kind as SimStanceKind)) {
    const emotionRef = text(raw.stance.emotionRef, SIM_TAG_ID_CAP);
    def.stance = { kind: raw.stance.kind as SimStanceKind, ...(emotionRef ? { emotionRef } : {}) };
  }
  const t = text(raw.text, 300);
  if (t) def.text = t;
  const cooldown = int(raw.cooldown, 0, 120, 0);
  if (cooldown) def.cooldown = cooldown;
  const priority = num(raw.priority, -100, 100, 0);
  if (priority) def.priority = priority;
  return def;
}

// ── 关系定义解析 ──

function parseRelationDef(raw: unknown, ctx: TagParseCtx): SimRelationDef | null {
  if (!isObj(raw)) return null;
  const id = text(raw.id, SIM_TAG_ID_CAP);
  if (!isValidSchemaId(id)) {
    ctx.errors.push(`关系定义 id 非法：${id || '(空)'}`);
    return null;
  }
  const stance = STANCES.includes(raw.stance as SimStanceKind) ? (raw.stance as SimStanceKind) : 'none';
  const minValue = num(raw.minValue, 0, 100, 0);
  const maxValue = num(raw.maxValue, 0, 100, 100);
  const def: SimRelationDef = {
    id,
    name: text(raw.name, 40) || id,
    stance,
    minValue: Math.min(minValue, maxValue),
    maxValue: Math.max(minValue, maxValue),
  };
  const icon = text(raw.icon, 8);
  if (icon) def.icon = icon;
  const desc = text(raw.desc, 300);
  if (desc) def.desc = desc;
  const priority = num(raw.priority, -100, 100, 0);
  if (priority) def.priority = priority;
  if (typeof raw.talkDuration === 'number') def.talkDuration = int(raw.talkDuration, 1, 20, 2);
  if (typeof raw.talkDistance === 'number') def.talkDistance = int(raw.talkDistance, 20, 2000, 110);
  return def;
}

// ── 时间解析 ──

function parseTime(raw: unknown, ctx: TagParseCtx): SimTimeDef | undefined {
  if (!isObj(raw)) return undefined;
  const ticksPerDay = int(raw.ticksPerDay, 2, 100000, 0);
  if (!ticksPerDay) {
    ctx.errors.push('时间维度：ticksPerDay 非法（2-100000）');
    return undefined;
  }
  if (!Array.isArray(raw.phases) || !raw.phases.length) return undefined;
  const phases: SimTimePhase[] = [];
  const seen = new Set<string>();
  for (const p of raw.phases) {
    if (!isObj(p)) continue;
    const id = text(p.id, SIM_TAG_ID_CAP);
    if (!isValidSchemaId(id) || seen.has(id)) {
      ctx.warnings.push(`时间相位 id 非法或重复，已丢弃：${id || '(空)'}`);
      continue;
    }
    const from = num(p.from, 0, 1, 0);
    const to = num(p.to, 0, 1, 1);
    if (!(from < to)) {
      ctx.warnings.push(`时间相位「${id}」区间非法（需 from < to），已丢弃`);
      continue;
    }
    seen.add(id);
    phases.push({ id, name: text(p.name, 20) || id, from, to });
  }
  if (!phases.length) return undefined;
  phases.sort((a, b) => a.from - b.from || (a.id < b.id ? -1 : 1));
  return { ticksPerDay, phases };
}

// ── 汇总解析 ──

export interface SimSchemaInspection {
  schema: SimSchema;
  errors: string[];
  warnings: string[];
  /** 被丢弃的定义条数（导入/载入提示用） */
  dropped: number;
}

/** 解析 + 校验（编辑器/导入/载入共用）：返回规范化 schema 与问题列表。 */
export function inspectSimSchema(raw: unknown): SimSchemaInspection {
  const ctx: TagParseCtx = { errors: [], warnings: [] };
  const src = isObj(raw) ? raw : {};
  let dropped = 0;

  // 标签：先去重（保留首条），再解析
  const rawTags = Array.isArray(src.tags) ? src.tags : [];
  const seenTagIds = new Set<string>();
  const tags: SimTagDef[] = [];
  for (const item of rawTags) {
    const def = parseTag(item, ctx);
    if (!def) {
      dropped++;
      continue;
    }
    if (seenTagIds.has(def.id)) {
      ctx.errors.push(`标签 id 重复：${def.id}（保留首条）`);
      dropped++;
      continue;
    }
    seenTagIds.add(def.id);
    tags.push(def);
    if (tags.length >= SIM_TAG_CAP) {
      ctx.warnings.push(`标签数超过预算 ${SIM_TAG_CAP}，其余已忽略`);
      break;
    }
  }
  // affordance 的 needId 引用完整性（此时 need 全集已知）
  const needs = new Map(tags.filter((t) => t.role === 'need').map((t) => [t.id, t]));
  const emotions = new Map(tags.filter((t) => t.role === 'emotion').map((t) => [t.id, t]));
  const traits = new Map(tags.filter((t) => t.role === 'trait').map((t) => [t.id, t]));
  const keptTags: SimTagDef[] = [];
  for (const def of tags) {
    if (def.affordance && !needs.has(def.affordance.needId)) {
      ctx.errors.push(`环境交互「${def.id}」引用了不存在的需求：${def.affordance.needId}`);
      dropped++;
      continue;
    }
    keptTags.push(def);
  }
  keptTags.sort(byId);

  // 反应：引用完整性
  const tagById = new Map(keptTags.map((t) => [t.id, t]));
  const rawReactions = Array.isArray(src.reactions) ? src.reactions : [];
  const seenReactionIds = new Set<string>();
  const reactions: SimReactionDef[] = [];
  for (const item of rawReactions) {
    const rule = parseReaction(item, ctx);
    if (!rule) {
      dropped++;
      continue;
    }
    if (seenReactionIds.has(rule.id)) {
      ctx.errors.push(`反应 id 重复：${rule.id}（保留首条）`);
      dropped++;
      continue;
    }
    const trigger = tagById.get(rule.triggerTag);
    if (!trigger) {
      ctx.errors.push(`反应「${rule.id}」触发标签不存在：${rule.triggerTag}`);
      dropped++;
      continue;
    }
    // 触发载体跟随标签所在载体（不走题材分支，只做一致性）
    rule.triggerScope = trigger.scope === 'env' ? 'env' : 'actor';
    if (rule.selfTag && !traits.has(rule.selfTag)) {
      ctx.errors.push(`反应「${rule.id}」selfTag 必须是人物 trait：${rule.selfTag}`);
      dropped++;
      continue;
    }
    if (rule.emotion && !emotions.has(rule.emotion.defId)) {
      ctx.errors.push(`反应「${rule.id}」引用了不存在的情绪：${rule.emotion.defId}`);
      dropped++;
      continue;
    }
    if (rule.need && !needs.has(rule.need.defId)) {
      ctx.errors.push(`反应「${rule.id}」引用了不存在的需求：${rule.need.defId}`);
      dropped++;
      continue;
    }
    if (rule.stance && rule.triggerScope === 'env') {
      // 环境标签没有「目标人物」，立场无处施加
      delete rule.stance;
      ctx.warnings.push(`反应「${rule.id}」：环境触发不支持立场，已忽略 stance`);
    }
    if (rule.stance?.emotionRef && !emotions.has(rule.stance.emotionRef)) {
      delete rule.stance;
      ctx.warnings.push(`反应「${rule.id}」：stance 的情绪门槛不存在，已忽略 stance`);
    }
    seenReactionIds.add(rule.id);
    reactions.push(rule);
    if (reactions.length >= SIM_REACTION_CAP) {
      ctx.warnings.push(`反应规则超过预算 ${SIM_REACTION_CAP}，其余已忽略`);
      break;
    }
  }
  reactions.sort(byPriorityThenId);

  // 关系定义
  const rawRelations = Array.isArray(src.relations) ? src.relations : [];
  const seenRelationIds = new Set<string>();
  const relationDefs: SimRelationDef[] = [];
  for (const item of rawRelations) {
    const def = parseRelationDef(item, ctx);
    if (!def) {
      dropped++;
      continue;
    }
    if (seenRelationIds.has(def.id)) {
      ctx.errors.push(`关系定义 id 重复：${def.id}（保留首条）`);
      dropped++;
      continue;
    }
    seenRelationIds.add(def.id);
    relationDefs.push(def);
    if (relationDefs.length >= SIM_RELATION_DEF_CAP) {
      ctx.warnings.push(`关系定义超过预算 ${SIM_RELATION_DEF_CAP}，其余已忽略`);
      break;
    }
  }
  relationDefs.sort(byPriorityThenId);

  const time = parseTime(src.time, ctx);

  // 消费者警告（不阻断）：只提示，不改变数据
  for (const def of keptTags) {
    if (def.role === 'trait') {
      const consumed =
        !!def.revokes?.length ||
        !!def.grantsMove ||
        reactions.some((r) => r.triggerTag === def.id) ||
        reactions.some((r) => r.selfTag === def.id);
      if (!consumed) ctx.warnings.push(`人物标签「${def.name}」没有任何消费规则（不会被感知/能力/反应使用）`);
    } else if (def.role === 'need') {
      const hasAffordance = keptTags.some((t) => t.affordance?.needId === def.id);
      const hasReliever = !!def.need?.relievers && Object.keys(def.need.relievers).length > 0;
      if (!hasAffordance && !hasReliever) ctx.warnings.push(`需求「${def.name}」没有任何满足途径（无 affordance，也无 relievers）`);
    } else if (def.role === 'emotion') {
      const consumed = reactions.some((r) => r.emotion?.defId === def.id) || (def.emotion?.stance ?? 'none') !== 'none';
      if (!consumed) ctx.warnings.push(`情绪「${def.name}」没有任何驱动来源（无反应规则，也未设置 stance）`);
    }
  }
  if (time && time.phases.length) {
    for (const def of keptTags) {
      const phases = def.affordance?.activePhases;
      if (!phases) continue;
      const valid = phases.filter((p) => time.phases.some((x) => x.id === p));
      if (!valid.length) {
        delete def.affordance!.activePhases;
        ctx.warnings.push(`环境交互「${def.name}」的可用时段均不存在，已改为全天`);
      } else if (valid.length !== phases.length) {
        def.affordance!.activePhases = valid;
        ctx.warnings.push(`环境交互「${def.name}」部分可用时段不存在，已过滤`);
      }
    }
  }

  if (!keptTags.length && !reactions.length && !relationDefs.length && !time) {
    return { schema: EMPTY_SIM_SCHEMA, errors: ctx.errors, warnings: ctx.warnings, dropped };
  }
  return {
    schema: {
      tags: keptTags,
      reactions,
      relations: relationDefs,
      ...(time ? { time } : {}),
    },
    errors: ctx.errors,
    warnings: ctx.warnings,
    dropped,
  };
}

/** 规范化（载入/持久化/存档共用）：只返回 schema，问题丢弃不提示 */
export function sanitizeSimSchema(raw: unknown): SimSchema {
  return inspectSimSchema(raw).schema;
}

/** 编辑器校验：对已规范化 schema 再跑一遍，返回错误 + 警告 */
export function validateSimSchema(schema: SimSchema): string[] {
  const r = inspectSimSchema(schema);
  return [...r.errors, ...r.warnings];
}

// ── 索引（引擎/UI 查询；一次构建，遍历顺序固定） ──

export interface SimSchemaIndex {
  schema: SimSchema;
  tagsById: ReadonlyMap<string, SimTagDef>;
  tagIds: string[];
  traits: SimTagDef[];
  needs: SimTagDef[];
  emotions: SimTagDef[];
  envTags: SimTagDef[];
  affordances: SimTagDef[];
  narratives: SimTagDef[];
  relationsById: ReadonlyMap<string, SimRelationDef>;
  relationDefs: SimRelationDef[];
  reactions: SimReactionDef[];
  reactionsByTrigger: ReadonlyMap<string, SimReactionDef[]>;
  /** 解析后的时间维度（缺省单相「全天」） */
  time: SimTimeDef;
}

export function indexSimSchema(schema: SimSchema): SimSchemaIndex {
  const tags = [...schema.tags].sort(byId);
  const tagsById = new Map(tags.map((t) => [t.id, t]));
  const relations = [...schema.relations].sort(byPriorityThenId);
  const reactions = [...schema.reactions].sort(byPriorityThenId);
  const reactionsByTrigger = new Map<string, SimReactionDef[]>();
  for (const r of reactions) {
    const list = reactionsByTrigger.get(r.triggerTag) ?? [];
    list.push(r);
    reactionsByTrigger.set(r.triggerTag, list);
  }
  return {
    schema,
    tagsById,
    tagIds: tags.map((t) => t.id),
    traits: tags.filter((t) => t.role === 'trait'),
    needs: tags.filter((t) => t.role === 'need'),
    emotions: tags.filter((t) => t.role === 'emotion'),
    envTags: tags.filter((t) => t.scope === 'env'),
    affordances: tags.filter((t) => t.role === 'affordance'),
    narratives: tags.filter((t) => t.role === 'narrative'),
    relationsById: new Map(relations.map((r) => [r.id, r])),
    relationDefs: relations,
    reactions,
    reactionsByTrigger,
    time: schema.time && schema.time.phases.length ? schema.time : DEFAULT_SIM_TIME,
  };
}

export function tagDefOf(index: SimSchemaIndex | undefined, id: string | undefined): SimTagDef | undefined {
  return id && index ? index.tagsById.get(id) : undefined;
}

export function relationDefOf(index: SimSchemaIndex | undefined, id: string | undefined): SimRelationDef | undefined {
  return id && index ? index.relationsById.get(id) : undefined;
}

// ── 实例清洗 ──

/** 人物标签：只保留 scope=character 的 trait/emotion，去重限 8 条（C4） */
export function sanitizeProfileTags(raw: unknown, index: SimSchemaIndex): SimTagInstance[] {
  if (!Array.isArray(raw)) return [];
  const out: SimTagInstance[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const defId = typeof item === 'string' ? item : isObj(item) && typeof item.defId === 'string' ? item.defId : '';
    if (!defId || seen.has(defId)) continue;
    const def = index.tagsById.get(defId);
    if (!def || def.scope !== 'character' || def.role === 'need') continue;
    seen.add(defId);
    const rawValue = isObj(item) ? item.value : undefined;
    const value = def.role === 'emotion' ? num(rawValue, 0, 100, def.emotion?.initial ?? 0) : undefined;
    out.push(value === undefined ? { defId } : { defId, value });
    if (out.length >= SIM_PROFILE_TAG_CAP) break;
  }
  return out;
}

/** 环境标签：只保留 scope=env 的定义，去重限 4 条（C4） */
export function sanitizeEnvTags(raw: unknown, index: SimSchemaIndex): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const def = index.tagsById.get(item);
    if (!def || def.scope !== 'env' || out.includes(item)) continue;
    out.push(item);
    if (out.length >= SIM_ENV_TAG_CAP) break;
  }
  return out;
}

/** 关系标签：只保留 schema.relations 中存在的 id，限 3 条（按定义优先级排序） */
export function sanitizeRelationTags(raw: unknown, index: SimSchemaIndex): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || out.includes(item)) continue;
    if (!index.relationsById.has(item)) continue;
    out.push(item);
    if (out.length >= SIM_RELATION_TAG_CAP) break;
  }
  // 排序让多标签的优先级判定与输入顺序无关（C5）
  out.sort((a, b) => {
    const da = index.relationsById.get(a)!;
    const db = index.relationsById.get(b)!;
    return byPriorityThenId(da, db);
  });
  return out;
}

const relationKey = (from: string, to: string) => `${from}\u0000${to}`;

/** 🔗 关系表校验（作品级有向图）：未知人物/自环/重复/无标签一律丢弃。
 *  旧档无向形态 `{a,b}` 展开为两条有向边（保持旧语义：互相都这么说）。 */
export function sanitizeRelations(
  raw: unknown,
  characters: Record<string, { id: string }>,
  index: SimSchemaIndex,
): SimRelation[] {
  if (!Array.isArray(raw)) return [];
  const byPair = new Map<string, SimRelation>();
  const add = (from: unknown, to: unknown, tagsRaw: unknown, valueRaw: unknown) => {
    const a = typeof from === 'string' ? from : '';
    const b = typeof to === 'string' ? to : '';
    if (!a || !b || a === b || !characters[a] || !characters[b]) return;
    const tags = sanitizeRelationTags(tagsRaw, index);
    if (!tags.length) return;
    const key = relationKey(a, b);
    if (byPair.has(key)) return;
    const value = typeof valueRaw === 'number' && Number.isFinite(valueRaw) ? num(valueRaw, 0, 100, SIM_RELATION_VALUE_DEFAULT) : undefined;
    byPair.set(key, { from: a, to: b, tags, ...(value !== undefined ? { value } : {}) });
  };
  for (const item of raw) {
    if (!isObj(item)) continue;
    if (typeof item.from === 'string' || typeof item.to === 'string') {
      add(item.from, item.to, item.tags, item.value);
      continue;
    }
    // 旧档无向 {a,b}：展开双向
    if (typeof item.a === 'string' && typeof item.b === 'string') {
      add(item.a, item.b, item.tags, item.value);
      add(item.b, item.a, item.tags, item.value);
    }
  }
  const out = [...byPair.values()];
  out.sort((p, q) => (p.from === q.from ? (p.to < q.to ? -1 : p.to > q.to ? 1 : 0) : p.from < q.from ? -1 : 1));
  return out;
}

/** 查 from 对 to 的关系标签（有向；无则 []） */
export function relationTagsOf(relations: SimRelation[], from: string, to: string): string[] {
  for (const r of relations) if (r.from === from && r.to === to) return r.tags;
  return [];
}

/** 查 from 对 to 的好感值（缺省 50） */
export function relationValueOf(relations: SimRelation[], from: string, to: string): number {
  for (const r of relations) if (r.from === from && r.to === to) return r.value ?? SIM_RELATION_VALUE_DEFAULT;
  return SIM_RELATION_VALUE_DEFAULT;
}

/** 人物标签 → trait id 列表（引擎感知/移动用；排序保证确定性） */
export function traitIdsOf(tags: SimTagInstance[] | undefined, index: SimSchemaIndex): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) if (index.tagsById.get(t.defId)?.role === 'trait') out.push(t.defId);
  return out.sort();
}

/** 人物标签 → 情绪初值（未写的情绪按定义 initial 补齐） */
export function emotionInitialsOf(tags: SimTagInstance[] | undefined, index: SimSchemaIndex): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of index.emotions) {
    const inst = tags?.find((t) => t.defId === def.id);
    out[def.id] = num(inst?.value, 0, 100, def.emotion?.initial ?? 0);
  }
  return out;
}

// ── 时间 ──

export interface SimClock {
  tick: number;
  day: number;
  phaseId: string;
  phaseName: string;
  /** 当天进度 0-1 */
  phaseFraction: number;
}

/** 由拍号算世界时钟（相位半开区间 [from,to)；找不到落在区间内的相时取最后一相） */
export function simClockAt(index: SimSchemaIndex, tick: number): SimClock {
  const time = index.time;
  const dayLen = Math.max(1, Math.round(time.ticksPerDay));
  const day = Math.floor(tick / dayLen);
  const phaseFraction = (tick % dayLen) / dayLen;
  const phase = time.phases.find((p) => phaseFraction >= p.from && phaseFraction < p.to) ?? time.phases[time.phases.length - 1];
  return { tick, day, phaseId: phase.id, phaseName: phase.name, phaseFraction };
}

/** affordance 在给定相位是否可用（无 activePhases = 全天） */
export function affordanceActiveIn(def: SimTagDef | undefined, index: SimSchemaIndex, phaseId: string): boolean {
  const phases = def?.affordance?.activePhases;
  if (!phases || !phases.length) return true;
  // 缺省时间维度只有 always 相：把任何限制都视为全天（避免作者忘配时间导致永远不可用）
  if (index.time.phases.length === 1 && index.time.phases[0].id === 'always') return true;
  return phases.includes(phaseId);
}
