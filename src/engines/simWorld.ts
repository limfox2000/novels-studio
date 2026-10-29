/** 🗺 推演世界几何与空间拓扑（纯函数）。
 *
 *  环境盒（绝对坐标）来自画布环境节点；通道（portal）来自画布连线（两端都是环境）。
 *  - 有通道 = 显式拓扑：跨容器只走通道；父子环境（房间在建筑里）天然连通；
 *  - 无通道 = 降级拓扑：父↔子 + 同父兄弟直连（旧舞台行为，不需要连线也能跑）。
 *  寻路只做容器级 BFS（最短通道数），不做像素级碰撞；门中点作为路点。
 */
import type { Edge } from '@xyflow/react';
import type { EnvironmentType, SimBoard } from '../types/sim';
import { absPositionOf } from '../stores/graphGeom';

/** 人物节点估算尺寸：移动边界与「在哪个环境」判定用（真实尺寸由 RF 测量，这里够用） */
export const SIM_CHAR_W = 84;
export const SIM_CHAR_H = 96;

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
  /** 🏷 环境标签 id（引擎按 schema 查 affordance / narrative） */
  tags: string[];
  /** 运行时占用（每拍按 actor 所在环境派生，不持久化） */
  occupiedBy: string[];
}

export interface SimPortal {
  id: string;
  from: string;
  to: string;
  name?: string;
  locked: boolean;
  /** 穿过额外耗时（拍） */
  traverseCost: number;
  oneWay: boolean;
  /** 路点（画布绝对坐标）；缺省取两端中心中点 */
  waypoint?: { x: number; y: number };
}

export type SimPortalMode = 'explicit' | 'degraded';

export interface SimWorld {
  envs: SimEnvBox[];
  portals: SimPortal[];
  mode: SimPortalMode;
}

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
    tags: [...(Array.isArray(d.tags) ? d.tags : [])].sort(),
    occupiedBy: [],
  };
}

function portalOf(e: Edge): SimPortal | null {
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (!e.source || !e.target || e.source === e.target) return null;
  const wp = d.waypoint as { x?: unknown; y?: unknown } | undefined;
  const waypoint =
    wp && typeof wp.x === 'number' && Number.isFinite(wp.x) && typeof wp.y === 'number' && Number.isFinite(wp.y)
      ? { x: wp.x, y: wp.y }
      : undefined;
  return {
    id: e.id,
    from: e.source,
    to: e.target,
    ...(typeof d.name === 'string' && d.name.trim() ? { name: d.name.trim() } : {}),
    locked: d.locked === true,
    traverseCost:
      typeof d.traverseCost === 'number' && Number.isFinite(d.traverseCost)
        ? Math.min(10, Math.max(0, Math.round(d.traverseCost)))
        : 0,
    oneWay: d.oneWay === true,
    ...(waypoint ? { waypoint } : {}),
  };
}

/** 从舞台画布抽世界：环境盒（排序）+ 通道 + 拓扑模式 */
export function buildSimWorld(board: SimBoard): SimWorld {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const envs: SimEnvBox[] = [];
  for (const n of board.nodes) {
    if (n.data.kind !== 'environment') continue;
    envs.push(envBox(n, absPositionOf(n, byId)));
  }
  envs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const envIds = new Set(envs.map((e) => e.id));
  const portals: SimPortal[] = [];
  const seen = new Set<string>();
  for (const e of board.edges ?? []) {
    const p = portalOf(e);
    if (!p || !envIds.has(p.from) || !envIds.has(p.to)) continue;
    const key = p.from < p.to ? `${p.from}\u0000${p.to}` : `${p.to}\u0000${p.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    portals.push(p);
  }
  portals.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { envs, portals, mode: portals.length ? 'explicit' : 'degraded' };
}

// ── 几何工具 ──

export function pointInBox(px: number, py: number, b: SimEnvBox): boolean {
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

/** 点到环境矩形的最短距离（在内部为 0） */
export function distToBox(px: number, py: number, b: SimEnvBox): number {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
  const dy = Math.max(b.y - py, 0, py - (b.y + b.h));
  return Math.hypot(dx, dy);
}

/** 环境内随机落点（避开人物尺寸，留 12px 边距） */
export function randomPointIn(b: SimEnvBox, rand: () => number): { x: number; y: number } {
  const maxX = Math.max(b.x + 12, b.x + b.w - SIM_CHAR_W - 12);
  const maxY = Math.max(b.y + 12, b.y + b.h - SIM_CHAR_H - 12);
  return {
    x: b.x + 12 + rand() * Math.max(0, maxX - (b.x + 12)),
    y: b.y + 12 + rand() * Math.max(0, maxY - (b.y + 12)),
  };
}

/** 环境中心（路点用） */
export function envCenter(b: SimEnvBox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** 移动边界：当前若站在床/物品上，向上爬到可走动的容器（房间/建筑…） */
export function walkableBox(env: SimEnvBox | undefined, envs: SimEnvBox[]): SimEnvBox | undefined {
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

// ── 拓扑图与寻路 ──

export interface SimTopologyLink {
  to: string;
  /** 通道 id（父子/兄弟内部连通为 undefined） */
  portalId?: string;
  /** 穿过等待（拍） */
  wait: number;
}

/** 容器级邻接表：父子恒通；降级模式同父兄弟全连；显式模式只走通道 */
export function buildTopology(world: SimWorld): Map<string, SimTopologyLink[]> {
  const links = new Map<string, SimTopologyLink[]>();
  const push = (from: string, to: string, link: Omit<SimTopologyLink, 'to'>) => {
    const list = links.get(from) ?? [];
    list.push({ ...link, to });
    links.set(from, list);
  };
  const envById = new Map(world.envs.map((e) => [e.id, e]));
  // 父子
  for (const env of world.envs) {
    if (!env.parentId || !envById.has(env.parentId)) continue;
    push(env.id, env.parentId, { wait: 0 });
    push(env.parentId, env.id, { wait: 0 });
  }
  // 降级模式：同父兄弟相邻直连
  if (world.mode === 'degraded') {
    const groups = new Map<string, SimEnvBox[]>();
    for (const env of world.envs) {
      const key = env.parentId ?? '';
      const list = groups.get(key) ?? [];
      list.push(env);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (a.id < b.id ? -1 : 1));
      for (let i = 0; i + 1 < list.length; i++) {
        push(list[i].id, list[i + 1].id, { wait: 0 });
        push(list[i + 1].id, list[i].id, { wait: 0 });
      }
    }
  }
  // 通道
  for (const p of world.portals) {
    if (p.locked) continue;
    push(p.from, p.to, { portalId: p.id, wait: p.traverseCost });
    if (!p.oneWay) push(p.to, p.from, { portalId: p.id, wait: p.traverseCost });
  }
  // 清理占位 + 排序（确定性）
  for (const [id, list] of links) {
    const clean = list.filter((l) => l.to && envById.has(l.to));
    clean.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : (a.portalId ?? '') < (b.portalId ?? '') ? -1 : 1));
    links.set(id, clean);
  }
  return links;
}

export interface SimRouteStep {
  envId: string;
  /** 到该环境的路点（画布绝对坐标） */
  point: { x: number; y: number };
  /** 经过的通道（undefined=父子/兄弟内部连通） */
  portalId?: string;
  wait: number;
}

/** 容器级 BFS：返回从 from 到 to 的环境链（不含起点）；不可达返回 null */
export function findEnvPath(world: SimWorld, fromEnvId: string, toEnvId: string): SimRouteStep[] | null {
  if (fromEnvId === toEnvId) return [];
  const links = buildTopology(world);
  const envById = new Map(world.envs.map((e) => [e.id, e]));
  const prev = new Map<string, { from: string; link: SimTopologyLink }>();
  const seen = new Set<string>([fromEnvId]);
  const queue: string[] = [fromEnvId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const link of links.get(cur) ?? []) {
      if (seen.has(link.to)) continue;
      seen.add(link.to);
      prev.set(link.to, { from: cur, link });
      if (link.to === toEnvId) {
        // 回溯
        const chain: { envId: string; link: SimTopologyLink }[] = [];
        let node = toEnvId;
        while (node !== fromEnvId) {
          const p = prev.get(node)!;
          chain.push({ envId: node, link: p.link });
          node = p.from;
        }
        chain.reverse();
        return chain.map(({ envId, link }) => {
          const env = envById.get(envId)!;
          const portal = link.portalId ? world.portals.find((p) => p.id === link.portalId) : undefined;
          return {
            envId,
            // 通道走门中点；父子/兄弟走目标环境中心（近似）
            point: portal?.waypoint ?? envCenter(env),
            ...(portal ? { portalId: portal.id } : {}),
            wait: link.wait,
          };
        });
      }
      queue.push(link.to);
    }
  }
  return null;
}

/** 某环境是否可达（用于「知道但过不去」的判断） */
export function isEnvReachable(world: SimWorld, fromEnvId: string | null, toEnvId: string): boolean {
  if (!fromEnvId) return true;
  return findEnvPath(world, fromEnvId, toEnvId) !== null;
}
