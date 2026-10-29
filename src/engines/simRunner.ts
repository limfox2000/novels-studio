/** 🎬 剧情推演引擎（纯函数，不依赖 store/React/Prompt）——统一标签内核的垂直切片（设计文档 §19）。
 *
 *  内核固定理解六种原语，标签只是数据（引擎不出现任何题材分支）：
 *  1. 移动：模式（walk/fly）+ 速度 + 通行性——trait 标签 grant/revoke；
 *  2. 需求：沿用 SimProfile.desires（0-100 + 每拍增长 + 阈值 + 缓解）——饥饿/疲劳/好奇；
 *  3. 情绪：0-100 + 每拍衰减——恐惧/喜悦，只影响决策；
 *  4. 交互/affordance：环境标签提供「目标 + 需求 + 耗时 + 缓解」——提供食物/可睡；
 *  5. 感知：可见性 always/near/concealed + 感知半径 + 发现事件——西装/手枪/脏乱；
 *  6. 反应：观察到标签 + 条件 → 情绪Δ + 行为偏置——喜欢西装→靠近，发现手枪→恐惧远离。
 *
 *  决策管线四层（§19.4）：紧急（饥饿≥85 / 恐惧≥70）→ 常规（阈值/张望）→ 社交·环境（关系/偏好）→ 待机；
 *  仅紧急层可抢占进行中的动作，并记录 pendingIntent 供恢复。
 *
 *  认知：每个 actor 有独立知识（环境标签 / 人物标签 + seenTick，可过时），预算每人 64 条（C4）。
 *  关系：作品级人物边（SimRelation），同场按标签决定靠近交谈或绕开。
 *  可复现：mulberry32 seeded RNG；同 seed + 同舞台 + 同档案/标签/关系 = 同事件序列；标签顺序不影响决策（排序后计算）。
 *  推演只读作品数据：本文件不写回 boards/characters/simProfiles。 */
import type { EnvironmentType, SimBoard, SimProfile, SimRelation, WorkCharacter } from '../types/sim';
import { absPositionOf } from '../stores/graphGeom';
import {
  BEHAVIOR_EAT,
  BEHAVIOR_EXPLORE,
  BEHAVIOR_FLEE,
  BEHAVIOR_OBSERVE,
  BEHAVIOR_REST,
  BEHAVIOR_TALK,
  BEHAVIOR_WANDER,
  DESIRE_CURIOSITY,
  DESIRE_FATIGUE,
  DESIRE_HUNGER,
  SIM_NOVELTY_RELIEF,
  SIM_OBSERVE_MIN_CURIOSITY,
  SIM_OBSERVE_RELIEF,
  SIM_REST_RELIEF,
  defaultSimProfile,
  observeTicks,
  resolveSimProfile,
  type ResolvedSimProfile,
} from '../stores/simProfiles';
import {
  EMOTION_FEAR,
  EMOTION_JOY,
  NEED_FATIGUE,
  NEED_HUNGER,
  REL_ENEMY,
  REL_FRIEND,
  REL_LIKE,
  relationTagOf,
  tagDefOf,
  type SimTagDef,
} from '../stores/simTags';

// ── 常量（能力/欲望参数一律来自推演档案；这里只有内核节拍参数） ──

/** 人物节点估算尺寸：移动边界与「在哪个环境」判定用（真实尺寸由 RF 测量，这里够用） */
export const SIM_CHAR_W = 84;
export const SIM_CHAR_H = 96;
/** 事件日志环形上限 */
export const SIM_EVENT_CAP = 120;
/** 紧急层阈值：需求达到即只能救急（设计文档 §19.4） */
export const SIM_NEED_EMERGENCY = 85;
/** 恐惧进入紧急层的阈值 / 恐惧消退、清除恐惧来源的阈值 */
export const SIM_FEAR_BREAK = 70;
export const SIM_FEAR_CLEAR = 40;
/** 靠近发现隐藏标签的距离（手枪「凑近才发现」） */
export const SIM_CLOSE_DISTANCE = 150;
/** 交谈距离：进入该距离直接交谈，否则先靠近 */
export const SIM_TALK_DISTANCE = 110;
/** 社交站位：靠近到目标身边这个距离 */
const SIM_APPROACH_DISTANCE = 90;
/** 躲避后退距离 */
const SIM_AVOID_DISTANCE = 220;
/** 每人知识条目预算（C4） */
export const SIM_KNOWLEDGE_CAP = 64;
/** 同一句提示的最小间隔（拍），防止紧急层每拍刷日志 */
const NOTE_COOLDOWN = 12;
/** 休息保底耗时（档案未指定时） */
const REST_FALLBACK_TICKS = 3;

export type SimBehavior = 'idle' | 'move' | 'observe' | 'rest' | 'eat' | 'talk' | 'avoid';
export type SimMoveIntent = 'wander' | 'explore' | 'need' | 'social' | 'avoid';

export const SIM_BEHAVIOR_LABELS: Record<SimBehavior, string> = {
  idle: '待机',
  move: '走动',
  observe: '张望',
  rest: '休息',
  eat: '进食',
  talk: '交谈',
  avoid: '躲避',
};

export interface SimEnvBox {
  id: string;
  name: string;
  /** 绝对坐标（已含父链偏移） */
  x: number;
  y: number;
  w: number;
  h: number;
  etype: EnvironmentType;
  /** 父环境（移动边界向上爬：床上不走路，回到房间） */
  parentId: string | null;
  /** 🏷 环境标签（affordance / narrative） */
  tags: string[];
}

/** 认知条目：已知标签 + 最近一次确认拍（可以过时，设计文档 §19.2 认知维度） */
export interface SimKnownEntity {
  tags: string[];
  tick: number;
}

export interface SimActor {
  /** 画布人物放置节点 id（渲染定位用） */
  nodeId: string;
  characterId: string;
  name: string;
  /** 人物节点左上角绝对坐标 */
  x: number;
  y: number;
  /** 当前所在环境（中心点落在哪个环境盒内；最内层） */
  envId: string | null;
  behavior: SimBehavior;
  intent?: SimMoveIntent;
  target: { x: number; y: number } | null;
  /** observe / rest / eat / talk 的完成拍 */
  busyUntil: number;
  /** 当前耗时动作开始拍（紧急抢占冷却） */
  busySince: number;
  /** 建会话时冻结的推演档案（运行时参数；改档案需重置后生效） */
  profile: ResolvedSimProfile;
  /** 欲望/需求当前值（defId → 0-100） */
  desires: Record<string, number>;
  /** 情绪当前值（emotion 标签 id → 0-100，每拍衰减） */
  emotions: Record<string, number>;
  /** 人物 trait 标签 id（建会话时冻结；排序保证确定性） */
  traits: string[];
  /** 移动模式（由标签解析：残疾 revoke walk / 御剑 grant fly） */
  moveMode: 'walk' | 'fly';
  /** 是否可移动（撤销 walk 且没有其它移动模式 → 不可移动） */
  movable: boolean;
  /** 实际每拍速度（fly 乘系数） */
  speed: number;
  /** 到过的环境（新颖度判定） */
  knownEnvIds: string[];
  /** 人物认知：环境 / 人物标签（可过时，C4 预算） */
  knowledge: { envs: Record<string, SimKnownEntity>; actors: Record<string, SimKnownEntity> };
  /** 恐惧来源（人物放置节点 id）；情绪降下来后清除 */
  fearOf?: string;
  /** 想靠近的人（反应/关系触发） */
  approachId?: string;
  /** 交谈对象（结算时用） */
  talkWith?: string;
  /** 意图记忆：被紧急层抢占的进行中动作，恢复时优先回溯 */
  pendingIntent?: { behavior: 'observe' | 'rest' } | null;
  /** 抢占冷却 */
  lastPreemptTick: number;
  /** 同类提示冷却（key → 上次拍） */
  notedAt: Record<string, number>;
}

export interface SimEvent {
  id: string;
  tick: number;
  actorName: string;
  text: string;
}

export interface SimSession {
  boardId: string;
  tick: number;
  seed: number;
  /** mulberry32 状态（随 session 前进，保证可复现） */
  rng: number;
  envs: SimEnvBox[];
  actors: SimActor[];
  /** 🔗 人物关系边（建会话时冻结） */
  relations: SimRelation[];
  events: SimEvent[];
}

// ── 随机数：mulberry32（与设计文档一致） ──

function nextRand(state: number): { value: number; state: number } {
  let a = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: a };
}

// ── 几何 ──

function envBox(n: import('@xyflow/react').Node, abs: { x: number; y: number }): SimEnvBox {
  const d = n.data as { name?: string; etype?: EnvironmentType; tags?: string[] };
  return {
    id: n.id,
    name: (d.name || '').trim() || '未命名环境',
    x: abs.x,
    y: abs.y,
    w: n.width ?? n.measured?.width ?? 220,
    h: n.height ?? n.measured?.height ?? 150,
    etype: d.etype ?? 'building',
    parentId: n.parentId ?? null,
    // 标签排序后使用：标签顺序不得影响决策（C5）
    tags: [...(Array.isArray(d.tags) ? d.tags : [])].sort(),
  };
}

function pointInBox(px: number, py: number, b: SimEnvBox): boolean {
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

/** 人物当前所在环境：从所有包含其中心点的环境里选面积最小的（最内层容器） */
export function envAtPoint(envs: SimEnvBox[], cx: number, cy: number): SimEnvBox | undefined {
  let best: SimEnvBox | undefined;
  let bestArea = Infinity;
  for (const e of envs) {
    if (!pointInBox(cx, cy, e)) continue;
    const area = e.w * e.h;
    if (area < bestArea) {
      best = e;
      bestArea = area;
    }
  }
  return best;
}

/** 点到环境矩形的最短距离（感知环境用；在内部为 0） */
function distToBox(px: number, py: number, b: SimEnvBox): number {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
  const dy = Math.max(b.y - py, 0, py - (b.y + b.h));
  return Math.hypot(dx, dy);
}

/** 环境内随机落点（避开人物尺寸，留 12px 边距） */
function randomPointIn(b: SimEnvBox, rand: () => number): { x: number; y: number } {
  const maxX = Math.max(b.x + 12, b.x + b.w - SIM_CHAR_W - 12);
  const maxY = Math.max(b.y + 12, b.y + b.h - SIM_CHAR_H - 12);
  return {
    x: b.x + 12 + rand() * Math.max(0, maxX - (b.x + 12)),
    y: b.y + 12 + rand() * Math.max(0, maxY - (b.y + 12)),
  };
}

function centerOf(a: { x: number; y: number }): { x: number; y: number } {
  return { x: a.x + SIM_CHAR_W / 2, y: a.y + SIM_CHAR_H / 2 };
}

function actorDistance(a: SimActor, b: SimActor): number {
  const ca = centerOf(a);
  const cb = centerOf(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

/** 移动边界：当前若站在床/物品上，向上爬到可走动的容器（房间/建筑…） */
function walkableBox(env: SimEnvBox | undefined, envs: SimEnvBox[]): SimEnvBox | undefined {
  let cur = env;
  const guard = new Set<string>();
  while (cur && (cur.etype === 'bed' || cur.etype === 'item') && cur.parentId && !guard.has(cur.id)) {
    guard.add(cur.id);
    const parent = envs.find((e) => e.id === cur!.parentId);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

// ── 建世界 / 建会话 ──

/** 从舞台画布抽世界：环境盒（绝对坐标 + 类型 + 父级 + 标签）。人物只由调用方按放置读取。 */
export function buildSimWorld(board: SimBoard): SimEnvBox[] {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const envs: SimEnvBox[] = [];
  for (const n of board.nodes) {
    if (n.data.kind !== 'environment') continue;
    envs.push(envBox(n, absPositionOf(n, byId)));
  }
  return envs;
}

/** 标签 → 移动模式（原语 1）：撤销显式，能力是许可不是数值对抗。
 *  `revokes:['move:walk']` 移除步行；`grantsMove:{mode:'fly'}` 授予飞行（另一模式，不与 revoke 冲突）。
 *  两者同时存在时仍可飞（revoke 优先只针对同一能力）。 */
export function resolveSimMovement(traits: string[], baseSpeed: number): { movable: boolean; mode: 'walk' | 'fly'; speed: number } {
  let walk = true;
  let flyFactor: number | null = null;
  for (const id of [...traits].sort()) {
    const def = tagDefOf(id);
    if (!def) continue;
    if (def.revokes?.includes('move:walk')) walk = false;
    if (def.grantsMove?.mode === 'fly') flyFactor = def.grantsMove.speedMultiplier;
  }
  const mode = flyFactor !== null ? 'fly' : 'walk';
  const movable = walk || flyFactor !== null;
  const speed = Math.max(1, Math.round(flyFactor !== null ? baseSpeed * flyFactor : baseSpeed));
  return { movable, mode, speed };
}

/** 环境是否提供某项需求的交互（affordance 原语） */
function affordanceOf(env: SimEnvBox | undefined, needId: string): SimTagDef['affordance'] | undefined {
  if (!env) return undefined;
  for (const tagId of env.tags) {
    const def = tagDefOf(tagId);
    if (def?.affordance?.needId === needId) return def.affordance;
  }
  return undefined;
}

function boxOf(envs: SimEnvBox[], id: string | null | undefined): SimEnvBox | undefined {
  return id ? envs.find((e) => e.id === id) : undefined;
}

export type CreateSessionResult = { session: SimSession } | { error: string };

/** 建会话：把舞台上的全部人物放置冻结成 actor（位置/所在环境/档案/标签/欲望/情绪/关系）。
 *  舞台没有人物 → 返回可展示的错误文案；人物缺推演档案 → 用默认档兜底。
 *  relations 与 seed 位置兼容旧调用（第四参为 number 时视为 seed）。 */
export function createSimSession(
  board: SimBoard,
  characters: Record<string, WorkCharacter>,
  profiles: Record<string, SimProfile> = {},
  relationsOrSeed: SimRelation[] | number = [],
  seedArg?: number,
): CreateSessionResult {
  const relations = Array.isArray(relationsOrSeed) ? relationsOrSeed : [];
  const seed = typeof relationsOrSeed === 'number' ? relationsOrSeed : (seedArg ?? ((Date.now() >>> 0) || 1));
  const envs = buildSimWorld(board);
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const actors: SimActor[] = [];
  let rng = seed;
  for (const n of board.nodes) {
    if (n.data.kind !== 'character') continue;
    const abs = absPositionOf(n, byId);
    const cx = abs.x + SIM_CHAR_W / 2;
    const cy = abs.y + SIM_CHAR_H / 2;
    const env = envAtPoint(envs, cx, cy);
    const characterId = n.data.characterId;
    const name = (characters[characterId]?.name || '').trim() || '未命名人物';
    const profile = resolveSimProfile(profiles[characterId] ?? defaultSimProfile(characterId));
    const desires: Record<string, number> = {};
    for (const [defId, d] of Object.entries(profile.desires)) desires[defId] = d.enabled ? d.value : 0;
    const movement = resolveSimMovement(profile.tags, profile.capabilities.speed);
    actors.push({
      nodeId: n.id,
      characterId,
      name,
      x: abs.x,
      y: abs.y,
      envId: env?.id ?? null,
      behavior: 'idle',
      target: null,
      busyUntil: 0,
      busySince: 0,
      profile,
      desires,
      emotions: { ...profile.emotions },
      traits: profile.tags.slice(),
      moveMode: movement.mode,
      movable: movement.movable,
      speed: movement.speed,
      knownEnvIds: env ? [env.id] : [],
      knowledge: {
        envs: env ? { [env.id]: { tags: [...env.tags].sort(), tick: 0 } } : {},
        actors: {},
      },
      pendingIntent: null,
      lastPreemptTick: -999,
      notedAt: {},
    });
  }
  if (!actors.length) {
    return { error: '舞台上还没有人物：先在舞台画布放置人物节点，再开始推演。' };
  }
  const events: SimEvent[] = [
    {
      id: `${seed}-0`,
      tick: 0,
      actorName: '系统',
      text: `推演开始：${actors.length} 人进入舞台${envs.length ? `，${envs.length} 个环境` : '（未布置环境，人物将在原地小范围走动）'}`,
    },
  ];
  for (const a of actors) {
    if (!a.movable) {
      events.push({ id: `${seed}-0-${a.nodeId}`, tick: 0, actorName: a.name, text: '腿脚不便，只能留在原地' });
    }
  }
  return {
    session: {
      boardId: board.id,
      tick: 0,
      seed,
      rng,
      envs,
      actors,
      relations: relations.map((r) => ({ a: r.a, b: r.b, tags: r.tags.slice(), ...(r.value !== undefined ? { value: r.value } : {}) })),
      events,
    },
  };
}

// ── 单拍推进 ──

interface StepCtx {
  envs: SimEnvBox[];
  /** 拍开始时的 actor 快照（感知/目标准确，且同拍内互不影响 → 确定性） */
  actors: SimActor[];
  relations: SimRelation[];
  tick: number;
  events: SimEvent[];
  rand: () => number;
}

function log(ctx: StepCtx, actor: SimActor, text: string) {
  ctx.events.push({ id: `${ctx.tick}-${ctx.events.length}-${actor.nodeId}`, tick: ctx.tick, actorName: actor.name, text });
}

/** 同类提示限频（紧急层/关系层可能每拍重复触发） */
function noteOnce(a: SimActor, ctx: StepCtx, key: string, text: string) {
  const last = a.notedAt[key] ?? -999;
  if (ctx.tick - last < NOTE_COOLDOWN) return;
  a.notedAt[key] = ctx.tick;
  log(ctx, a, text);
}

// ── 认知（感知原语） ──

function remember(map: Record<string, SimKnownEntity>, id: string, tags: string[], tick: number) {
  const prev = map[id];
  if (!prev) {
    map[id] = { tags: [...tags].sort(), tick };
  } else {
    const merged = new Set(prev.tags);
    for (const t of tags) merged.add(t);
    map[id] = { tags: [...merged].sort(), tick };
  }
  // C4 预算：超出上限时丢弃最久未确认的条目（按 tick 排序，确定）
  const ids = Object.keys(map);
  if (ids.length > SIM_KNOWLEDGE_CAP) {
    ids.sort((p, q) => (map[p].tick - map[q].tick) || (p < q ? -1 : 1));
    for (const old of ids.slice(0, ids.length - SIM_KNOWLEDGE_CAP)) delete map[old];
  }
}

/** 记录环境标签（进入/看见）；叙述标签只在**首次进入**时出一条描写（与感知已知无关） */
function noteEnv(a: SimActor, env: SimEnvBox, ctx: StepCtx, withNarrative: boolean) {
  remember(a.knowledge.envs, env.id, env.tags, ctx.tick);
  if (!withNarrative) return;
  for (const tagId of [...env.tags].sort()) {
    const def = tagDefOf(tagId);
    if (!def?.discoverText) continue;
    const key = `env:${env.id}:${tagId}`;
    if (a.notedAt[key] !== undefined) continue;
    a.notedAt[key] = ctx.tick;
    log(ctx, a, def.discoverText.replace('{env}', env.name));
  }
}

/** 当前位置的环境（最内层）；affordance 先看脚下（床/物品），再爬到可走动的父容器 */
function envAffordanceAt(a: SimActor, ctx: StepCtx, needId: string): { env?: SimEnvBox; affordance?: SimTagDef['affordance'] } {
  const here = boxOf(ctx.envs, a.envId);
  const own = affordanceOf(here, needId);
  if (own) return { env: here, affordance: own };
  const up = walkableBox(here, ctx.envs);
  const inherited = affordanceOf(up, needId);
  return inherited ? { env: up, affordance: inherited } : {};
}

/** 感知环境：感知范围内的环境标签可见（世界认知池——冰箱/浴缸/垃圾不需要走进去也知道在那儿） */
function perceiveEnvs(a: SimActor, ctx: StepCtx) {
  const c = centerOf(a);
  const radius = a.profile.capabilities.perception;
  for (const env of ctx.envs) {
    if (!env.tags.length) continue;
    if (distToBox(c.x, c.y, env) > radius) continue;
    noteEnv(a, env, ctx, false);
  }
}

/** 对观察者应用标签反应（原语 6）：条件（自身标签）→ 情绪Δ + 行为偏置 + 事件 */
function applyReaction(a: SimActor, tagId: string, other: SimActor, ctx: StepCtx) {
  const def = tagDefOf(tagId);
  const rule = def?.reaction;
  if (!def || !rule) return;
  if (rule.selfTag && !a.traits.includes(rule.selfTag)) return;
  if (rule.emotion) {
    a.emotions[rule.emotion] = Math.min(100, Math.max(0, (a.emotions[rule.emotion] ?? 0) + (rule.delta ?? 0)));
  }
  if (rule.behavior === 'avoid') a.fearOf = other.nodeId;
  if (rule.behavior === 'approach') a.approachId = other.nodeId;
  log(ctx, a, rule.text.replace('{target}', other.name));
}

/** 感知人物：always 一眼可见；near 进感知范围；concealed 需靠近（≤150）或张望（viaObserve） */
function perceiveActors(a: SimActor, ctx: StepCtx, viaObserve: boolean) {
  const radius = a.profile.capabilities.perception;
  for (const other of ctx.actors) {
    if (other.nodeId === a.nodeId) continue;
    const dist = actorDistance(a, other);
    if (dist > radius) continue;
    const known = new Set(a.knowledge.actors[other.nodeId]?.tags ?? []);
    const learned: string[] = [];
    for (const tagId of [...other.traits].sort()) {
      const def = tagDefOf(tagId);
      if (!def) continue;
      const visibility = def.visibility ?? 'always';
      const visible =
        visibility === 'always' ||
        visibility === 'near' ||
        (visibility === 'concealed' && (viaObserve || dist <= SIM_CLOSE_DISTANCE));
      if (visible && !known.has(tagId)) learned.push(tagId);
    }
    if (!learned.length) continue;
    remember(a.knowledge.actors, other.nodeId, learned, ctx.tick);
    for (const tagId of learned) applyReaction(a, tagId, other, ctx);
  }
}

// ── 档案读取 ──

function behaviorOn(a: SimActor, defId: string): boolean {
  return a.profile.behaviors[defId]?.enabled === true;
}

function behaviorDuration(a: SimActor, defId: string, fallback: number): number {
  const d = a.profile.behaviors[defId]?.duration;
  return Math.max(1, Math.round(d ?? fallback));
}

function desireOn(a: SimActor, defId: string): boolean {
  return a.profile.desires[defId]?.enabled === true;
}

function desireValue(a: SimActor, defId: string): number {
  return a.desires[defId] ?? 0;
}

function relief(a: SimActor, defId: string, amount: number) {
  if (!desireOn(a, defId)) return;
  a.desires[defId] = Math.max(0, desireValue(a, defId) - amount);
}

// ── 动作启动 ──

function startBusy(a: SimActor, behavior: SimBehavior, ctx: StepCtx, ticks: number) {
  a.behavior = behavior;
  a.target = null;
  a.intent = undefined;
  a.busySince = ctx.tick;
  a.busyUntil = ctx.tick + Math.max(1, ticks);
}

function startMove(a: SimActor, target: { x: number; y: number }, intent: SimMoveIntent, behavior: SimBehavior = 'move') {
  // 防御：不可移动的人物（撤销 walk 且无其它移动模式）不产生位移，只能留在原地
  if (!a.movable) {
    a.behavior = 'idle';
    a.target = null;
    return;
  }
  a.behavior = behavior;
  a.intent = intent;
  a.target = target;
  a.busyUntil = 0;
}

/** 可去探索的环境：除当前外的容器，排除床/物品（那是住与交互的地方，不是「去处」） */
function exploreTargets(a: SimActor, ctx: StepCtx): SimEnvBox[] {
  return ctx.envs.filter((e) => e.id !== a.envId && e.etype !== 'bed' && e.etype !== 'item');
}

function pickExploreEnv(a: SimActor, ctx: StepCtx): SimEnvBox | null {
  const others = exploreTargets(a, ctx);
  if (!others.length) return null;
  const unknown = others.filter((e) => !a.knownEnvIds.includes(e.id));
  const pool = unknown.length && ctx.rand() < 0.7 ? unknown : others;
  return pool[Math.floor(ctx.rand() * pool.length)];
}

function startObserve(a: SimActor, ctx: StepCtx) {
  const ticks = behaviorDuration(a, BEHAVIOR_OBSERVE, observeTicks(a.profile.capabilities.observation));
  startBusy(a, 'observe', ctx, ticks);
  const here = boxOf(ctx.envs, a.envId);
  log(ctx, a, `停下脚步张望（${here?.name ?? '四周'}）`);
}

function startRest(a: SimActor, ctx: StepCtx) {
  const sleep = envAffordanceAt(a, ctx, NEED_FATIGUE);
  const ticks = behaviorDuration(a, BEHAVIOR_REST, sleep.affordance?.duration ?? REST_FALLBACK_TICKS);
  startBusy(a, 'rest', ctx, ticks);
  log(ctx, a, sleep.affordance ? `在「${sleep.env!.name}」躺下休息` : '累了，找个地方坐下休息');
}

/** 已知的、提供某需求的环境（优先当前位置，其次离得最近的） */
function findKnownEnvFor(a: SimActor, needId: string, ctx: StepCtx): SimEnvBox | undefined {
  const here = boxOf(ctx.envs, a.envId);
  if (affordanceOf(here, needId)) return here;
  const c = centerOf(a);
  const candidates: SimEnvBox[] = [];
  for (const envId of Object.keys(a.knowledge.envs)) {
    const env = boxOf(ctx.envs, envId);
    if (!env || !affordanceOf(env, needId)) continue;
    candidates.push(env);
  }
  if (!candidates.length) return undefined;
  candidates.sort((p, q) => distToBox(c.x, c.y, p) - distToBox(c.x, c.y, q) || (p.id < q.id ? -1 : 1));
  return candidates[0];
}

/** 饥饿满足：当前环境有食物 → 进食；知道哪里 → 走过去；紧急且不知道 → 原地发慌（限频提示） */
function trySatisfyHunger(a: SimActor, ctx: StepCtx, urgent: boolean): boolean {
  if (!behaviorOn(a, BEHAVIOR_EAT)) return false;
  const here = envAffordanceAt(a, ctx, NEED_HUNGER);
  if (here.affordance) {
    startBusy(a, 'eat', ctx, behaviorDuration(a, BEHAVIOR_EAT, here.affordance.duration));
    log(ctx, a, urgent ? `饿得发慌，在「${here.env!.name}」赶紧吃东西` : `在「${here.env!.name}」找了些吃的`);
    return true;
  }
  const target = findKnownEnvFor(a, NEED_HUNGER, ctx);
  if (target && a.movable) {
    // 物品=走到物件中心；容器=走到容器内的落点
    const point =
      target.etype === 'item'
        ? { x: target.x + target.w / 2 - SIM_CHAR_W / 2, y: target.y + target.h / 2 - SIM_CHAR_H / 2 }
        : randomPointIn(walkableBox(target, ctx.envs) ?? target, ctx.rand);
    startMove(a, point, 'need');
    log(ctx, a, urgent ? `饿得发慌，朝「${target.name}」走去` : `饿了，朝「${target.name}」走去`);
    return true;
  }
  if (urgent) {
    noteOnce(a, ctx, 'hunger', '饿得发慌，却不知道哪里有吃的');
    a.behavior = 'idle';
    return true;
  }
  return false;
}

function startTalk(a: SimActor, partner: SimActor, ctx: StepCtx) {
  const ticks = behaviorDuration(a, BEHAVIOR_TALK, 2);
  startBusy(a, 'talk', ctx, ticks);
  a.talkWith = partner.nodeId;
  log(ctx, a, `和「${partner.name}」攀谈起来`);
}

/** 走到目标身边（社交站位） */
function startApproach(a: SimActor, other: SimActor, ctx: StepCtx) {
  const ca = centerOf(a);
  const cb = centerOf(other);
  const dx = ca.x - cb.x;
  const dy = ca.y - cb.y;
  const dist = Math.hypot(dx, dy) || 1;
  // 通道寻路未接入前为「降级直连」：社交移动不按房间边界裁切（否则人物会被困在房间里）
  const goal = {
    x: other.x + (dx / dist) * SIM_APPROACH_DISTANCE,
    y: other.y + (dy / dist) * SIM_APPROACH_DISTANCE,
  };
  startMove(a, goal, 'social');
}

/** 远离某个目标（恐惧/敌对）；不可移动时原地提示（限频） */
function startAvoid(a: SimActor, other: SimActor, ctx: StepCtx, text: string, key: string): boolean {
  if (!a.movable) {
    noteOnce(a, ctx, key, text.replace('{target}', other.name));
    a.behavior = 'idle';
    return true;
  }
  const ca = centerOf(a);
  const cb = centerOf(other);
  let dx = ca.x - cb.x;
  let dy = ca.y - cb.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) {
    const angle = ctx.rand() * Math.PI * 2;
    dx = Math.cos(angle);
    dy = Math.sin(angle);
  } else {
    dx /= dist;
    dy /= dist;
  }
  // 同社交：降级直连模式下不按房间边界裁切，恐惧时可以直接跑出去
  const goal = { x: a.x + dx * SIM_AVOID_DISTANCE, y: a.y + dy * SIM_AVOID_DISTANCE };
  startMove(a, goal, 'avoid', 'avoid');
  noteOnce(a, ctx, key, text.replace('{target}', other.name));
  return true;
}

// ── 决策（四层管线） ──

function canObserve(a: SimActor): boolean {
  const curiosity = a.profile.desires[DESIRE_CURIOSITY];
  return !!curiosity?.enabled && behaviorOn(a, BEHAVIOR_OBSERVE) && desireValue(a, DESIRE_CURIOSITY) >= SIM_OBSERVE_MIN_CURIOSITY;
}

function canRest(a: SimActor): boolean {
  const fatigue = a.profile.desires[DESIRE_FATIGUE];
  return !!fatigue?.enabled && behaviorOn(a, BEHAVIOR_REST) && desireValue(a, DESIRE_FATIGUE) >= fatigue.threshold;
}

function canExplore(a: SimActor, ctx: StepCtx): boolean {
  const curiosity = a.profile.desires[DESIRE_CURIOSITY];
  return (
    a.movable &&
    !!curiosity?.enabled &&
    behaviorOn(a, BEHAVIOR_EXPLORE) &&
    desireValue(a, DESIRE_CURIOSITY) >= curiosity.threshold &&
    exploreTargets(a, ctx).length > 0
  );
}

/** 第三层：社交·环境（关系边 + 偏好反应）——先关系后偏好？先偏好（刚发现的人更抓注意力） */
function socialStep(a: SimActor, ctx: StepCtx): boolean {
  const radius = a.profile.capabilities.perception;
  const nearby = ctx.actors
    .filter((o) => o.nodeId !== a.nodeId && actorDistance(a, o) <= radius)
    .sort((p, q) => (p.nodeId < q.nodeId ? -1 : p.nodeId > q.nodeId ? 1 : 0));

  // 偏好反应：想靠近的人（西装 + 喜欢西装）
  if (a.approachId) {
    const target = nearby.find((o) => o.nodeId === a.approachId);
    if (target) {
      const d = actorDistance(a, target);
      if (d <= SIM_TALK_DISTANCE && behaviorOn(a, BEHAVIOR_TALK)) {
        startTalk(a, target, ctx);
        return true;
      }
      if (d > SIM_TALK_DISTANCE && a.movable) {
        startApproach(a, target, ctx);
        return true;
      }
    } else {
      a.approachId = undefined;
    }
  }

  // 关系边：敌对绕开；友善/爱慕靠近交谈
  for (const other of nearby) {
    const rel = relationTagOf(ctx.relations, a.characterId, other.characterId);
    if (!rel) continue;
    const d = actorDistance(a, other);
    if (rel === REL_ENEMY) {
      if (startAvoid(a, other, ctx, `看到「{target}」在场，绕开走`, `rel:${other.nodeId}`)) return true;
      continue;
    }
    if (rel === REL_FRIEND || rel === REL_LIKE) {
      if (d <= SIM_TALK_DISTANCE && behaviorOn(a, BEHAVIOR_TALK)) {
        startTalk(a, other, ctx);
        return true;
      }
      if (d > SIM_TALK_DISTANCE && a.movable) {
        startApproach(a, other, ctx);
        return true;
      }
    }
  }
  return false;
}

/** 第四层：待机（小范围走动，或原地待机——不可移动者/关闭走动） */
function idleStep(a: SimActor, ctx: StepCtx) {
  if (!a.movable || !behaviorOn(a, BEHAVIOR_WANDER)) {
    a.behavior = 'idle';
    return;
  }
  const here = walkableBox(boxOf(ctx.envs, a.envId), ctx.envs);
  const bounds: SimEnvBox =
    here ?? { id: '', name: '', x: a.x - 160, y: a.y - 120, w: SIM_CHAR_W + 320, h: SIM_CHAR_H + 240, etype: 'area', parentId: null, tags: [] };
  startMove(a, randomPointIn(bounds, ctx.rand), 'wander');
  if (ctx.rand() < 0.25) log(ctx, a, '在原地附近走动');
}

/** 空闲决策：紧急层 → 意图记忆 → 常规层 → 社交·环境层 → 待机层 */
function decide(a: SimActor, ctx: StepCtx) {
  // 恐惧来源失效/情绪降下来 → 清除
  if (a.fearOf) {
    const threat = ctx.actors.find((o) => o.nodeId === a.fearOf);
    if (!threat || (a.emotions[EMOTION_FEAR] ?? 0) < SIM_FEAR_CLEAR) a.fearOf = undefined;
  }

  // 1) 紧急层
  if (a.fearOf && (a.emotions[EMOTION_FEAR] ?? 0) >= SIM_FEAR_BREAK && behaviorOn(a, BEHAVIOR_FLEE)) {
    const threat = ctx.actors.find((o) => o.nodeId === a.fearOf);
    if (threat && startAvoid(a, threat, ctx, '吓得赶紧躲开「{target}」', `flee:${threat.nodeId}`)) return;
  }
  if (desireOn(a, DESIRE_HUNGER) && desireValue(a, DESIRE_HUNGER) >= SIM_NEED_EMERGENCY) {
    if (trySatisfyHunger(a, ctx, true)) return;
  }

  // 意图记忆：被抢占的动作恢复时优先回溯
  if (a.pendingIntent) {
    const pending = a.pendingIntent;
    a.pendingIntent = null;
    if (pending.behavior === 'observe' && canObserve(a)) {
      startObserve(a, ctx);
      return;
    }
    if (pending.behavior === 'rest' && canRest(a)) {
      startRest(a, ctx);
      return;
    }
  }

  // 2) 常规层（需求阈值 + 张望）
  if (desireOn(a, DESIRE_HUNGER)) {
    const hunger = a.profile.desires[DESIRE_HUNGER];
    if (hunger && desireValue(a, DESIRE_HUNGER) >= hunger.threshold && trySatisfyHunger(a, ctx, false)) return;
  }
  if (canRest(a)) {
    startRest(a, ctx);
    return;
  }
  if (canExplore(a, ctx)) {
    const target = pickExploreEnv(a, ctx);
    if (target) {
      const box = walkableBox(target, ctx.envs) ?? target;
      startMove(a, randomPointIn(box, ctx.rand), 'explore');
      log(ctx, a, `好奇地朝「${target.name}」走去`);
      return;
    }
  }
  if (canObserve(a) && ctx.rand() < Math.max(0, Math.min(1, a.profile.behaviors[BEHAVIOR_OBSERVE]?.weight ?? 0.6))) {
    startObserve(a, ctx);
    return;
  }

  // 3) 社交·环境层
  if (socialStep(a, ctx)) return;

  // 4) 待机层
  idleStep(a, ctx);
}

// ── 拍内结算 ──

function settleBusy(a: SimActor, ctx: StepCtx) {
  if (a.behavior === 'rest') {
    const sleep = envAffordanceAt(a, ctx, NEED_FATIGUE);
    relief(a, DESIRE_FATIGUE, sleep.affordance?.relief ?? SIM_REST_RELIEF);
    log(ctx, a, sleep.affordance ? '睡了一觉，精神好多了' : '休息结束，精神恢复了');
  } else if (a.behavior === 'eat') {
    const food = envAffordanceAt(a, ctx, NEED_HUNGER);
    relief(a, DESIRE_HUNGER, food.affordance?.relief ?? 0);
    log(ctx, a, '吃了些东西，不那么饿了');
  } else if (a.behavior === 'talk') {
    const partner = a.talkWith ? ctx.actors.find((o) => o.nodeId === a.talkWith) : undefined;
    if (partner) {
      a.emotions[EMOTION_JOY] = Math.min(100, (a.emotions[EMOTION_JOY] ?? 0) + 8);
      log(ctx, a, `和「${partner.name}」聊了几句`);
    }
    if (a.approachId && a.approachId === a.talkWith) a.approachId = undefined;
    a.talkWith = undefined;
  } else if (a.behavior === 'observe') {
    relief(a, DESIRE_CURIOSITY, SIM_OBSERVE_RELIEF);
    // 张望 = 主动发现：感知范围内人物的隐藏标签（手枪等）
    perceiveActors(a, ctx, true);
  }
  a.behavior = 'idle';
  a.busyUntil = 0;
  a.busySince = 0;
}

/** 紧急层抢占：只在有紧急事项且动作进行 2 拍以上时抢占，并带 4 拍冷却（防抖） */
function canPreempt(a: SimActor, ctx: StepCtx): boolean {
  if (ctx.tick - a.lastPreemptTick < 4) return false;
  const fearUrgent =
    !!a.fearOf && (a.emotions[EMOTION_FEAR] ?? 0) >= SIM_FEAR_BREAK && behaviorOn(a, BEHAVIOR_FLEE) && a.behavior !== 'avoid';
  const hungerUrgent =
    desireOn(a, DESIRE_HUNGER) && desireValue(a, DESIRE_HUNGER) >= SIM_NEED_EMERGENCY && behaviorOn(a, BEHAVIOR_EAT) && a.behavior !== 'eat';
  if (!fearUrgent && !hungerUrgent) return false;
  if (a.behavior === 'move' || a.behavior === 'avoid') {
    // 已在救急路上（去食物 / 躲避）不打断，否则每 4 拍重置目标
    if (a.intent === 'need' && hungerUrgent) return false;
    if (a.intent === 'avoid' && fearUrgent) return false;
    return true;
  }
  return ctx.tick - a.busySince >= 2 && ctx.tick < a.busyUntil;
}

function preempt(a: SimActor, ctx: StepCtx) {
  if (a.behavior === 'observe' || a.behavior === 'rest') a.pendingIntent = { behavior: a.behavior };
  a.target = null;
  a.behavior = 'idle';
  a.busyUntil = 0;
  a.busySince = 0;
  a.lastPreemptTick = ctx.tick;
}

/** 前进一拍：认知 → 移动推进 → 动作结算 → 情绪衰减/需求增长 → 决策。返回新 session（不修改入参）。 */
export function stepSimSession(session: SimSession): SimSession {
  let rng = session.rng;
  const rand = () => {
    const r = nextRand(rng);
    rng = r.state;
    return r.value;
  };
  const tick = session.tick + 1;
  const ctx: StepCtx = { envs: session.envs, actors: session.actors, relations: session.relations, tick, events: [], rand };

  const actors = session.actors.map((src) => {
    const a: SimActor = {
      ...src,
      target: src.target ? { ...src.target } : null,
      desires: { ...src.desires },
      emotions: { ...src.emotions },
      traits: src.traits.slice(),
      knownEnvIds: src.knownEnvIds.slice(),
      knowledge: { envs: { ...src.knowledge.envs }, actors: { ...src.knowledge.actors } },
      notedAt: { ...src.notedAt },
      pendingIntent: src.pendingIntent ?? null,
    };

    // 0) 认知：所在环境 + 感知范围内的环境/人物（always 标签）
    const startHere = envAtPoint(ctx.envs, a.x + SIM_CHAR_W / 2, a.y + SIM_CHAR_H / 2);
    if (startHere) {
      if (a.envId !== startHere.id) a.envId = startHere.id;
      if (!a.knownEnvIds.includes(startHere.id)) a.knownEnvIds.push(startHere.id);
    }
    perceiveEnvs(a, ctx);
    perceiveActors(a, ctx, false);

    // 1) 移动推进（到达才结算，途中不产生事件）；不可移动者永远没有位移
    // 走动与躲避都是位移（躲避是走动的语义化外观，二者都要推进，否则会卡在 avoid 不动）
    if (a.movable && (a.behavior === 'move' || a.behavior === 'avoid') && a.target) {
      const dx = a.target.x - a.x;
      const dy = a.target.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= a.speed) {
        a.x = a.target.x;
        a.y = a.target.y;
        a.target = null;
        a.behavior = 'idle';
        const env = envAtPoint(ctx.envs, a.x + SIM_CHAR_W / 2, a.y + SIM_CHAR_H / 2);
        const intent = a.intent;
        a.intent = undefined;
        if (env) {
          const firstVisit = !a.knownEnvIds.includes(env.id);
          a.envId = env.id;
          if (firstVisit) {
            a.knownEnvIds.push(env.id);
            // 新颖度信号：到没去过的环境 → 好奇缓解
            relief(a, DESIRE_CURIOSITY, SIM_NOVELTY_RELIEF);
            log(ctx, a, `到了「${env.name}」，四处是新东西`);
          }
          noteEnv(a, env, ctx, true);
        }
        if (intent === 'explore' && env) log(ctx, a, `在「${env.name}」停下脚步`);
      } else {
        a.x += (dx / dist) * a.speed;
        a.y += (dy / dist) * a.speed;
      }
    }

    // 2) 耗时动作完成结算（张望/休息/进食/交谈各占数拍，期间不决策）
    if ((a.behavior === 'observe' || a.behavior === 'rest' || a.behavior === 'eat' || a.behavior === 'talk') && tick >= a.busyUntil) {
      settleBusy(a, ctx);
    }

    // 3) 情绪衰减（0-100；只影响决策，不参与判定）
    for (const [defId, value] of Object.entries(a.emotions)) {
      const decay = tagDefOf(defId)?.decay ?? 0;
      if (decay > 0) a.emotions[defId] = Math.max(0, value - decay);
    }

    // 4) 启用中的欲望/需求按档案增长
    for (const [defId, d] of Object.entries(a.profile.desires)) {
      if (!d.enabled) continue;
      a.desires[defId] = Math.min(100, desireValue(a, defId) + d.growth);
    }

    // 5) 空闲决策；忙碌中仅紧急层可抢占
    if (a.behavior === 'idle') {
      decide(a, ctx);
    } else if (canPreempt(a, ctx)) {
      preempt(a, ctx);
      decide(a, ctx);
    }

    return a;
  });

  return {
    ...session,
    tick,
    rng,
    actors,
    events: session.events.concat(ctx.events).slice(-SIM_EVENT_CAP),
  };
}
