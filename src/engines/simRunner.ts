/** 🎬 剧情推演 MVP 引擎（纯函数，不依赖 store/React/Prompt）。
 *
 *  本文件只实现「看得见的模拟」最小闭环：舞台上的在场人物按拍自主决定走动 / 张望 / 休息，
 *  节点在画布上移动、行为气泡实时变化、事件滚动。完整设计（定义库、推演档案、欲望实例、
 *  通道图寻路、耗时状态机、叙事化、剧情脚本）见 docs/剧情推演模拟器设计.md，后续在其上叠加。
 *
 *  内置欲望（MVP 固定两项，不可配置）：
 *  - 好奇（curiosity）：每拍增长，到新环境/张望后缓解 → 驱动「探索」与「张望」。
 *  - 疲劳（fatigue）：每拍增长，休息后缓解 → 驱动「休息」。
 *
 *  可复现：mulberry32 seeded RNG，状态存在 session.rng；同 seed + 同初始舞台 = 同事件序列。 */
import type { EnvironmentData, SimBoard, WorkCharacter } from '../types/sim';
import { absPositionOf } from '../stores/graphGeom';

// ── 调参常量（MVP 阶段硬编码；完整版会由推演档案/世界模型常量提供） ──

/** 人物节点估算尺寸：移动边界与「在哪个环境」判定用（真实尺寸由 RF 测量，这里够用） */
export const SIM_CHAR_W = 84;
export const SIM_CHAR_H = 96;
/** 每拍移动像素 */
export const SIM_SPEED = 70;
export const SIM_CURIOSITY_GROWTH = 0.9;
export const SIM_FATIGUE_GROWTH = 0.5;
/** 疲劳阈值 → 去休息；好奇阈值 → 探索/张望 */
export const SIM_FATIGUE_REST = 65;
export const SIM_CURIOSITY_EXPLORE = 45;
export const SIM_CURIOSITY_OBSERVE = 28;
export const SIM_REST_TICKS = 3;
/** 事件日志环形上限 */
export const SIM_EVENT_CAP = 120;

export type SimBehavior = 'idle' | 'move' | 'observe' | 'rest';
export type SimMoveIntent = 'wander' | 'explore';

export const SIM_BEHAVIOR_LABELS: Record<SimBehavior, string> = {
  idle: '待机',
  move: '走动',
  observe: '张望',
  rest: '休息',
};

export interface SimEnvBox {
  id: string;
  name: string;
  /** 绝对坐标（已含父链偏移） */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SimActor {
  /** 画布人物放置节点 id（渲染定位用） */
  nodeId: string;
  characterId: string;
  name: string;
  /** 人物节点左上角绝对坐标 */
  x: number;
  y: number;
  /** 当前所在环境（中心点落在哪个环境盒内） */
  envId: string | null;
  behavior: SimBehavior;
  intent?: SimMoveIntent;
  target: { x: number; y: number } | null;
  /** observe / rest 的完成拍 */
  busyUntil: number;
  curiosity: number;
  fatigue: number;
  /** 到过/张望过的环境（新颖度判定） */
  knownEnvIds: string[];
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
  return {
    id: n.id,
    name: ((n.data as EnvironmentData).name || '').trim() || '未命名环境',
    x: abs.x,
    y: abs.y,
    w: n.width ?? n.measured?.width ?? 220,
    h: n.height ?? n.measured?.height ?? 150,
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

/** 环境内随机落点（避开人物尺寸，留 12px 边距） */
function randomPointIn(b: SimEnvBox, rand: () => number): { x: number; y: number } {
  const maxX = Math.max(b.x + 12, b.x + b.w - SIM_CHAR_W - 12);
  const maxY = Math.max(b.y + 12, b.y + b.h - SIM_CHAR_H - 12);
  return {
    x: b.x + 12 + rand() * Math.max(0, maxX - (b.x + 12)),
    y: b.y + 12 + rand() * Math.max(0, maxY - (b.y + 12)),
  };
}

// ── 建世界 / 建会话 ──

/** 从舞台画布抽世界：环境盒（绝对坐标）。人物只由调用方按放置读取。 */
export function buildSimWorld(board: SimBoard): SimEnvBox[] {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const envs: SimEnvBox[] = [];
  for (const n of board.nodes) {
    if (n.data.kind !== 'environment') continue;
    envs.push(envBox(n, absPositionOf(n, byId)));
  }
  return envs;
}

export type CreateSessionResult = { session: SimSession } | { error: string };

/** 建会话：把舞台上的全部人物放置冻结成 actor（初始位置/所在环境/内置欲望初值）。
 *  舞台没有人物 → 返回可展示的错误文案。 */
export function createSimSession(
  board: SimBoard,
  characters: Record<string, WorkCharacter>,
  seed: number = (Date.now() >>> 0) || 1,
): CreateSessionResult {
  const envs = buildSimWorld(board);
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const actors: SimActor[] = [];
  let rng = seed;
  const rand = () => {
    const r = nextRand(rng);
    rng = r.state;
    return r.value;
  };
  for (const n of board.nodes) {
    if (n.data.kind !== 'character') continue;
    const abs = absPositionOf(n, byId);
    const cx = abs.x + SIM_CHAR_W / 2;
    const cy = abs.y + SIM_CHAR_H / 2;
    const env = envAtPoint(envs, cx, cy);
    const name = (characters[n.data.characterId]?.name || '').trim() || '未命名人物';
    actors.push({
      nodeId: n.id,
      characterId: n.data.characterId,
      name,
      x: abs.x,
      y: abs.y,
      envId: env?.id ?? null,
      behavior: 'idle',
      target: null,
      busyUntil: 0,
      // 初值带一点随机差：同一份舞台两次运行也会走出不同但可复现的轨迹
      curiosity: 15 + Math.round(rand() * 30),
      fatigue: Math.round(rand() * 20),
      knownEnvIds: env ? [env.id] : [],
    });
  }
  if (!actors.length) {
    return { error: '舞台上还没有人物：先在舞台画布放置人物节点，再开始推演。' };
  }
  return {
    session: {
      boardId: board.id,
      tick: 0,
      seed,
      rng,
      envs,
      actors,
      events: [
        {
          id: `${seed}-0`,
          tick: 0,
          actorName: '系统',
          text: `推演开始：${actors.length} 人进入舞台${envs.length ? `，${envs.length} 个环境` : '（未布置环境，人物将在原地小范围走动）'}`,
        },
      ],
    },
  };
}

// ── 单拍推进 ──

interface StepCtx {
  envs: SimEnvBox[];
  tick: number;
  events: SimEvent[];
  rand: () => number;
}

function log(ctx: StepCtx, actor: SimActor, text: string) {
  ctx.events.push({ id: `${ctx.tick}-${ctx.events.length}-${actor.nodeId}`, tick: ctx.tick, actorName: actor.name, text });
}

/** 决策辅助：可去的其它环境（优先没去过的） */
function pickTargetEnv(a: SimActor, ctx: StepCtx): { env: SimEnvBox; novel: boolean } | null {
  const others = ctx.envs.filter((e) => e.id !== a.envId);
  if (!others.length) return null;
  const unknown = others.filter((e) => !a.knownEnvIds.includes(e.id));
  const pool = unknown.length && ctx.rand() < 0.7 ? unknown : others;
  return { env: pool[Math.floor(ctx.rand() * pool.length)], novel: unknown.length > 0 };
}

function decide(a: SimActor, ctx: StepCtx) {
  // 疲劳优先：累了就坐一会儿
  if (a.fatigue >= SIM_FATIGUE_REST) {
    a.behavior = 'rest';
    a.busyUntil = ctx.tick + SIM_REST_TICKS;
    log(ctx, a, '累了，找个地方坐下休息');
    return;
  }
  // 好奇：去没去过的地方
  if (a.curiosity >= SIM_CURIOSITY_EXPLORE) {
    const t = pickTargetEnv(a, ctx);
    if (t) {
      const p = randomPointIn(t.env, ctx.rand);
      a.behavior = 'move';
      a.intent = 'explore';
      a.target = p;
      log(ctx, a, `好奇地朝「${t.env.name}」走去`);
      return;
    }
  }
  // 张望：小幅缓解好奇
  if (a.curiosity >= SIM_CURIOSITY_OBSERVE && ctx.rand() < 0.3) {
    a.behavior = 'observe';
    a.busyUntil = ctx.tick + 1;
    log(ctx, a, `停下脚步张望（${a.envId ? ctx.envs.find((e) => e.id === a.envId)?.name ?? '' : '四周'}）`);
    return;
  }
  // 保底：在当前环境里走动（没有环境时在初始位置附近小范围走动）
  const here = a.envId ? ctx.envs.find((e) => e.id === a.envId) : undefined;
  const bounds: SimEnvBox = here ?? { id: '', name: '', x: a.x - 160, y: a.y - 120, w: SIM_CHAR_W + 320, h: SIM_CHAR_H + 240 };
  a.behavior = 'move';
  a.intent = 'wander';
  a.target = randomPointIn(bounds, ctx.rand);
  if (ctx.rand() < 0.25) log(ctx, a, '在原地附近走动');
}

/** 前进一拍：移动推进 → 动作结算 → 欲望增长 → 决策。返回新 session（不修改入参）。 */
export function stepSimSession(session: SimSession): SimSession {
  let rng = session.rng;
  const rand = () => {
    const r = nextRand(rng);
    rng = r.state;
    return r.value;
  };
  const tick = session.tick + 1;
  const ctx: StepCtx = { envs: session.envs, tick, events: [], rand };

  const actors = session.actors.map((src) => {
    const a: SimActor = { ...src, knownEnvIds: src.knownEnvIds.slice() };

    // 1) 移动推进（到达才结算，途中不产生事件）
    if (a.behavior === 'move' && a.target) {
      const dx = a.target.x - a.x;
      const dy = a.target.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= SIM_SPEED) {
        a.x = a.target.x;
        a.y = a.target.y;
        a.target = null;
        a.behavior = 'idle';
        const env = envAtPoint(ctx.envs, a.x + SIM_CHAR_W / 2, a.y + SIM_CHAR_H / 2);
        if (env) {
          a.envId = env.id;
          if (!a.knownEnvIds.includes(env.id)) {
            a.knownEnvIds.push(env.id);
            a.curiosity = Math.max(0, a.curiosity - 30);
            log(ctx, a, `到了「${env.name}」，四处是新东西`);
          }
        }
        const intent = a.intent;
        a.intent = undefined;
        if (intent === 'explore' && env) log(ctx, a, `在「${env.name}」停下脚步`);
      } else {
        a.x += (dx / dist) * SIM_SPEED;
        a.y += (dy / dist) * SIM_SPEED;
      }
    }

    // 2) 耗时动作完成结算（张望/休息各占数拍，期间不决策）
    if ((a.behavior === 'observe' || a.behavior === 'rest') && tick >= a.busyUntil) {
      if (a.behavior === 'rest') {
        a.fatigue = Math.max(0, a.fatigue - 55);
        log(ctx, a, '休息结束，精神恢复了');
      } else {
        a.curiosity = Math.max(0, a.curiosity - 18);
      }
      a.behavior = 'idle';
    }

    // 3) 内置欲望增长
    a.curiosity = Math.min(100, a.curiosity + SIM_CURIOSITY_GROWTH);
    a.fatigue = Math.min(100, a.fatigue + SIM_FATIGUE_GROWTH);

    // 4) 空闲才决策
    if (a.behavior === 'idle') decide(a, ctx);

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
