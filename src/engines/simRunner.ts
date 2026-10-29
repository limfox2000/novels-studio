/** 🎬 剧情推演引擎（纯函数，不依赖 store/React/Prompt）——统一标签内核（设计文档 §19）。
 *
 *  **内核零内容**：本文件不出现任何题材分支。引擎只理解六种原语：
 *  1. 移动：模式（walk/fly）+ 速度 + 通行性——trait 定义的 revokes/grantsMove；
 *  2. 需求：0-100 + 每拍增长 + 阈值 + 紧急 + 缓解（schema 的 need 定义 + 档案实例）；
 *  3. 情绪：0-100 + 每拍衰减 + 崩溃阈值（emotion 定义）；
 *  4. 交互/affordance：环境标签 → 「哪项需求 + 耗时 + 缓解 + 可用次数/时段」；
 *  5. 感知：visibility（always/near/concealed）+ 感知半径 + 认知过期（知识 TTL）；
 *  6. 反应：观察到标签 + 自身条件 → 情绪Δ/需求Δ/立场 + 事件。
 *
 *  决策管线四层（§19.4）：紧急（需求≥emergency / 情绪触发的立场）→ 意图记忆 →
 *  常规（需求阈值）→ 社交·环境（有向关系立场）→ 待机；仅紧急层可抢占进行中的动作。
 *
 *  空间：画布连线 = 环境通道（portal）；有通道走显式拓扑 + BFS 寻路，没有则降级直连。
 *  时间：会话时钟（第几天 + 相位），affordance 可按相位门控。
 *  可复现：mulberry32 seeded RNG；定义/知识/关系遍历一律排序；同输入同事件序列。
 *  推演只读作品数据：本文件不写回 boards/characters/simProfiles/simSchema。 */
import type { SimBoard, SimProfile, SimRelation, SimSchema, SimStanceKind, SimTagDef, WorkCharacter } from '../types/sim';
import {
  EMPTY_SIM_SCHEMA,
  affordanceActiveIn,
  indexSimSchema,
  relationTagsOf,
  relationValueOf,
  simClockAt,
  type SimClock,
  type SimSchemaIndex,
} from '../stores/simSchema';
import { defaultSimProfile, observeTicks, resolveSimProfile, type ResolvedSimProfile } from '../stores/simProfiles';
import { absPositionOf } from '../stores/graphGeom';
import {
  SIM_CHAR_H,
  SIM_CHAR_W,
  buildSimWorld,
  distToBox,
  envAtPoint,
  findEnvPath,
  randomPointIn,
  walkableBox,
  type SimEnvBox,
  type SimPortal,
  type SimPortalMode,
  type SimRouteStep,
  type SimWorld,
} from './simWorld';

export { SIM_CHAR_H, SIM_CHAR_W };

// ── 内核节拍常量（与题材无关） ──

/** 事件日志环形上限 */
export const SIM_EVENT_CAP = 120;
/** 每人知识条目预算（C4） */
export const SIM_KNOWLEDGE_CAP = 64;
/** 认知过期：多少拍没再确认就遗忘（可过时认知） */
export const SIM_KNOWLEDGE_TTL = 120;
/** 每拍候选上限（C4） */
export const SIM_CANDIDATE_CAP = 20;
/** 靠近发现隐藏标签的距离（concealed） */
export const SIM_CLOSE_DISTANCE = 150;
/** 交谈距离：进入该距离直接交谈，否则先靠近 */
export const SIM_TALK_DISTANCE = 110;
/** 社交站位：靠近到目标身边这个距离 */
const SIM_APPROACH_DISTANCE = 90;
/** 躲避后退距离 */
const SIM_AVOID_DISTANCE = 220;
/** 到达判定余量 */
const SIM_ARRIVE_EPS = 2;
/** 待机时张望概率 */
const SIM_IDLE_OBSERVE_CHANCE = 0.18;
/** 同一句提示的最小间隔（拍） */
const NOTE_COOLDOWN = 12;
/** 紧急抢占冷却（拍） */
const SIM_PREEMPT_COOLDOWN = 4;
/** 无情绪门槛的立场过期时间（拍） */
const SIM_STANCE_TTL = 60;
/** 无环境可走时的小范围活动半径 */
const SIM_FREELANCE_RADIUS = 160;

export type SimBehavior = 'idle' | 'move' | 'observe' | 'interact' | 'social' | 'avoid';
export type SimMoveIntent = 'wander' | 'explore' | 'need' | 'social' | 'avoid';

export const SIM_BEHAVIOR_LABELS: Record<SimBehavior, string> = {
  idle: '待机',
  move: '走动',
  observe: '张望',
  interact: '交互',
  social: '社交',
  avoid: '躲避',
};

/** 认知：tagId → 最近一次确认拍 */
export type SimMemory = Record<string, number>;

export interface SimWaypoint {
  x: number;
  y: number;
  /** 穿过通道后的额外等待（拍） */
  wait?: number;
}

export interface SimBusyAction {
  kind: 'observe' | 'interact' | 'social';
  /** 目标需求（observe/interact） */
  needId?: string;
  /** affordance 定义 id（interact） */
  defId?: string;
  /** 交谈对象 nodeId（social） */
  targetId?: string;
  /** interact 缓解量 */
  relief?: number;
}

export interface SimStanceState {
  kind: SimStanceKind;
  targetId: string;
  /** 立场由哪个情绪门控（低于 clearThreshold 清除） */
  emotionId?: string;
  /** 无情绪门控时的过期拍 */
  expiresAt?: number;
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
  /** 当前路线（逐路点前进；空=无路线） */
  route: SimWaypoint[];
  /** 穿过通道后的等待截止拍 */
  routeWaitUntil: number;
  /** 路线终点环境（到达后结算） */
  routeTargetEnvId?: string;
  /** 路线对应的需求（到达后优先满足） */
  routeNeedId?: string;
  busyUntil: number;
  busySince: number;
  busy?: SimBusyAction;
  /** 建会话时冻结的推演档案 */
  profile: ResolvedSimProfile;
  /** 需求当前值（defId → 0-100） */
  needs: Record<string, number>;
  /** 情绪当前值（defId → 0-100） */
  emotions: Record<string, number>;
  /** 人物 trait 标签 id（排序） */
  traits: string[];
  moveMode: 'walk' | 'fly';
  movable: boolean;
  speed: number;
  /** 到过的环境（新颖度判定） */
  visitedEnvIds: string[];
  /** 认知：环境标签 / 人物标签（可过期，C4 预算） */
  knowledge: { envs: Record<string, SimMemory>; actors: Record<string, SimMemory> };
  /** 反应立场（reactionId → 目标） */
  stances: Record<string, SimStanceState>;
  /** 被紧急层抢占的进行中动作 */
  pendingIntent?: { kind: 'observe' | 'interact'; needId?: string; defId?: string } | null;
  lastPreemptTick: number;
  /** 同类提示冷却 */
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
  rng: number;
  /** 冻结的定义库索引 */
  index: SimSchemaIndex;
  envs: SimEnvBox[];
  portals: SimPortal[];
  portalMode: SimPortalMode;
  actors: SimActor[];
  relations: SimRelation[];
  events: SimEvent[];
  clock: SimClock;
  /** affordance 剩余次数：`envId\0tagId` → 剩余（缺省=定义 uses） */
  envUses: Record<string, number>;
}

// ── 随机数：mulberry32（与设计文档一致） ──

function nextRand(state: number): { value: number; state: number } {
  let a = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: a };
}

// ── 几何小工具 ──

function centerOf(a: { x: number; y: number }): { x: number; y: number } {
  return { x: a.x + SIM_CHAR_W / 2, y: a.y + SIM_CHAR_H / 2 };
}

function actorDistance(a: SimActor, b: SimActor): number {
  return Math.hypot(centerOf(a).x - centerOf(b).x, centerOf(a).y - centerOf(b).y);
}

function boxOf(envs: SimEnvBox[], id: string | null | undefined): SimEnvBox | undefined {
  return id ? envs.find((e) => e.id === id) : undefined;
}

function inEnv(a: SimActor, ctx: StepCtx): SimEnvBox | undefined {
  return walkableBox(boxOf(ctx.envs, a.envId), ctx.envs);
}

// ── 移动模式（原语 1：能力是许可，撤销显式） ──

export function resolveSimMovement(
  traits: string[],
  baseSpeed: number,
  index: SimSchemaIndex,
): { movable: boolean; mode: 'walk' | 'fly'; speed: number } {
  let walk = true;
  let flyFactor: number | null = null;
  for (const id of [...traits].sort()) {
    const def = index.tagsById.get(id);
    if (!def || def.role !== 'trait') continue;
    if (def.revokes?.includes('move:walk')) walk = false;
    if (def.grantsMove?.mode === 'fly') {
      flyFactor = Math.max(flyFactor ?? 0, def.grantsMove.speedMultiplier);
    }
  }
  const mode = flyFactor !== null ? 'fly' : 'walk';
  const movable = walk || flyFactor !== null;
  const speed = Math.max(1, Math.round(flyFactor !== null ? baseSpeed * flyFactor : baseSpeed));
  return { movable, mode, speed };
}

// ── 建会话 ──

export type CreateSessionResult = { session: SimSession } | { error: string };

/** 建会话：把舞台上的全部人物放置冻结成 actor（位置/所在环境/档案/标签/需求/情绪/认知）。
 *  schema 缺省为空定义库：人物仍会走动/张望，但不产生任何题材内容。
 *  relations 与 seed 位置兼容旧调用（第四参为 number 时视为 seed）。 */
export function createSimSession(
  board: SimBoard,
  characters: Record<string, WorkCharacter>,
  profiles: Record<string, SimProfile> = {},
  relationsOrSeed: SimRelation[] | number = [],
  seedArg?: number,
  schema: SimSchema = EMPTY_SIM_SCHEMA,
): CreateSessionResult {
  const relations = Array.isArray(relationsOrSeed) ? relationsOrSeed : [];
  const seed = typeof relationsOrSeed === 'number' ? relationsOrSeed : (seedArg ?? ((Date.now() >>> 0) || 1));
  const index = indexSimSchema(schema);
  const world = buildSimWorld(board);
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const actors: SimActor[] = [];
  const envUses: Record<string, number> = {};
  let rng = seed;
  for (const n of board.nodes) {
    if (n.data.kind !== 'character') continue;
    const abs = absPositionOf(n, byId);
    const cx = abs.x + SIM_CHAR_W / 2;
    const cy = abs.y + SIM_CHAR_H / 2;
    const env = envAtPoint(world.envs, cx, cy);
    const characterId = n.data.characterId;
    const name = (characters[characterId]?.name || '').trim() || '未命名人物';
    const profile = resolveSimProfile(profiles[characterId] ?? defaultSimProfile(characterId, index), index);
    const needs: Record<string, number> = {};
    for (const [defId, d] of Object.entries(profile.needs)) needs[defId] = d.enabled ? d.value : 0;
    const emotions: Record<string, number> = {};
    for (const [defId, d] of Object.entries(profile.emotions)) emotions[defId] = d.value;
    const movement = resolveSimMovement(profile.traits, profile.capabilities.speed, index);
    actors.push({
      nodeId: n.id,
      characterId,
      name,
      x: abs.x,
      y: abs.y,
      envId: env?.id ?? null,
      behavior: 'idle',
      route: [],
      routeWaitUntil: 0,
      busyUntil: 0,
      busySince: 0,
      profile,
      needs,
      emotions,
      traits: profile.traits.slice(),
      moveMode: movement.mode,
      movable: movement.movable,
      speed: movement.speed,
      visitedEnvIds: env ? [env.id] : [],
      // 初始认知为空：第一拍感知到的东西才算「见过」（反应在第一拍触发）
      knowledge: { envs: {}, actors: {} },
      stances: {},
      pendingIntent: null,
      lastPreemptTick: -999,
      notedAt: {},
    });
  }
  if (!actors.length) {
    return { error: '舞台上还没有人物：先在舞台画布放置人物节点，再开始推演。' };
  }
  // 初始化 affordance 次数（按定义 uses；undefined=不限，不记录）
  for (const env of world.envs) {
    for (const tagId of env.tags) {
      const def = index.tagsById.get(tagId);
      const uses = def?.affordance?.uses;
      if (uses !== undefined) envUses[`${env.id}\u0000${tagId}`] = uses;
    }
  }
  const events: SimEvent[] = [
    {
      id: `${seed}-0`,
      tick: 0,
      actorName: '系统',
      text: `推演开始：${actors.length} 人进入舞台${world.envs.length ? `，${world.envs.length} 个环境` : '（未布置环境）'}${
        world.portals.length ? `，${world.portals.length} 条通道` : '，无通道（降级直连）'
      }`,
    },
  ];
  for (const a of actors) {
    if (!a.movable) {
      events.push({ id: `${seed}-0-${a.nodeId}`, tick: 0, actorName: a.name, text: '无法移动：移动能力被标签撤销' });
    }
  }
  if (!index.tagIds.length) {
    events.push({
      id: `${seed}-0-empty`,
      tick: 0,
      actorName: '系统',
      text: '定义库为空：人物只会走动/张望；可在「设计」页添加标签与需求',
    });
  }
  return {
    session: {
      boardId: board.id,
      tick: 0,
      seed,
      rng,
      index,
      envs: world.envs,
      portals: world.portals,
      portalMode: world.mode,
      actors,
      relations: relations.map((r) => ({
        from: r.from,
        to: r.to,
        tags: [...r.tags].sort(),
        ...(r.value !== undefined ? { value: r.value } : {}),
      })),
      events,
      clock: simClockAt(index, 0),
      envUses,
    },
  };
}

// ── 拍上下文 ──

interface StepCtx {
  world: SimWorld;
  envs: SimEnvBox[];
  portals: SimPortal[];
  mode: SimPortalMode;
  actors: SimActor[];
  relations: SimRelation[];
  index: SimSchemaIndex;
  tick: number;
  clock: SimClock;
  events: SimEvent[];
  rand: () => number;
  envUses: Record<string, number>;
}

function log(ctx: StepCtx, actor: SimActor, text: string) {
  ctx.events.push({ id: `${ctx.tick}-${ctx.events.length}-${actor.nodeId}`, tick: ctx.tick, actorName: actor.name, text });
}

function noteOnce(a: SimActor, ctx: StepCtx, key: string, text: string) {
  const last = a.notedAt[key] ?? -999;
  if (ctx.tick - last < NOTE_COOLDOWN) return;
  a.notedAt[key] = ctx.tick;
  log(ctx, a, text);
}

// ── 认知（原语 5） ──

function remember(memory: SimMemory, tags: string[], tick: number): string[] {
  const learned: string[] = [];
  for (const t of tags) {
    if (memory[t] === undefined) learned.push(t);
    memory[t] = tick;
  }
  return learned;
}

/** 认知过期 + 预算（C4）：先按 TTL 删，再超 64 条按最久未确认淘汰 */
function pruneKnowledge(a: SimActor, tick: number) {
  let total = 0;
  for (const map of [a.knowledge.envs, a.knowledge.actors]) {
    for (const [id, memory] of Object.entries(map)) {
      for (const [tag, seen] of Object.entries(memory)) {
        if (tick - seen > SIM_KNOWLEDGE_TTL) delete memory[tag];
      }
      if (!Object.keys(memory).length) delete map[id];
      total += Object.keys(memory).length;
    }
  }
  if (total <= SIM_KNOWLEDGE_CAP) return;
  const entries: { map: SimMemory; tag: string; seen: number; key: string }[] = [];
  for (const [id, memory] of Object.entries(a.knowledge.envs)) {
    for (const [tag, seen] of Object.entries(memory)) entries.push({ map: memory, tag, seen, key: `e:${id}:${tag}` });
  }
  for (const [id, memory] of Object.entries(a.knowledge.actors)) {
    for (const [tag, seen] of Object.entries(memory)) entries.push({ map: memory, tag, seen, key: `a:${id}:${tag}` });
  }
  entries.sort((p, q) => p.seen - q.seen || (p.key < q.key ? -1 : 1));
  for (const e of entries.slice(0, entries.length - SIM_KNOWLEDGE_CAP)) delete e.map[e.tag];
}

/** 认知是否已确认过某标签（未过期） */
function knows(a: SimActor, kind: 'envs' | 'actors', id: string, tag: string, tick: number): boolean {
  const seen = a.knowledge[kind][id]?.[tag];
  return seen !== undefined && tick - seen <= SIM_KNOWLEDGE_TTL;
}

// ── 需求/情绪读写 ──

function needValue(a: SimActor, id: string): number {
  return a.needs[id] ?? 0;
}

function reliefNeed(a: SimActor, id: string, amount: number) {
  if (!a.profile.needs[id]?.enabled) return;
  a.needs[id] = Math.max(0, needValue(a, id) - Math.max(0, amount));
}

function emotionValue(a: SimActor, id: string): number {
  return a.emotions[id] ?? 0;
}

function addEmotion(a: SimActor, id: string, delta: number) {
  if (!a.profile.emotions[id]) return;
  a.emotions[id] = Math.min(100, Math.max(0, emotionValue(a, id) + delta));
}

function addNeed(a: SimActor, id: string, delta: number) {
  if (!a.profile.needs[id]?.enabled) return;
  a.needs[id] = Math.min(100, Math.max(0, needValue(a, id) + delta));
}

// ── affordance（原语 4） ──

interface AffordanceHit {
  env: SimEnvBox;
  def: SimTagDef;
}

/** 某环境是否提供某需求的可用交互（排除相位不符/次数用尽） */
function affordanceOf(env: SimEnvBox | undefined, needId: string, ctx: StepCtx): SimTagDef | undefined {
  if (!env) return undefined;
  for (const tagId of env.tags) {
    const def = ctx.index.tagsById.get(tagId);
    if (!def?.affordance || def.affordance.needId !== needId) continue;
    if (!affordanceActiveIn(def, ctx.index, ctx.clock.phaseId)) continue;
    const uses = ctx.envUses[`${env.id}\u0000${tagId}`];
    if (uses !== undefined && uses <= 0) continue;
    return def;
  }
  return undefined;
}

/** 当前位置（含床/物品向上爬父容器）可用的 affordance */
function affordanceAt(a: SimActor, needId: string, ctx: StepCtx): AffordanceHit | undefined {
  const here = boxOf(ctx.envs, a.envId);
  const own = affordanceOf(here, needId, ctx);
  if (own) return { env: here!, def: own };
  const up = walkableBox(here, ctx.envs);
  const inherited = affordanceOf(up, needId, ctx);
  return inherited ? { env: up!, def: inherited } : undefined;
}

/** 认知里知道、当前可达、且此刻可用的 affordance 环境（按路径跳数 + id 排序） */
function findKnownAffordanceEnv(a: SimActor, needId: string, ctx: StepCtx): { env: SimEnvBox; def: SimTagDef; path: SimRouteStep[] } | undefined {
  const candidates: { env: SimEnvBox; def: SimTagDef; path: SimRouteStep[] }[] = [];
  for (const envId of Object.keys(a.knowledge.envs).sort()) {
    const env = boxOf(ctx.envs, envId);
    if (!env) continue;
    const def = affordanceOf(env, needId, ctx);
    if (!def) continue;
    if (a.envId === env.id) {
      candidates.push({ env, def, path: [] });
      continue;
    }
    const path = findEnvPath(ctx.world, a.envId ?? '', env.id);
    if (!path) continue;
    candidates.push({ env, def, path });
  }
  candidates.sort((p, q) => p.path.length - q.path.length || (p.env.id < q.env.id ? -1 : 1));
  return candidates[0];
}

/** 知道某需求的环境交互、但此刻不可用（相位/次数）——紧急层的解释文案用 */
function blockedAffordance(a: SimActor, needId: string, ctx: StepCtx): SimTagDef | undefined {
  for (const envId of Object.keys(a.knowledge.envs).sort()) {
    const env = boxOf(ctx.envs, envId);
    if (!env) continue;
    for (const tagId of env.tags) {
      const def = ctx.index.tagsById.get(tagId);
      if (!def?.affordance || def.affordance.needId !== needId) continue;
      const uses = ctx.envUses[`${env.id}\u0000${tagId}`];
      if ((uses !== undefined && uses <= 0) || !affordanceActiveIn(def, ctx.index, ctx.clock.phaseId)) return def;
    }
  }
  return undefined;
}

// ── 反应（原语 6） ──

function reactionText(ruleText: string | undefined, fallback: string, other?: SimActor, env?: SimEnvBox, tagName?: string): string {
  const t = ruleText || fallback;
  return t
    .replace(/\{target\}/g, other?.name ?? '')
    .replace(/\{env\}/g, env?.name ?? '')
    .replace(/\{tag\}/g, tagName ?? '');
}

function applyReactions(a: SimActor, tagId: string, ctx: StepCtx, other?: SimActor, env?: SimEnvBox) {
  const rules = ctx.index.reactionsByTrigger.get(tagId) ?? [];
  const def = ctx.index.tagsById.get(tagId);
  for (const rule of rules) {
    if (rule.triggerScope === 'actor' && !other) continue;
    if (rule.triggerScope === 'env' && !env) continue;
    if (rule.selfTag && !a.traits.includes(rule.selfTag)) continue;
    const key = `rea:${rule.id}:${other?.nodeId ?? env?.id ?? ''}`;
    const last = a.notedAt[key] ?? -999;
    const cooldown = rule.cooldown ?? 0;
    if (cooldown && ctx.tick - last < cooldown) continue;
    a.notedAt[key] = ctx.tick;
    if (rule.emotion) addEmotion(a, rule.emotion.defId, rule.emotion.delta);
    if (rule.need) addNeed(a, rule.need.defId, rule.need.delta);
    if (rule.stance) {
      if (other) {
        const gate = rule.stance.emotionRef ?? rule.emotion?.defId;
        a.stances[rule.id] = {
          kind: rule.stance.kind,
          targetId: other.nodeId,
          ...(gate ? { emotionId: gate } : { expiresAt: ctx.tick + SIM_STANCE_TTL }),
        };
      }
    }
    log(
      ctx,
      a,
      reactionText(
        rule.text,
        other ? `注意到「${other.name}」的「${def?.name ?? tagId}」` : `注意到「${env?.name ?? ''}」的「${def?.name ?? tagId}」`,
        other,
        env,
        def?.name,
      ),
    );
  }
}

// ── 感知 ──

/** 认识环境标签：新学到的标签触发环境反应（已经知道的不重复触发） */
function learnEnvTags(a: SimActor, env: SimEnvBox, ctx: StepCtx) {
  if (!env.tags.length) return;
  const memory = a.knowledge.envs[env.id] ?? (a.knowledge.envs[env.id] = {});
  const learned = remember(memory, env.tags, ctx.tick);
  for (const tagId of learned.sort()) applyReactions(a, tagId, ctx, undefined, env);
}

function perceiveEnvs(a: SimActor, ctx: StepCtx) {
  const c = centerOf(a);
  const radius = a.profile.capabilities.perception;
  for (const env of ctx.envs) {
    if (!env.tags.length) continue;
    if (distToBox(c.x, c.y, env) > radius) continue;
    learnEnvTags(a, env, ctx);
  }
}

function perceiveActors(a: SimActor, ctx: StepCtx, viaObserve: boolean) {
  const radius = a.profile.capabilities.perception;
  for (const other of ctx.actors) {
    if (other.nodeId === a.nodeId) continue;
    const dist = actorDistance(a, other);
    if (dist > radius) continue;
    const learned: string[] = [];
    for (const tagId of [...other.traits].sort()) {
      const def = ctx.index.tagsById.get(tagId);
      if (!def) continue;
      const visibility = def.visibility ?? 'always';
      if (visibility === 'near' && dist > radius) continue;
      if (visibility === 'concealed' && !(viaObserve || dist <= SIM_CLOSE_DISTANCE)) continue;
      if (knows(a, 'actors', other.nodeId, tagId, ctx.tick)) continue;
      learned.push(tagId);
    }
    if (!learned.length) continue;
    remember(a.knowledge.actors[other.nodeId] ?? (a.knowledge.actors[other.nodeId] = {}), learned, ctx.tick);
    for (const tagId of learned) applyReactions(a, tagId, ctx, other);
  }
}

/** 进入环境：首次进入 → 新颖度缓解 + 叙事标签首见文案 */
function enterEnv(a: SimActor, env: SimEnvBox, ctx: StepCtx) {
  a.envId = env.id;
  learnEnvTags(a, env, ctx);
  const first = !a.visitedEnvIds.includes(env.id);
  if (first) {
    a.visitedEnvIds.push(env.id);
    for (const need of Object.values(a.profile.needs)) {
      if (need.enabled && need.relievers.novelty) reliefNeed(a, need.def.id, need.relievers.novelty);
    }
  }
  for (const tagId of env.tags) {
    const def = ctx.index.tagsById.get(tagId);
    const text = def?.narrative?.discoverText;
    if (!text) continue;
    const key = `narr:${env.id}:${tagId}`;
    if (a.notedAt[key] !== undefined) continue;
    a.notedAt[key] = ctx.tick;
    log(ctx, a, text.replace(/\{env\}/g, env.name));
  }
}

// ── 动作启动 ──

function startBusy(a: SimActor, ctx: StepCtx, behavior: SimBehavior, busy: SimBusyAction, ticks: number) {
  a.route = [];
  a.routeTargetEnvId = undefined;
  a.routeNeedId = undefined;
  a.intent = undefined;
  a.behavior = behavior;
  a.busy = busy;
  a.busySince = ctx.tick;
  a.busyUntil = ctx.tick + Math.max(1, Math.round(ticks));
}

function startObserve(a: SimActor, ctx: StepCtx, needId?: string) {
  const ticks = observeTicks(a.profile.capabilities.observation);
  startBusy(a, ctx, 'observe', { kind: 'observe', ...(needId ? { needId } : {}) }, ticks);
  const here = boxOf(ctx.envs, a.envId);
  noteOnce(a, ctx, 'observe', `停下脚步张望（${here?.name ?? '四周'}）`);
}

function startInteract(a: SimActor, hit: AffordanceHit, needId: string, ctx: StepCtx) {
  const aff = hit.def.affordance!;
  const needName = ctx.index.tagsById.get(needId)?.name ?? needId;
  startBusy(
    a,
    ctx,
    'interact',
    { kind: 'interact', needId, defId: hit.def.id, relief: aff.relief },
    aff.duration,
  );
  log(ctx, a, `在「${hit.env.name}」使用「${hit.def.name}」（${needName}）`);
}

function startSocial(a: SimActor, other: SimActor, ctx: StepCtx, ticks: number) {
  startBusy(a, ctx, 'social', { kind: 'social', targetId: other.nodeId }, ticks);
  noteOnce(a, ctx, `talk:${other.nodeId}`, `与「${other.name}」交谈起来`);
}

function startRoute(a: SimActor, route: SimWaypoint[], targetEnvId: string, intent: SimMoveIntent, needId: string | undefined, ctx: StepCtx) {
  if (!a.movable || !route.length) return false;
  a.behavior = 'move';
  a.intent = intent;
  a.route = route;
  a.routeWaitUntil = 0;
  a.routeTargetEnvId = targetEnvId;
  a.routeNeedId = needId;
  a.busy = undefined;
  a.busyUntil = 0;
  return true;
}

/** 去某环境：显式拓扑走门链；fly 直线；返回是否成功起步 */
function routeToEnv(a: SimActor, env: SimEnvBox, intent: SimMoveIntent, needId: string | undefined, ctx: StepCtx): boolean {
  if (!a.movable) return false;
  if (a.envId === env.id) {
    // 已在同一环境：直接走到交互点/随机点
    const point = env.etype === 'item' ? { x: env.x + env.w / 2 - SIM_CHAR_W / 2, y: env.y + env.h / 2 - SIM_CHAR_H / 2 } : randomPointIn(env, ctx.rand);
    return startRoute(a, [point], env.id, intent, needId, ctx);
  }
  if (a.moveMode === 'fly') {
    const point = env.etype === 'item' ? { x: env.x + env.w / 2 - SIM_CHAR_W / 2, y: env.y + env.h / 2 - SIM_CHAR_H / 2 } : randomPointIn(env, ctx.rand);
    return startRoute(a, [point], env.id, intent, needId, ctx);
  }
  const path = findEnvPath(ctx.world, a.envId ?? '', env.id);
  if (!path) return false;
  const route: SimWaypoint[] = path.map((step) => ({
    x: step.point.x - SIM_CHAR_W / 2,
    y: step.point.y - SIM_CHAR_H / 2,
    ...(step.wait ? { wait: step.wait } : {}),
  }));
  const finalEnv = walkableBox(env, ctx.envs) ?? env;
  route.push(randomPointIn(finalEnv, ctx.rand));
  return startRoute(a, route, env.id, intent, needId, ctx);
}

function startApproach(a: SimActor, other: SimActor, ctx: StepCtx): boolean {
  if (!a.movable) return false;
  if (a.envId !== other.envId && a.moveMode !== 'fly') {
    const targetEnv = boxOf(ctx.envs, other.envId);
    if (targetEnv) return routeToEnv(a, targetEnv, 'social', undefined, ctx);
  }
  const ca = centerOf(a);
  const cb = centerOf(other);
  const dx = ca.x - cb.x;
  const dy = ca.y - cb.y;
  const dist = Math.hypot(dx, dy) || 1;
  const goal = {
    x: other.x + (dx / dist) * SIM_APPROACH_DISTANCE,
    y: other.y + (dy / dist) * SIM_APPROACH_DISTANCE,
  };
  return startRoute(a, [goal], other.envId ?? '', 'social', undefined, ctx);
}

function startAvoid(a: SimActor, other: SimActor, ctx: StepCtx): boolean {
  if (!a.movable) {
    noteOnce(a, ctx, `avoid:${other.nodeId}`, `无法离开「${other.name}」身边（移动能力被撤销）`);
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
  let goal = { x: a.x + dx * SIM_AVOID_DISTANCE, y: a.y + dy * SIM_AVOID_DISTANCE };
  const here = inEnv(a, ctx);
  if (here) {
    goal = {
      x: Math.min(Math.max(goal.x, here.x + 8), here.x + here.w - SIM_CHAR_W - 8),
      y: Math.min(Math.max(goal.y, here.y + 8), here.y + here.h - SIM_CHAR_H - 8),
    };
  }
  return startRoute(a, [goal], a.envId ?? '', 'avoid', undefined, ctx);
}

// ── 需求满足 ──

function pickNovelEnv(a: SimActor, ctx: StepCtx): SimEnvBox | undefined {
  const targets = ctx.envs
    .filter((e) => e.id !== a.envId && e.etype !== 'bed' && e.etype !== 'item' && !a.visitedEnvIds.includes(e.id))
    .sort((p, q) => (p.id < q.id ? -1 : 1))
    .slice(0, SIM_CANDIDATE_CAP);
  return targets.length ? targets[Math.floor(ctx.rand() * targets.length)] : undefined;
}

function socialTarget(a: SimActor, ctx: StepCtx): SimActor | undefined {
  const radius = a.profile.capabilities.perception;
  const near = ctx.actors
    .filter((o) => o.nodeId !== a.nodeId && actorDistance(a, o) <= radius)
    .sort((p, q) => actorDistance(a, p) - actorDistance(a, q) || (p.nodeId < q.nodeId ? -1 : 1));
  return near[0];
}

/** 满足一项需求：当前位置 affordance → 已知可达 affordance → 非交互缓解（张望/新颖度/社交） */
function satisfyNeed(a: SimActor, needId: string, ctx: StepCtx, urgent: boolean): boolean {
  const need = a.profile.needs[needId];
  if (!need?.enabled) return false;
  if (!urgent && needValue(a, needId) < need.threshold) return false;

  const here = affordanceAt(a, needId, ctx);
  if (here) {
    startInteract(a, here, needId, ctx);
    return true;
  }
  const known = findKnownAffordanceEnv(a, needId, ctx);
  if (known) {
    if (routeToEnv(a, known.env, 'need', needId, ctx)) {
      noteOnce(a, ctx, `go:${needId}:${known.env.id}`, `前往「${known.env.name}」（${need.def.name}）`);
      return true;
    }
    noteOnce(a, ctx, `blocked:${needId}`, `知道「${known.def.name}」在「${known.env.name}」，但过不去`);
  }

  if (need.relievers.observe && !urgent) {
    startObserve(a, ctx, needId);
    return true;
  }
  if (need.relievers.novelty && !urgent) {
    const env = pickNovelEnv(a, ctx);
    if (env && routeToEnv(a, env, 'explore', needId, ctx)) {
      noteOnce(a, ctx, `novelty:${needId}:${env.id}`, `想去没去过的地方看看（${need.def.name}）`);
      return true;
    }
  }
  if (need.relievers.social && !urgent) {
    const other = socialTarget(a, ctx);
    if (other) {
      if (actorDistance(a, other) <= SIM_TALK_DISTANCE) {
        startSocial(a, other, ctx, 2);
        return true;
      }
      if (startApproach(a, other, ctx)) return true;
    }
  }

  if (urgent) {
    const blocked = blockedAffordance(a, needId, ctx);
    if (blocked) noteOnce(a, ctx, `phase:${needId}`, `「${blocked.name}」现在不可用（${need.def.name}）`);
    else noteOnce(a, ctx, `need:${needId}`, `「${need.def.name}」已经很紧迫，但找不到可用办法`);
    a.behavior = 'idle';
    return true;
  }
  return false;
}

// ── 立场/关系 ──

function clearExpiredStances(a: SimActor, ctx: StepCtx) {
  for (const [id, st] of Object.entries(a.stances)) {
    const targetAlive = ctx.actors.some((o) => o.nodeId === st.targetId);
    if (!targetAlive) {
      delete a.stances[id];
      continue;
    }
    if (st.emotionId) {
      const def = a.profile.emotions[st.emotionId];
      if (def && emotionValue(a, st.emotionId) < def.clearThreshold) delete a.stances[id];
    } else if (st.expiresAt !== undefined && ctx.tick >= st.expiresAt) {
      delete a.stances[id];
    }
  }
}

function stanceActive(st: SimStanceState, a: SimActor): boolean {
  if (!st.emotionId) return true;
  const def = a.profile.emotions[st.emotionId];
  if (!def) return true;
  return emotionValue(a, st.emotionId) >= def.breakThreshold;
}

function runStance(a: SimActor, ruleId: string, ctx: StepCtx): boolean {
  const st = a.stances[ruleId];
  if (!st) return false;
  const other = ctx.actors.find((o) => o.nodeId === st.targetId);
  if (!other) {
    delete a.stances[ruleId];
    return false;
  }
  if (st.kind === 'avoid') {
    if (a.behavior === 'avoid' && a.intent === 'avoid') return false;
    return startAvoid(a, other, ctx);
  }
  const d = actorDistance(a, other);
  if (st.kind === 'talk') {
    if (d <= SIM_TALK_DISTANCE) {
      startSocial(a, other, ctx, 2);
      return true;
    }
    return startApproach(a, other, ctx);
  }
  if (d <= SIM_APPROACH_DISTANCE) return false;
  return startApproach(a, other, ctx);
}

/** 有向关系：只读 from=自己、to=对方；多标签按定义优先级取第一个满足数值门槛的立场 */
function relationStance(a: SimActor, other: SimActor, ctx: StepCtx): { defId: string; kind: SimStanceKind; talkDuration: number; talkDistance: number } | undefined {
  const tags = relationTagsOf(ctx.relations, a.characterId, other.characterId);
  if (!tags.length) return undefined;
  const value = relationValueOf(ctx.relations, a.characterId, other.characterId);
  for (const tagId of tags) {
    const def = ctx.index.relationsById.get(tagId);
    if (!def || def.stance === 'none') continue;
    if (value < (def.minValue ?? 0) || value > (def.maxValue ?? 100)) continue;
    return {
      defId: def.id,
      kind: def.stance,
      talkDuration: def.talkDuration ?? 2,
      talkDistance: def.talkDistance ?? SIM_TALK_DISTANCE,
    };
  }
  return undefined;
}

// ── 候选（C4：每拍 ≤20） ──

interface SimCandidate {
  key: string;
  layer: 0 | 1 | 2 | 3;
  priority: number;
  kind: 'need' | 'stance' | 'relation';
  needId?: string;
  stanceRuleId?: string;
  otherId?: string;
  urgent?: boolean;
}

function collectSimCandidates(a: SimActor, ctx: StepCtx): SimCandidate[] {
  const list: SimCandidate[] = [];
  for (const need of Object.values(a.profile.needs)) {
    if (!need.enabled) continue;
    const v = needValue(a, need.def.id);
    if (v >= need.emergency) {
      list.push({ key: `need:${need.def.id}:u`, layer: 0, priority: v, kind: 'need', needId: need.def.id, urgent: true });
    } else if (v >= need.threshold) {
      list.push({ key: `need:${need.def.id}`, layer: 2, priority: v, kind: 'need', needId: need.def.id });
    }
  }
  for (const ruleId of Object.keys(a.stances).sort()) {
    const st = a.stances[ruleId];
    if (!stanceActive(st, a)) continue;
    if (st.kind === 'avoid' && a.behavior === 'avoid') continue;
    const gate = st.emotionId ? emotionValue(a, st.emotionId) : 1;
    list.push({ key: `stance:${ruleId}`, layer: st.kind === 'avoid' ? 0 : 1, priority: gate, kind: 'stance', stanceRuleId: ruleId });
  }
  const radius = a.profile.capabilities.perception;
  for (const other of ctx.actors) {
    if (other.nodeId === a.nodeId) continue;
    if (actorDistance(a, other) > radius) continue;
    const rel = relationStance(a, other, ctx);
    if (!rel) continue;
    list.push({
      key: `rel:${other.nodeId}:${rel.defId}`,
      layer: 3,
      priority: relationValueOf(ctx.relations, a.characterId, other.characterId),
      kind: 'relation',
      otherId: other.nodeId,
    });
  }
  list.sort((p, q) => p.layer - q.layer || q.priority - p.priority || (p.key < q.key ? -1 : 1));
  return list.slice(0, SIM_CANDIDATE_CAP);
}

// ── 决策（四层管线） ──

function idleWander(a: SimActor, ctx: StepCtx) {
  if (!a.movable) {
    a.behavior = 'idle';
    return;
  }
  const here = inEnv(a, ctx);
  const bounds: SimEnvBox =
    here ?? {
      id: '',
      name: '',
      x: a.x - SIM_FREELANCE_RADIUS,
      y: a.y - SIM_FREELANCE_RADIUS,
      w: SIM_CHAR_W + SIM_FREELANCE_RADIUS * 2,
      h: SIM_CHAR_H + SIM_FREELANCE_RADIUS * 2,
      etype: 'area',
      parentId: null,
      tags: [],
      occupiedBy: [],
    };
  startRoute(a, [randomPointIn(bounds, ctx.rand)], bounds.id, 'wander', undefined, ctx);
  if (a.behavior === 'move') a.intent = 'wander';
}

function decide(a: SimActor, ctx: StepCtx) {
  clearExpiredStances(a, ctx);
  const candidates = collectSimCandidates(a, ctx);
  for (const c of candidates) {
    if (c.kind === 'need' && c.needId) {
      if (satisfyNeed(a, c.needId, ctx, c.urgent === true)) return;
    } else if (c.kind === 'stance' && c.stanceRuleId) {
      if (runStance(a, c.stanceRuleId, ctx)) return;
    } else if (c.kind === 'relation' && c.otherId) {
      const other = ctx.actors.find((o) => o.nodeId === c.otherId);
      if (!other) continue;
      const rel = relationStance(a, other, ctx);
      if (!rel) continue;
      const d = actorDistance(a, other);
      if (rel.kind === 'avoid') {
        if (startAvoid(a, other, ctx)) return;
      } else if (rel.kind === 'talk') {
        if (d <= rel.talkDistance) {
          startSocial(a, other, ctx, rel.talkDuration);
          return;
        }
        if (startApproach(a, other, ctx)) return;
      } else if (d > SIM_APPROACH_DISTANCE) {
        if (startApproach(a, other, ctx)) return;
      }
    }
  }
  // 意图记忆：被抢占的张望/交互恢复
  if (a.pendingIntent) {
    const pending = a.pendingIntent;
    a.pendingIntent = null;
    if (pending.kind === 'observe') {
      startObserve(a, ctx, pending.needId);
      return;
    }
    if (pending.kind === 'interact' && pending.needId) {
      const hit = affordanceAt(a, pending.needId, ctx);
      if (hit && (!pending.defId || hit.def.id === pending.defId)) {
        startInteract(a, hit, pending.needId, ctx);
        return;
      }
    }
  }
  // 待机层：低概率张望，否则小范围走动
  if (ctx.rand() < SIM_IDLE_OBSERVE_CHANCE && a.behavior !== 'observe') {
    startObserve(a, ctx);
    return;
  }
  idleWander(a, ctx);
}

/** 紧急事项判定（用于抢占忙碌/移动中的动作） */
function hasUrgent(a: SimActor, ctx: StepCtx): boolean {
  for (const need of Object.values(a.profile.needs)) {
    if (need.enabled && needValue(a, need.def.id) >= need.emergency) return true;
  }
  for (const st of Object.values(a.stances)) {
    if (st.kind === 'avoid' && stanceActive(st, a)) return true;
  }
  return false;
}

function preempt(a: SimActor, ctx: StepCtx) {
  if (a.busy?.kind === 'observe') a.pendingIntent = { kind: 'observe', ...(a.busy.needId ? { needId: a.busy.needId } : {}) };
  else if (a.busy?.kind === 'interact') {
    a.pendingIntent = { kind: 'interact', ...(a.busy.needId ? { needId: a.busy.needId } : {}), ...(a.busy.defId ? { defId: a.busy.defId } : {}) };
  }
  a.route = [];
  a.routeTargetEnvId = undefined;
  a.routeNeedId = undefined;
  a.intent = undefined;
  a.busy = undefined;
  a.behavior = 'idle';
  a.busyUntil = 0;
  a.busySince = 0;
  a.lastPreemptTick = ctx.tick;
}

// ── 拍内推进 ──

/** 沿路线前进；返回是否走完 */
function advanceMovement(a: SimActor, ctx: StepCtx): boolean {
  if (ctx.tick < a.routeWaitUntil) return false;
  if (!a.route.length) return true;
  let budget = a.speed;
  while (a.route.length) {
    const wp = a.route[0];
    const dx = wp.x - a.x;
    const dy = wp.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= Math.max(SIM_ARRIVE_EPS, budget)) {
      a.x = wp.x;
      a.y = wp.y;
      budget -= dist;
      a.route.shift();
      const c = centerOf(a);
      const env = envAtPoint(ctx.envs, c.x, c.y);
      if (env && env.id !== a.envId) enterEnv(a, env, ctx);
      if (wp.wait && wp.wait > 0) {
        a.routeWaitUntil = ctx.tick + wp.wait;
        return false;
      }
      if (budget <= 0) break;
      continue;
    }
    a.x += (dx / dist) * budget;
    a.y += (dy / dist) * budget;
    break;
  }
  return !a.route.length;
}

function settleBusy(a: SimActor, ctx: StepCtx) {
  const busy = a.busy;
  if (!busy) {
    a.behavior = 'idle';
    a.busyUntil = 0;
    return;
  }
  if (busy.kind === 'observe') {
    for (const need of Object.values(a.profile.needs)) {
      if (need.enabled && need.relievers.observe) reliefNeed(a, need.def.id, need.relievers.observe);
    }
    perceiveActors(a, ctx, true);
    log(ctx, a, busy.needId ? `张望了一阵（${ctx.index.tagsById.get(busy.needId)?.name ?? ''}）` : '张望了一阵');
  } else if (busy.kind === 'interact' && busy.needId) {
    // 结算时重新确认环境交互仍然可用（相位/次数/位置）
    const hit = affordanceAt(a, busy.needId, ctx);
    if (hit && (!busy.defId || hit.def.id === busy.defId)) {
      const relief = busy.relief ?? hit.def.affordance?.relief ?? 0;
      reliefNeed(a, busy.needId, relief);
      const key = `${hit.env.id}\u0000${hit.def.id}`;
      if (ctx.envUses[key] !== undefined) ctx.envUses[key] = Math.max(0, ctx.envUses[key] - 1);
      const needName = ctx.index.tagsById.get(busy.needId)?.name ?? busy.needId;
      log(ctx, a, `「${hit.def.name}」完成：${needName} −${Math.round(relief)}`);
    } else {
      noteOnce(a, ctx, `interact-fail:${busy.needId}`, '条件不满足，交互作罢');
    }
  } else if (busy.kind === 'social') {
    for (const need of Object.values(a.profile.needs)) {
      if (need.enabled && need.relievers.social) reliefNeed(a, need.def.id, need.relievers.social);
    }
    const partner = busy.targetId ? ctx.actors.find((o) => o.nodeId === busy.targetId) : undefined;
    if (partner) log(ctx, a, `和「${partner.name}」聊了几句`);
  }
  a.busy = undefined;
  a.busyUntil = 0;
  a.busySince = 0;
  a.behavior = 'idle';
}

/** 前进一拍：时钟/认知 → 移动 → 结算 → 情绪衰减 → 需求增长 → 决策。返回新 session（不修改入参）。 */
export function stepSimSession(session: SimSession): SimSession {
  let rng = session.rng;
  const rand = () => {
    const r = nextRand(rng);
    rng = r.state;
    return r.value;
  };
  const tick = session.tick + 1;
  const clock = simClockAt(session.index, tick);
  // 每拍克隆环境盒：占用/标签运行时态不污染上一拍快照
  const envs: SimEnvBox[] = session.envs.map((e) => ({ ...e, tags: e.tags.slice(), occupiedBy: [] }));
  const ctx: StepCtx = {
    world: { envs, portals: session.portals, mode: session.portalMode },
    envs,
    portals: session.portals,
    mode: session.portalMode,
    actors: session.actors,
    relations: session.relations,
    index: session.index,
    tick,
    clock,
    events: [],
    rand,
    envUses: { ...session.envUses },
  };

  // 占用（每拍按 actor 位置派生；先清空再统计，排序保证确定性）
  for (const env of ctx.envs) env.occupiedBy = [];
  for (const src of session.actors) {
    if (src.envId) boxOf(ctx.envs, src.envId)?.occupiedBy.push(src.nodeId);
  }
  for (const env of ctx.envs) env.occupiedBy.sort();

  const actors = session.actors.map((src) => {
    const a: SimActor = {
      ...src,
      route: src.route.map((w) => ({ ...w })),
      needs: { ...src.needs },
      emotions: { ...src.emotions },
      traits: src.traits.slice(),
      visitedEnvIds: src.visitedEnvIds.slice(),
      knowledge: {
        envs: Object.fromEntries(Object.entries(src.knowledge.envs).map(([k, v]) => [k, { ...v }])),
        actors: Object.fromEntries(Object.entries(src.knowledge.actors).map(([k, v]) => [k, { ...v }])),
      },
      stances: Object.fromEntries(Object.entries(src.stances).map(([k, v]) => [k, { ...v }])),
      notedAt: { ...src.notedAt },
      pendingIntent: src.pendingIntent ?? null,
    };

    // 1) 认知：当前位置 + 感知范围内环境/人物（新学到的标签触发反应）
    const here = envAtPoint(ctx.envs, a.x + SIM_CHAR_W / 2, a.y + SIM_CHAR_H / 2);
    if (here) {
      if (a.envId !== here.id) enterEnv(a, here, ctx);
      else learnEnvTags(a, here, ctx);
    }
    perceiveEnvs(a, ctx);
    perceiveActors(a, ctx, false);

    // 2) 移动推进（走完才进下一步；途中不决策）
    if (a.movable && (a.behavior === 'move' || a.behavior === 'avoid')) {
      const arrived = advanceMovement(a, ctx);
      if (arrived) {
        const targetEnv = a.routeTargetEnvId ? boxOf(ctx.envs, a.routeTargetEnvId) : undefined;
        const intent = a.intent;
        a.routeTargetEnvId = undefined;
        a.routeNeedId = undefined;
        a.intent = undefined;
        a.behavior = 'idle';
        if (targetEnv && intent === 'explore') noteOnce(a, ctx, `arrive:${targetEnv.id}`, `在「${targetEnv.name}」停下脚步`);
      }
    }

    // 3) 耗时动作结算
    if ((a.behavior === 'observe' || a.behavior === 'interact' || a.behavior === 'social') && tick >= a.busyUntil) {
      settleBusy(a, ctx);
    }

    // 4) 情绪衰减（按定义 decay；只影响决策，不参与判定）
    for (const def of ctx.index.emotions) {
      const decay = def.emotion?.decay ?? 0;
      if (decay > 0) a.emotions[def.id] = Math.max(0, emotionValue(a, def.id) - decay);
    }

    // 5) 需求增长
    for (const need of Object.values(a.profile.needs)) {
      if (!need.enabled || !need.growth) continue;
      a.needs[need.def.id] = Math.min(100, needValue(a, need.def.id) + need.growth);
    }

    // 6) 认知过期 + 预算
    pruneKnowledge(a, tick);

    // 7) 决策：空闲 → 完整管线；忙碌/移动中 → 仅紧急层可抢占
    if (a.behavior === 'idle' && !a.route.length) {
      decide(a, ctx);
    } else if (hasUrgent(a, ctx) && tick - a.lastPreemptTick >= SIM_PREEMPT_COOLDOWN) {
      if (a.behavior === 'move' && a.intent === 'need' && a.routeNeedId) {
        // 已在救急路上不打断
        const need = a.profile.needs[a.routeNeedId];
        if (need && needValue(a, a.routeNeedId) >= need.emergency) {
          // 继续走
        } else {
          preempt(a, ctx);
          decide(a, ctx);
        }
      } else if (a.behavior === 'avoid') {
        // 已在躲避中不打断
      } else if (tick - a.busySince >= 2) {
        preempt(a, ctx);
        decide(a, ctx);
      }
    }

    return a;
  });

  // 会话环境盒已被占用刷新（同一对象，随 session 保存）
  return {
    ...session,
    tick,
    rng,
    clock,
    envs: ctx.envs,
    actors,
    envUses: ctx.envUses,
    events: session.events.concat(ctx.events).slice(-SIM_EVENT_CAP),
  };
}
