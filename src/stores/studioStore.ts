/**
 * 创作台画布 store（v2.29 多卷画布；persist nc2-sim-v1 v2）：地图式画布。
 *  🗂 boards 是节点唯一权威数据源：默认主画布（main）+ 每卷一张 vol:<volumeId>；activeBoardId 决定 React Flow 渲染哪张。
 *  🧑 人物节点（人名胶囊——面上仅显示人名，基础信息/身份信息在属性面板；zIndex 恒 CHAR_ZINDEX 恒顶层）+
 *  🏗 环境节点（可缩放容器：NodeResizer 写 node.width/height；可嵌套层级——镇>建筑>房间…，RF12 parentId 父子；
 *  v2.18 类型扩 床（容纳人物休息的容器）/物品（非容器标记——告知 AI 此处存在一个东西），按类型清淡配色）。
 *  节点面上**只展示不输入**：属性在左侧面板（SimInspector，顶栏 ⚙ 属性 开关、可关闭、不自动弹出——v2.4）。
 *  嵌套语义：拖拽落点「中心点落入哪个环境节点」即成为其子节点（随父移动），移出回根层；
 *  子节点**不设 expandParent**（否则拖动会自动撑大父容器，中心点永远出不去——v2 踩坑）；
 *  删除父环境时后代提升回根（绝对坐标展开，不丢内容）。规则系统/演进生成的连线语义随后续需求定义（edges 占位）。
 *
 *  旧档兼容：persist v2 没有 boards → merge 把顶层 nodes/edges 迁进 main，并为旧 volumes 补空画布；
 *  version 保持 2（未写 migrate 时升版本会直接丢档）。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type Edge,
} from '@xyflow/react';
import {
  ENV_TYPES,
  SIM_KINDS,
  isContainerEnv,
  type CastRole,
  type ChapterRegion,
  type ChapterSnapshot,
  type CharacterData,
  type CharacterState,
  type EnvironmentData,
  type EnvironmentType,
  type SimBoard,
  type SimChapter,
  type SimData,
  type SimNodeType,
  type SimVolume,
  type SimViewport,
} from '../types/sim';
import { uid } from '../utils/id';
import { sameStringList, sanitizeWritingSkillIds } from '../types/writingSkill';
import { absPositionOf, isDescendantOf, sortParentsFirst } from './graphGeom';
import {
  DEFAULT_BOARD_ID,
  emptyBoard,
  nextVolumeTitle,
  normalizeVolumeTitle,
  sanitizeViewport,
  volumeBoardId,
} from './boardOps';
import { planBoardCopy, type BoardCopyInput, type BoardCopyResult } from './boardCopy';
import {
  buildChapterBoardMap,
  chapterBoardOf,
  removeChapterRegions,
  sanitizeRegionRect,
  sanitizeRegions,
  type ChapterRegionAddResult,
  type ChapterRegionCreateOptions,
  type ChapterRegionPatch,
  type RegionRect,
} from './chapterRegions';
import {
  STATE_LABEL_CAP,
  activeCharacterState,
  initialCharacterData,
  newStateId,
  nextStateLabel,
  sanitizeCharacterData,
  sanitizeStateAge,
  stateLabelTaken,
} from './characterStates';
import {
  applyChapterScene as applyChapterScenePure,
  captureChapterSnapshot as captureSnapshotPure,
  collectSnapshotEnvRefs,
  manualSnapshotEntry,
  refreshChapterSnapshot as refreshSnapshotPure,
  sameSnapshotScene,
  sanitizeChapterSnapshot,
  type ApplyChapterSceneResult,
} from './chapterSnapshots';
import { createManualPersistStorage } from './manualPersistStorage';

export { absPositionOf, isDescendantOf, sortParentsFirst } from './graphGeom';
export {
  DEFAULT_BOARD_ID,
  DEFAULT_BOARD_LABEL,
  boardLabel,
  emptyBoard,
  resolveBoardRef,
  volumeBoardId,
} from './boardOps';
export type { BoardCopyConflict, BoardCopyMode, BoardCopyResult } from './boardCopy';

// ── 常量与几何工具 ──

export const CHAR_ZINDEX = 100; // 人物恒在环境之上
export const ENV_DEFAULT_W = 220;
export const ENV_DEFAULT_H = 150;
export const ENV_MIN_W = 140;
export const ENV_MIN_H = 90;

function pickStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 📜 规则文本兜底：string 直通；短暂对象形态 {world,style}（v2.8 上线当日存档）拼接非空段；其余回空串 */
export function rulesText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as { world?: unknown; style?: unknown };
    return [o.world, o.style].filter((x): x is string => typeof x === 'string' && !!x.trim()).join('\n');
  }
  return '';
}

/** 📚 卷列表兜底（persist 恢复 + 存档载入共用）：重建字段、剔非法项、缺 id 补新 id */
export function sanitizeVolumes(v: unknown): SimVolume[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x, i) => ({
      id: typeof x.id === 'string' && x.id ? x.id : `vol-${i}-${uid()}`,
      title: pickStr(x.title),
      intro: pickStr(x.intro),
    }));
}

/** 📋 章节列表兜底（persist 恢复 + 服务器存档载入共用）：重建字段、剔非法项、缺 id 补新 id */
export function sanitizeChapters(v: unknown): SimChapter[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c, i) => {
      const snapshot = sanitizeChapterSnapshot(c.snapshot);
      const writingSkillIds = sanitizeWritingSkillIds(c.writingSkillIds);
      return {
        id: typeof c.id === 'string' && c.id ? c.id : `ch-${i}-${uid()}`,
        title: pickStr(c.title),
        volumeId: pickStr(c.volumeId),
        requirement: pickStr(c.requirement),
        outline: pickStr(c.outline),
        content: pickStr(c.content),
        ...(snapshot ? { snapshot } : {}),
        ...(writingSkillIds.length ? { writingSkillIds } : {}),
      };
    });
}

/** 点 (cx,cy) 所在的最内层环境容器（面积最小者优先；排除 excludeId 自身及其后代——防环）。
 *  拖拽落点重定父级与「创建即归容器」共用。
 *  draggedRect（拖拽判定可选）：中心点没进任何容器、但拖拽矩形与容器重叠 ≥45% 也算「放进去了」——贴边放置不再漏判；
 *  创建路径（只传点）保持原语义。容器尺寸优先显式 width/height，缺了退 measured（RF 实测值兜底）。 */
export function findContainerAt(
  nodes: SimNodeType[],
  cx: number,
  cy: number,
  excludeId?: string,
  draggedRect?: { x: number; y: number; w: number; h: number },
): SimNodeType | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let best: SimNodeType | null = null;
  let bestArea = Infinity;
  for (const n of nodes) {
    if (n.data.kind !== 'environment' || n.id === excludeId) continue;
    if (!isContainerEnv(n.data.etype)) continue; // 物品等非容器类型：不可被拖入（v2.18）
    if (excludeId && isDescendantOf(n.id, excludeId, byId)) continue;
    const a = absPositionOf(n, byId);
    const w = n.width ?? n.measured?.width ?? 0;
    const h = n.height ?? n.measured?.height ?? 0;
    if (w <= 0 || h <= 0) continue;
    const inside = cx >= a.x && cx <= a.x + w && cy >= a.y && cy <= a.y + h;
    let overlaps = false;
    if (!inside && draggedRect && draggedRect.w > 0 && draggedRect.h > 0) {
      const ix = Math.min(a.x + w, draggedRect.x + draggedRect.w) - Math.max(a.x, draggedRect.x);
      const iy = Math.min(a.y + h, draggedRect.y + draggedRect.h) - Math.max(a.y, draggedRect.y);
      overlaps = ix > 0 && iy > 0 && (ix * iy) / (draggedRect.w * draggedRect.h) >= 0.45;
    }
    if (inside || overlaps) {
      const area = w * h;
      if (area < bestArea) {
        best = n;
        bestArea = area;
      }
    }
  }
  return best;
}

/** 🎯 视口落点：节点在当前可视区域居中，附近按节点尺寸错开避免叠死；所有候选点都夹在可视区域内。
 *  visible 为可视区域在 flow 坐标系中的矩形（调用方用 screenToFlowPosition 求左上/右下两点得到）。
 *  返回新节点左上角的绝对坐标；归属哪个父环境由调用方用「中心点」再判定（与拖拽语义一致）。 */
export function findViewportDropPosition(
  nodes: SimNodeType[],
  visible: { x: number; y: number; w: number; h: number },
  size: { w: number; h: number },
): { x: number; y: number } {
  const { w, h } = size;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const absRect = (n: SimNodeType) => {
    const p = absPositionOf(n, byId);
    return { x: p.x, y: p.y, w: n.width ?? n.measured?.width ?? 0, h: n.height ?? n.measured?.height ?? 0 };
  };
  const intersects = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 &&
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
  const MARGIN = 16;
  // 可视区域比节点还小时（极端放大）居中放置，不做夹取
  const clampAxis = (v: number, lo: number, hi: number, fallback: number) => (hi <= lo ? fallback : Math.min(hi, Math.max(lo, v)));
  const centerX = visible.x + visible.w / 2 - w / 2;
  const centerY = visible.y + visible.h / 2 - h / 2;
  // 步长与节点同量级：错开一两步就不互相压住
  const stepX = Math.max(56, Math.round(w / 2) + 16);
  const stepY = Math.max(56, Math.round(h / 2) + 16);
  const offsets: Array<[number, number]> = [[0, 0]];
  for (let r = 1; r <= 2; r++) {
    offsets.push([r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]);
  }
  let base = { x: centerX, y: centerY };
  for (const [ox, oy] of offsets) {
    const pos = {
      x: clampAxis(centerX + ox * stepX, visible.x + MARGIN, visible.x + visible.w - w - MARGIN, centerX),
      y: clampAxis(centerY + oy * stepY, visible.y + MARGIN, visible.y + visible.h - h - MARGIN, centerY),
    };
    if (ox === 0 && oy === 0) base = pos;
    // 与「同层级」节点避让：落在环境内时只看该环境的其他子节点，环境容器本身不算碰撞
    const parent = findContainerAt(nodes, pos.x + w / 2, pos.y + h / 2);
    const level = parent?.id ?? null;
    const rect = { x: pos.x, y: pos.y, w, h };
    if (!nodes.some((n) => (n.parentId ?? null) === level && intersects(rect, absRect(n)))) return pos;
  }
  return base;
}

/** 📍 在指定环境内给新建子节点找落点：标题条以下按网格摆放，优先横向（人物窄最多 3 列、环境宽 2 列），
 *  与已有直接子节点避让；当前尺寸放不下时一并返回父容器需要扩到的尺寸，保证新节点完整落在父容器内。
 *  返回的 pos 是绝对坐标（调用方创建后再 reparentNode，由 store 换算为相对父坐标）。 */
export function findChildDropPosition(
  nodes: SimNodeType[],
  parentId: string,
  size: { w: number; h: number },
): { pos: { x: number; y: number }; grow?: { w: number; h: number } } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parent = byId.get(parentId);
  if (!parent || parent.data.kind !== 'environment') return { pos: { x: 0, y: 0 } };
  const pabs = absPositionOf(parent, byId);
  const pw = parent.width ?? parent.measured?.width ?? ENV_DEFAULT_W;
  const ph = parent.height ?? parent.measured?.height ?? ENV_DEFAULT_H;
  const PAD = 12;
  const TOP = 34; // 父容器标题条高度（含留白），子节点不压住标题
  const GAP = 12;
  const colW = size.w + GAP;
  const rowH = size.h + GAP;
  const fitCols = Math.floor((pw - PAD * 2 + GAP) / colW);
  const preferred = size.w <= 150 ? 3 : 2;
  const cols = Math.max(1, Math.min(12, Math.max(preferred, fitCols)));
  const intersects = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 &&
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
  const childRects = nodes
    .filter((n) => n.parentId === parentId)
    .map((n) => {
      const a = absPositionOf(n, byId);
      return { x: a.x, y: a.y, w: n.width ?? n.measured?.width ?? 0, h: n.height ?? n.measured?.height ?? 0 };
    })
    .filter((r) => r.w > 0 && r.h > 0);
  for (let row = 0; row <= childRects.length + 1; row++) {
    for (let col = 0; col < cols; col++) {
      const x = PAD + col * colW;
      const y = TOP + row * rowH;
      const rect = { x: pabs.x + x, y: pabs.y + y, w: size.w, h: size.h };
      if (childRects.some((r) => intersects(rect, r))) continue;
      const needW = Math.max(pw, x + size.w + PAD);
      const needH = Math.max(ph, y + size.h + PAD);
      return {
        pos: { x: rect.x, y: rect.y },
        ...(needW > pw || needH > ph ? { grow: { w: needW, h: needH } } : {}),
      };
    }
  }
  // 兜底（子节点排布不规整时）：放到所有子节点下方，父容器按需加高
  const bottom = childRects.reduce((m, r) => Math.max(m, r.y + r.h), pabs.y + TOP - GAP);
  const y = bottom - pabs.y + GAP;
  return {
    pos: { x: pabs.x + PAD, y: pabs.y + y },
    grow: { w: Math.max(pw, PAD * 2 + size.w), h: y + size.h + PAD },
  };
}

// ── 载入/恢复兜底 ──

/** 过滤非法 kind/缺 data 节点 → 剥 expandParent/resizing 瞬态键 → 重建数据（人物剥到仅 name；环境补尺寸默认值）→
 *  人物 zIndex 强制顶层 →
 *  parentId 清洗（父必须存在且为 environment，且不成环）→ 清洗连线（悬空/自环/重复，静默丢弃）。
 *  dropped>0 调用方提示「已过滤 N 个非法节点」。 */
export function sanitizeSimNodes(
  nodes: SimNodeType[],
  edges: Edge[] = [],
): { nodes: SimNodeType[]; edges: Edge[]; dropped: number } {
  // 先按 id 去重：多画布存档合并/损坏缓存可能出现重复 id，React Flow 会因此错乱
  const seenNodeIds = new Set<string>();
  const valid = nodes.filter((n) => {
    if (!n || !n.id || !n.data) return false;
    if (seenNodeIds.has(n.id)) return false;
    if (!(SIM_KINDS as readonly string[]).includes((n.data as { kind?: string }).kind as string)) return false;
    seenNodeIds.add(n.id);
    return true;
  });
  const fixed = valid.map((n) => {
    const d = n.data as unknown as Record<string, unknown>;
    // 剥离 expandParent（v2 曾误设：拖子节点会自动撑大父容器，导致无法拖出）、resizing（瞬态）、selected（选中态不持久化）
    const base = { ...n } as Record<string, unknown>;
    delete base.expandParent;
    delete base.resizing;
    delete base.selected;
    const clean = base as unknown as SimNodeType;
    if (clean.data.kind === 'character') {
      // v2.30 人物多状态：旧平铺字段迁入状态0；已有 states 只清洗、不覆盖（详见 characterStates.ts）
      const data = sanitizeCharacterData(d, n.id);
      return { ...clean, data, zIndex: CHAR_ZINDEX };
    }
    // environment：etype 不在集合内归位 building；尺寸缺失/过小回默认（旧档案/损坏缓存兜底）
    const etype = (ENV_TYPES as readonly string[]).includes(pickStr(d.etype)) ? (pickStr(d.etype) as EnvironmentType) : 'building';
    const data: EnvironmentData = { kind: 'environment', name: pickStr(d.name), etype, desc: pickStr(d.desc) };
    if (d.locked === true) data.locked = true;
    const w = typeof clean.width === 'number' && clean.width >= ENV_MIN_W ? clean.width : ENV_DEFAULT_W;
    const h = typeof clean.height === 'number' && clean.height >= ENV_MIN_H ? clean.height : ENV_DEFAULT_H;
    return { ...clean, data, width: w, height: h, zIndex: undefined };
  });
  // parentId 清洗：链上每个祖先都必须存在且是 environment，且不成环；非法则提升回根
  const byId = new Map(fixed.map((n) => [n.id, n]));
  const cleaned = fixed.map((n) => {
    if (!n.parentId) return n;
    const guard = new Set<string>([n.id]);
    let cur: string | undefined = n.parentId;
    while (cur) {
      if (guard.has(cur)) return { ...n, parentId: undefined }; // 环
      guard.add(cur);
      const p = byId.get(cur);
      if (!p || p.data.kind !== 'environment') return { ...n, parentId: undefined };
      cur = p.parentId;
    }
    return n;
  });
  const keptEdges: Edge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!e || !e.source || !e.target || e.source === e.target) continue;
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    const key = `${e.source}→${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keptEdges.push(e);
  }
  return { nodes: sortParentsFirst(cleaned), edges: keptEdges, dropped: nodes.length - fixed.length };
}

/** 🗂 画布集合兜底（persist 恢复 + 存档载入共用）：
 *  - 新格式：逐板 sanitize；卷画布 id 固定为 vol:<volumeId>，重复/错位 id 合并到固定槽；
 *  - 旧格式：legacy nodes/edges 进默认主画布；
 *  - 每个卷都保证有一张画布；无法对应卷的异常画布保留（标签显示未关联），不静默丢节点。 */
export function sanitizeBoards(
  rawBoards: unknown,
  volumes: SimVolume[],
  legacy?: { nodes?: unknown; edges?: unknown },
  chapters?: SimChapter[],
): Record<string, SimBoard> {
  const volumeIds = new Set(volumes.map((v) => v.id));
  type RawBoard = {
    id: string;
    volumeId?: string;
    nodes: SimNodeType[];
    edges: Edge[];
    regions: unknown[];
    viewport?: unknown;
  };
  const groups = new Map<string, RawBoard>();
  const mergeNodes = (base: SimNodeType[], extra: SimNodeType[]) => {
    const ids = new Set(base.map((n) => n && n.id).filter(Boolean));
    return base.concat(extra.filter((n) => n && n.id && !ids.has(n.id)));
  };
  const add = (raw: RawBoard) => {
    const knownVolume = !!raw.volumeId && volumeIds.has(raw.volumeId);
    let key = knownVolume ? volumeBoardId(raw.volumeId!) : raw.id || `board-${uid()}`;
    // 固定卷画布槽兜底：老数据里 id 已经写成 vol:xxx 但缺 volumeId
    let volumeId = raw.volumeId;
    if (!volumeId && key.startsWith('vol:') && volumeIds.has(key.slice(4))) volumeId = key.slice(4);
    if (!volumeId && key === DEFAULT_BOARD_ID) key = DEFAULT_BOARD_ID;
    // main 一旦带无效卷 id，按默认画布处理，避免没有默认画布
    if (key === DEFAULT_BOARD_ID) volumeId = undefined;
    const cur = groups.get(key);
    if (cur) {
      cur.nodes = mergeNodes(cur.nodes, raw.nodes);
      cur.edges = cur.edges.concat(raw.edges);
      cur.regions = cur.regions.concat(raw.regions);
      if (cur.viewport === undefined) cur.viewport = raw.viewport;
      if (volumeId) cur.volumeId = volumeId;
    } else {
      groups.set(key, {
        id: key,
        ...(volumeId ? { volumeId } : {}),
        nodes: raw.nodes,
        edges: raw.edges,
        regions: raw.regions,
        ...(raw.viewport !== undefined ? { viewport: raw.viewport } : {}),
      });
    }
  };

  if (Array.isArray(rawBoards)) {
    for (const b of rawBoards) {
      if (!b || typeof b !== 'object') continue;
      const r = b as Partial<SimBoard>;
      add({
        id: typeof r.id === 'string' && r.id ? r.id : '',
        volumeId: typeof r.volumeId === 'string' && r.volumeId ? r.volumeId : undefined,
        nodes: Array.isArray(r.nodes) ? r.nodes : [],
        edges: Array.isArray(r.edges) ? r.edges : [],
        regions: Array.isArray(r.regions) ? r.regions : [],
        viewport: r.viewport,
      });
    }
  } else if (rawBoards && typeof rawBoards === 'object') {
    for (const [key, b] of Object.entries(rawBoards as Record<string, unknown>)) {
      if (!b || typeof b !== 'object') continue;
      const r = b as Partial<SimBoard>;
      add({
        id: typeof r.id === 'string' && r.id ? r.id : key,
        volumeId: typeof r.volumeId === 'string' && r.volumeId ? r.volumeId : undefined,
        nodes: Array.isArray(r.nodes) ? r.nodes : [],
        edges: Array.isArray(r.edges) ? r.edges : [],
        regions: Array.isArray(r.regions) ? r.regions : [],
        viewport: r.viewport,
      });
    }
  }

  if (!groups.has(DEFAULT_BOARD_ID)) {
    const legacyNodes = Array.isArray(legacy?.nodes) ? (legacy.nodes as SimNodeType[]) : [];
    const legacyEdges = Array.isArray(legacy?.edges) ? (legacy.edges as Edge[]) : [];
    const s = sanitizeSimNodes(legacyNodes, legacyEdges);
    groups.set(DEFAULT_BOARD_ID, { id: DEFAULT_BOARD_ID, nodes: s.nodes, edges: s.edges, regions: [] });
  }
  for (const v of volumes) {
    const id = volumeBoardId(v.id);
    if (!groups.has(id)) groups.set(id, { id, volumeId: v.id, nodes: [], edges: [], regions: [] });
  }

  // 📐 区域归属：有章节表时只保留在章节当前所属画布上的区域，孤儿/错板区域丢弃
  const chapterToBoard = chapters ? buildChapterBoardMap(chapters, volumes) : undefined;
  const out: Record<string, SimBoard> = {};
  for (const [id, g] of groups) {
    const s = sanitizeSimNodes(g.nodes, g.edges);
    const viewport = sanitizeViewport(g.viewport);
    out[id] = {
      id,
      ...(g.volumeId ? { volumeId: g.volumeId } : {}),
      nodes: s.nodes,
      edges: s.edges,
      regions: sanitizeRegions(
        g.regions,
        chapterToBoard ? (chapterId) => chapterToBoard.get(chapterId) === id : undefined,
      ),
      ...(viewport ? { viewport } : {}),
    };
  }
  return out;
}

// ── Store ──

export interface WorkspaceSnapshot {
  boards: Record<string, SimBoard>;
  activeBoardId?: string;
  graphName?: string;
  cover?: string;
  rules?: string;
  outlineRules?: string;
  charGenRules?: string;
  mainGoal?: string;
  volumes?: SimVolume[];
  chapters?: SimChapter[];
  responsibleId?: string;
}

/** 人物顶层身份补丁：人名/性别跨状态稳定，不写状态 */
export type CharacterIdentityPatch = Partial<Pick<CharacterData, 'name' | 'gender'>>;
/** 状态属性补丁：只含随状态变化的字段（id/label 只能走专用动作） */
export interface ChapterSceneSyncResult {
  ok: boolean;
  /** 快照内容是否发生变化（时间戳/来源变化不算） */
  changed: boolean;
  /** 是否首次创建快照 */
  created: boolean;
  snapshot?: ChapterSnapshot;
  error?: string;
}

export type ChapterSceneApplyResult = {
  ok: boolean;
  changed: boolean;
  moved: number;
  reparented: number;
  stateRestored: number;
  missingCharacters: string[];
  missingStates: string[];
  missingParents: string[];
  error?: string;
};

export type CharacterStatePatch = Partial<Omit<CharacterState, 'id' | 'label'>>;
export type CharacterStateError =
  | 'not-found'
  | 'base-not-found'
  | 'empty-label'
  | 'duplicate-label'
  | 'protected'
  | 'last-state';
export type CharacterStateOpResult =
  | { ok: true; stateId?: string; removed?: CharacterState }
  | { ok: false; error: CharacterStateError };
export interface AddCharacterStateOptions {
  label?: string;
  baseStateId?: string;
  patch?: CharacterStatePatch;
  /** 默认 true：新建后立刻切到新状态，便于马上编辑 */
  activate?: boolean;
}

export type SnapshotError =
  | 'chapter-not-found'
  | 'board-not-found'
  | 'region-not-found'
  | 'snapshot-not-found'
  | 'character-not-found'
  | 'state-not-found'
  | 'entry-not-found';
export type SnapshotResult = { ok: true; snapshot: ChapterSnapshot } | { ok: false; error: SnapshotError };
export type SnapshotMutationResult = { ok: true } | { ok: false; error: SnapshotError };

interface SimState {
  /** 🗂 全部卷画布（唯一权威节点数据源） */
  boards: Record<string, SimBoard>;
  /** 当前渲染/编辑的画布 */
  activeBoardId: string;
  graphName: string;
  /** 📕 作品封面（v2.28）：上传后压成的 5:7 JPEG data URL（''=未设置）；随作品状态与存档保存，书架上显示 */
  cover: string;
  /** 📜 全文规则：世界法则/写作文风（v2.19b 起不再含故事走向——方向由 🎯 全文目标管）（随地图存档保存） */
  rules: string;
  /** 📜 章节大纲规则：如何生成章节大纲的要求（结构/节奏/要素等；演进生成管线与编辑室拟纲都遵守） */
  outlineRules: string;
  /** 🧬 人物生成规则（v2.15）：如何随机生成人物的要求——规则非空时「＋人物」自动按规则随机生成人物
   *  （⚠ 编辑室 v2.19 起默认不注入，⚙「📜 附带规则与目标」开启才按需参考——编辑室不被默认约束） */
  charGenRules: string;
  /** 🎯 全文目标（v2.16）：几句话写明这部小说的主要目标——📋大纲/📝正文/随机人物默认注入统一方向
   *  （⚠ 编辑室 v2.19 起默认不注入，⚙「📜 附带规则与目标」开启才按需参考） */
  mainGoal: string;
  /** 🏛 作品责任编辑（v2.21）：当前作品的全局责编（编辑 ID，''=未设置），随地图存档保存。
   *  生成各模块内容与总编辑对话时注入其职责 + 对应模块的技能记忆（getWorkResponsibleData） */
  responsibleId: string;
  /** 📚 卷（v2.17）：章节的分卷列表——每卷与一张卷画布一一对应 */
  volumes: SimVolume[];
  /** 📋 章节大纲管理器：章节列表（章名/本章需求/生成的大纲/生成的正文，随地图存档保存；v2.10/v2.11） */
  chapters: SimChapter[];
  /** 正在大纲生成的章节 id（瞬态：只用于 UI 状态，persist merge 归 null） */
  outlineBusyId: string | null;
  /** 正在生成正文的章节 id（瞬态：只用于 UI 状态，persist merge 归 null） */
  contentBusyId: string | null;
  setGraphName: (name: string) => void;
  setCover: (cover: string) => void;
  setResponsibleId: (id: string) => void;
  setRules: (text: string) => void;
  setOutlineRules: (text: string) => void;
  setCharGenRules: (text: string) => void;
  setMainGoal: (text: string) => void;
  /** 新增章节（章名自动「第N章」；返回新 id 供选中） */
  addChapter: () => string;
  /** 📚 新增卷 + 空画布（卷名自动「第N卷」；activate 默认 true=切到新画布） */
  addVolume: (opts?: { activate?: boolean }) => string;
  /** 编辑室【卷设定】落地：同名卷不重复创建，且不自动切画布 */
  addVolumeFromBlock: (title: string, intro: string) => { created: boolean; volumeId: string; boardId: string };
  updateVolume: (id: string, patch: Partial<SimVolume>) => void;
  /** 删除卷及其画布（章节回到未分卷）；当前画布被删则切回默认主画布 */
  deleteVolume: (id: string) => void;
  updateChapter: (id: string, patch: Partial<SimChapter>) => void;
  deleteChapter: (id: string) => void;
  /** 章节上移/下移一位 */
  moveChapter: (id: string, dir: -1 | 1) => void;
  /** ✨ 设置本章正文启用的写作技能（去重/最多 3 个；无变化不标记未保存） */
  setChapterWritingSkillIds: (chapterId: string, ids: string[]) => void;
  /** 全局技能库删除技能时，清理当前作品所有章节中的该技能引用 */
  removeWritingSkillReferences: (skillId: string) => void;
  setOutlineBusy: (id: string | null) => void;
  setContentBusy: (id: string | null) => void;

  // ── 画布生命周期 ──
  ensureDefaultBoard: () => void;
  ensureBoardForVolume: (volumeId: string) => string;
  switchBoard: (boardId: string) => boolean;
  setBoardViewport: (boardId: string, viewport: SimViewport) => void;
  saveActiveViewport: (viewport: SimViewport) => void;

  // ── 📐 章节区域（指定画布 + 当前画布代理） ──
  /** 为章节建区域；同章已有区域返回 existing=true，不重复创建 */
  addChapterRegionOnBoard: (
    boardId: string,
    chapterId: string,
    rect: RegionRect,
    opts?: ChapterRegionCreateOptions,
  ) => ChapterRegionAddResult;
  updateChapterRegionOnBoard: (boardId: string, regionId: string, patch: ChapterRegionPatch) => void;
  deleteChapterRegionOnBoard: (boardId: string, regionId: string) => void;
  addChapterRegion: (chapterId: string, rect: RegionRect, opts?: ChapterRegionCreateOptions) => ChapterRegionAddResult;
  updateChapterRegion: (regionId: string, patch: ChapterRegionPatch) => void;
  deleteChapterRegion: (regionId: string) => void;

  // ── 📸 章节快照（R2/R3） ──
  /** 采集本章区域名单并记录快照（已有快照会被覆盖，需 UI 确认） */
  captureChapterSnapshot: (chapterId: string, opts?: { source?: ChapterSnapshot['source'] }) => SnapshotResult;
  /** 刷新快照：重采自动名单与几何，保留手动词条与人工角色/状态覆盖 */
  refreshChapterSnapshot: (chapterId: string) => SnapshotResult;
  addSnapshotEntry: (chapterId: string, characterId: string, opts?: { role?: CastRole; stateId?: string }) => SnapshotMutationResult;
  removeSnapshotEntry: (chapterId: string, characterId: string) => SnapshotMutationResult;
  updateSnapshotEntry: (
    chapterId: string,
    characterId: string,
    patch: { role?: CastRole; stateId?: string },
  ) => SnapshotMutationResult;
  clearChapterSnapshot: (chapterId: string) => SnapshotMutationResult;
  /** 🎬 自动跟随：按当前区域重采本章场景快照（名单/位置/父环境/当前状态）；内容未变不写 */
  syncChapterScene: (chapterId: string) => ChapterSceneSyncResult;
  /** 🎬 切章回放：只移动快照内人物，恢复父环境、绝对位置与当前状态 id */
  applyChapterScene: (chapterId: string) => ChapterSceneApplyResult;

  // ── 节点（当前画布） ──
  /** 新建人物节点（pos=地图落点；缺省人物列堆叠） */
  createCharacter: (pos?: { x: number; y: number }) => string;
  /** 新建环境节点（pos=地图落点；缺省环境列堆叠；size=初始尺寸（下限钳制，区域规划整组落地用），缺省默认尺寸；选中后可 NodeResizer 缩放） */
  createEnvironment: (pos?: { x: number; y: number }, size?: { w: number; h: number }) => string;
  /** 更新人物顶层身份（人名/性别；仅 kind==='character' 生效） */
  updateCharacter: (id: string, patch: CharacterIdentityPatch) => void;
  /** 更新环境节点字段（仅 kind==='environment' 生效） */
  updateEnvironment: (id: string, patch: Partial<EnvironmentData>) => void;
  /** 调整环境节点尺寸（AI 在容器内新建子节点、容器不够大时自动扩展用） */
  resizeEnvironment: (id: string, w: number, h: number) => void;
  /** 重定父级：parentId=null 提升回根（position 换算回绝对坐标），否则挂到目标环境节点下（position 换算为相对父坐标） */
  reparentNode: (childId: string, parentId: string | null) => void;
  /** 删除节点（父环境被删时，其后代提升回根层，绝对坐标展开） */
  deleteNode: (id: string) => void;

  // ── 🧬 人物状态（当前画布代理） ──
  addCharacterState: (id: string, opts?: AddCharacterStateOptions) => CharacterStateOpResult;
  updateCharacterState: (id: string, patch: CharacterStatePatch, stateId?: string) => CharacterStateOpResult;
  updateActiveCharacterState: (id: string, patch: CharacterStatePatch) => CharacterStateOpResult;
  switchCharacterState: (id: string, stateId: string) => CharacterStateOpResult;
  renameCharacterState: (id: string, stateId: string, label: string) => CharacterStateOpResult;
  deleteCharacterState: (id: string, stateId: string) => CharacterStateOpResult;

  // ── 节点（指定画布：编辑室跨卷落地，不切当前标签） ──
  createCharacterOnBoard: (boardId: string, pos?: { x: number; y: number }, opts?: { select?: boolean }) => string | null;
  createEnvironmentOnBoard: (boardId: string, pos?: { x: number; y: number }, size?: { w: number; h: number }, opts?: { select?: boolean }) => string | null;
  updateCharacterOnBoard: (boardId: string, id: string, patch: CharacterIdentityPatch) => void;
  updateEnvironmentOnBoard: (boardId: string, id: string, patch: Partial<EnvironmentData>) => void;
  addCharacterStateOnBoard: (boardId: string, id: string, opts?: AddCharacterStateOptions) => CharacterStateOpResult;
  updateCharacterStateOnBoard: (boardId: string, id: string, patch: CharacterStatePatch, stateId?: string) => CharacterStateOpResult;
  updateActiveCharacterStateOnBoard: (boardId: string, id: string, patch: CharacterStatePatch) => CharacterStateOpResult;
  switchCharacterStateOnBoard: (boardId: string, id: string, stateId: string) => CharacterStateOpResult;
  renameCharacterStateOnBoard: (boardId: string, id: string, stateId: string, label: string) => CharacterStateOpResult;
  deleteCharacterStateOnBoard: (boardId: string, id: string, stateId: string) => CharacterStateOpResult;
  resizeEnvironmentOnBoard: (boardId: string, id: string, w: number, h: number) => void;
  reparentNodeOnBoard: (boardId: string, childId: string, parentId: string | null) => void;
  /** 跨卷复制（源默认=当前画布）；只写目标画布，默认不切换标签 */
  copyNodesToBoard: (
    opts: BoardCopyInput & { targetBoardId: string; sourceBoardId?: string; switchAfter?: boolean; selectResult?: boolean },
  ) => BoardCopyResult;

  replaceState: (s: WorkspaceSnapshot) => void;

  onNodesChange: (changes: NodeChange<SimNodeType>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
}

/** 节点/连线上属于 React Flow 交互瞬态的字段：不参与“内容是否改动”的判断，也不会影响保存结果 */
const TRANSIENT_NODE_KEYS = new Set(['selected', 'dragging', 'resizing', 'measured', 'positionAbsolute', 'internals']);

function sameNodeContent(a: SimNodeType, b: SimNodeType): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    if (TRANSIENT_NODE_KEYS.has(k)) continue;
    if (k === 'position') {
      const pa = ra.position as { x?: number; y?: number } | undefined;
      const pb = rb.position as { x?: number; y?: number } | undefined;
      if ((pa?.x ?? 0) !== (pb?.x ?? 0) || (pa?.y ?? 0) !== (pb?.y ?? 0)) return false;
      continue;
    }
    if (ra[k] !== rb[k]) return false;
  }
  return true;
}

function sameEdgeContent(a: Edge, b: Edge): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (k === 'selected') continue;
    if (ra[k] !== rb[k]) return false;
  }
  return true;
}

/** 仅比较会写进作品存档的内容：平移视口、切换画布标签、React Flow 选中/测量不算未保存改动 */
function sameStudioContent(a: SimState, b: SimState): boolean {
  if (a === b) return true;
  if (
    a.graphName !== b.graphName ||
    a.cover !== b.cover ||
    a.responsibleId !== b.responsibleId ||
    a.rules !== b.rules ||
    a.outlineRules !== b.outlineRules ||
    a.charGenRules !== b.charGenRules ||
    a.mainGoal !== b.mainGoal ||
    a.volumes !== b.volumes ||
    a.chapters !== b.chapters
  ) {
    return false;
  }
  const ids = Object.keys(a.boards);
  if (ids.length !== Object.keys(b.boards).length) return false;
  for (const id of ids) {
    const ba = a.boards[id];
    const bb = b.boards[id];
    if (!ba || !bb) return false;
    if (ba.volumeId !== bb.volumeId) return false;
    if (ba.regions !== bb.regions) return false;
    if (ba.nodes.length !== bb.nodes.length || ba.edges.length !== bb.edges.length) return false;
    for (let i = 0; i < ba.nodes.length; i++) if (!sameNodeContent(ba.nodes[i], bb.nodes[i])) return false;
    for (let i = 0; i < ba.edges.length; i++) if (!sameEdgeContent(ba.edges[i], bb.edges[i])) return false;
  }
  return true;
}

/** 手动保存：所有变更只留在内存并标记未保存，用户点「保存」或 Ctrl/Cmd+S 时才写 localStorage */
const studioPersistStorage = createManualPersistStorage<SimState>({
  contentEqual: sameStudioContent,
  defaultVersion: 2,
});

/** 立即保存当前工作区到 localStorage（返回是否成功） */
export const saveStudioWorkspace = (): boolean => studioPersistStorage.save();

/** 是否有尚未保存的工作区改动 */
export const hasUnsavedStudioChanges = (): boolean => studioPersistStorage.hasPending();

const EMPTY_NODES: SimNodeType[] = [];
const EMPTY_EDGES: Edge[] = [];
const EMPTY_REGIONS: ChapterRegion[] = [];

export const selectActiveBoard = (s: SimState): SimBoard | undefined => s.boards[s.activeBoardId];
export const selectActiveNodes = (s: SimState): SimNodeType[] => s.boards[s.activeBoardId]?.nodes ?? EMPTY_NODES;
export const selectActiveEdges = (s: SimState): Edge[] => s.boards[s.activeBoardId]?.edges ?? EMPTY_EDGES;
export const selectActiveRegions = (s: SimState): ChapterRegion[] => s.boards[s.activeBoardId]?.regions ?? EMPTY_REGIONS;

function boardNodes(s: SimState, boardId = s.activeBoardId): SimNodeType[] {
  return s.boards[boardId]?.nodes ?? EMPTY_NODES;
}

function setBoardNodes(
  s: SimState,
  boardId: string,
  nodes: SimNodeType[],
  edges?: Edge[],
): Partial<SimState> {
  const b = s.boards[boardId];
  if (!b) return {};
  return {
    boards: {
      ...s.boards,
      [boardId]: { ...b, nodes, ...(edges ? { edges } : {}) },
    },
  };
}

export const useStudioStore = create<SimState>()(
  persist(
    (set, get) => ({
      boards: { [DEFAULT_BOARD_ID]: emptyBoard(DEFAULT_BOARD_ID) },
      activeBoardId: DEFAULT_BOARD_ID,
      graphName: '未命名',
      cover: '',
      responsibleId: '',
      rules: '',
      outlineRules: '',
      charGenRules: '',
      mainGoal: '',
      volumes: [],
      chapters: [],
      outlineBusyId: null,
      contentBusyId: null,
      setGraphName: (name) => set({ graphName: name }),
      setCover: (cover) => set({ cover }),

      setResponsibleId: (id) => set({ responsibleId: id }),
      setRules: (text) => set({ rules: text }),
      setOutlineRules: (text) => set({ outlineRules: text }),
      setCharGenRules: (text) => set({ charGenRules: text }),
      setMainGoal: (text) => set({ mainGoal: text }),

      addChapter: () => {
        const { chapters } = get();
        const id = uid();
        set({ chapters: [...chapters, { id, title: `第${chapters.length + 1}章`, volumeId: '', requirement: '', outline: '', content: '' }] });
        return id;
      },
      addVolume: (opts) => {
        const { volumes, boards, activeBoardId } = get();
        const id = uid();
        const boardId = volumeBoardId(id);
        const activate = opts?.activate ?? true;
        set({
          volumes: [...volumes, { id, title: nextVolumeTitle(volumes), intro: '' }],
          boards: { ...boards, [boardId]: emptyBoard(boardId, id) },
          ...(activate ? { activeBoardId: boardId } : {}),
        });
        return id;
      },
      addVolumeFromBlock: (title, intro) => {
        const { volumes, boards } = get();
        const norm = normalizeVolumeTitle(title);
        const existing = norm ? volumes.find((v) => normalizeVolumeTitle(v.title) === norm) : undefined;
        if (existing) {
          const boardId = volumeBoardId(existing.id);
          if (!boards[boardId]) {
            set({ boards: { ...boards, [boardId]: emptyBoard(boardId, existing.id) } });
          }
          return { created: false, volumeId: existing.id, boardId };
        }
        const id = uid();
        const boardId = volumeBoardId(id);
        const finalTitle = norm && norm !== '主画布' && norm !== '默认主画布'
          ? title.trim().slice(0, 20)
          : nextVolumeTitle(volumes);
        set({
          volumes: [...volumes, { id, title: finalTitle, intro: intro.slice(0, 300) }],
          boards: { ...boards, [boardId]: emptyBoard(boardId, id) },
        });
        return { created: true, volumeId: id, boardId };
      },
      updateVolume: (id, patch) =>
        set((s) => ({ volumes: s.volumes.map((v) => (v.id === id ? { ...v, ...patch } : v)) })),
      deleteVolume: (id) =>
        set((s) => {
          if (!s.volumes.some((v) => v.id === id)) return {};
          const boardId = volumeBoardId(id);
          const affected = new Set(s.chapters.filter((c) => c.volumeId === id).map((c) => c.id));
          let boards = { ...s.boards };
          delete boards[boardId];
          if (!boards[DEFAULT_BOARD_ID]) boards[DEFAULT_BOARD_ID] = emptyBoard(DEFAULT_BOARD_ID);
          // 卷章节回到未分卷；若旧档/异常数据还在别的板留了本章区域，一并清掉
          if (affected.size) boards = removeChapterRegions(boards, affected);
          return {
            volumes: s.volumes.filter((v) => v.id !== id),
            chapters: s.chapters.map((c) => (c.volumeId === id ? { ...c, volumeId: '' } : c)),
            boards,
            activeBoardId: s.activeBoardId === boardId ? DEFAULT_BOARD_ID : s.activeBoardId,
          };
        }),
      updateChapter: (id, patch) =>
        set((s) => {
          const before = s.chapters.find((c) => c.id === id);
          if (!before) return {};
          const chapters = s.chapters.map((c) => (c.id === id ? { ...c, ...patch } : c));
          let boards = s.boards;
          // 换卷导致章节落到别的画布时，旧区域必须删除（UI 先确认；store 兜底防止静默留在错板）
          if (patch.volumeId !== undefined && patch.volumeId !== before.volumeId) {
            const from = chapterBoardOf(before.volumeId, s.volumes, s.boards);
            const to = chapterBoardOf(patch.volumeId, s.volumes, s.boards);
            if (from !== to) boards = removeChapterRegions(boards, new Set([id]));
          }
          return { chapters, ...(boards !== s.boards ? { boards } : {}) };
        }),
      deleteChapter: (id) =>
        set((s) => ({
          chapters: s.chapters.filter((c) => c.id !== id),
          boards: removeChapterRegions(s.boards, new Set([id])),
          outlineBusyId: s.outlineBusyId === id ? null : s.outlineBusyId,
          contentBusyId: s.contentBusyId === id ? null : s.contentBusyId,
        })),
      moveChapter: (id, dir) =>
        set((s) => {
          const i = s.chapters.findIndex((c) => c.id === id);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= s.chapters.length) return {};
          const chapters = [...s.chapters];
          [chapters[i], chapters[j]] = [chapters[j], chapters[i]];
          return { chapters };
        }),
      setChapterWritingSkillIds: (id, ids) =>
        set((s) => {
          const before = s.chapters.find((c) => c.id === id);
          if (!before) return {};
          const next = sanitizeWritingSkillIds(ids);
          if (sameStringList(before.writingSkillIds ?? [], next)) return {};
          return {
            chapters: s.chapters.map((c) => {
              if (c.id !== id) return c;
              if (next.length) return { ...c, writingSkillIds: next };
              const { writingSkillIds: _drop, ...rest } = c;
              return rest;
            }),
          };
        }),
      removeWritingSkillReferences: (skillId) =>
        set((s) => {
          let changed = false;
          const chapters = s.chapters.map((c) => {
            if (!c.writingSkillIds?.includes(skillId)) return c;
            changed = true;
            const next = c.writingSkillIds.filter((x) => x !== skillId);
            if (next.length) return { ...c, writingSkillIds: next };
            const { writingSkillIds: _drop, ...rest } = c;
            return rest;
          });
          return changed ? { chapters } : {};
        }),
      setOutlineBusy: (id) => set({ outlineBusyId: id }),
      setContentBusy: (id) => set({ contentBusyId: id }),

      ensureDefaultBoard: () =>
        set((s) =>
          s.boards[DEFAULT_BOARD_ID]
            ? {}
            : { boards: { ...s.boards, [DEFAULT_BOARD_ID]: emptyBoard(DEFAULT_BOARD_ID) } },
        ),
      ensureBoardForVolume: (volumeId) => {
        if (!volumeId) return '';
        const s = get();
        const id = volumeBoardId(volumeId);
        if (s.boards[id]) return id;
        if (!s.volumes.some((v) => v.id === volumeId)) return '';
        set({ boards: { ...s.boards, [id]: emptyBoard(id, volumeId) } });
        return id;
      },
      switchBoard: (boardId) => {
        const s = get();
        if (!s.boards[boardId]) return false;
        set({ activeBoardId: boardId });
        return true;
      },
      setBoardViewport: (boardId, viewport) =>
        set((s) => {
          const b = s.boards[boardId];
          const vp = sanitizeViewport(viewport);
          if (!b || !vp) return {};
          return { boards: { ...s.boards, [boardId]: { ...b, viewport: vp } } };
        }),
      saveActiveViewport: (viewport) => get().setBoardViewport(get().activeBoardId, viewport),

      // ── 📐 章节区域 ──
      addChapterRegionOnBoard: (boardId, chapterId, rect, opts) => {
        const s = get();
        const board = s.boards[boardId];
        if (!board) return { ok: false, error: 'board-not-found' };
        const chapter = s.chapters.find((c) => c.id === chapterId);
        if (!chapter) return { ok: false, error: 'chapter-not-found' };
        if (chapterBoardOf(chapter.volumeId, s.volumes, s.boards) !== boardId) {
          return { ok: false, error: 'wrong-board' };
        }
        const existing = board.regions.find((r) => r.chapterId === chapterId);
        if (existing) return { ok: true, regionId: existing.id, existing: true };

        // 自愈：该章若在别的画布留有区域，先清掉再在本板创建
        const boards = removeChapterRegions(s.boards, new Set([chapterId]));
        const target = boards[boardId];
        if (!target) return { ok: false, error: 'board-not-found' };
        let id = opts?.id?.trim() || `rg-${uid()}`;
        const usedIds = new Set(target.regions.map((r) => r.id));
        while (usedIds.has(id)) id = `rg-${uid()}`;
        const color = opts?.color?.trim().slice(0, 32) ?? '';
        const region: ChapterRegion = {
          id,
          chapterId,
          ...sanitizeRegionRect(rect),
          ...(color ? { color } : {}),
        };
        set({
          boards: {
            ...boards,
            [boardId]: { ...target, regions: [...target.regions, region] },
          },
        });
        return { ok: true, regionId: id, existing: false };
      },
      updateChapterRegionOnBoard: (boardId, regionId, patch) =>
        set((s) => {
          const b = s.boards[boardId];
          if (!b) return {};
          let changed = false;
          const regions = b.regions.map((r) => {
            if (r.id !== regionId) return r;
            changed = true;
            const next: ChapterRegion = { ...r };
            if (
              patch.x !== undefined ||
              patch.y !== undefined ||
              patch.width !== undefined ||
              patch.height !== undefined
            ) {
              Object.assign(
                next,
                sanitizeRegionRect({
                  x: patch.x ?? r.x,
                  y: patch.y ?? r.y,
                  width: patch.width ?? r.width,
                  height: patch.height ?? r.height,
                }),
              );
            }
            if (patch.color !== undefined) {
              const color = patch.color.trim().slice(0, 32);
              if (color) next.color = color;
              else delete next.color;
            }
            return next;
          });
          return changed ? { boards: { ...s.boards, [boardId]: { ...b, regions } } } : {};
        }),
      deleteChapterRegionOnBoard: (boardId, regionId) =>
        set((s) => {
          const b = s.boards[boardId];
          if (!b || !b.regions.some((r) => r.id === regionId)) return {};
          return {
            boards: {
              ...s.boards,
              [boardId]: { ...b, regions: b.regions.filter((r) => r.id !== regionId) },
            },
          };
        }),
      addChapterRegion: (chapterId, rect, opts) =>
        get().addChapterRegionOnBoard(get().activeBoardId, chapterId, rect, opts),
      updateChapterRegion: (regionId, patch) =>
        get().updateChapterRegionOnBoard(get().activeBoardId, regionId, patch),
      deleteChapterRegion: (regionId) => get().deleteChapterRegionOnBoard(get().activeBoardId, regionId),

      // ── 📸 章节快照 ──
      captureChapterSnapshot: (chapterId, opts) => {
        const s = get();
        const chapter = s.chapters.find((c) => c.id === chapterId);
        if (!chapter) return { ok: false, error: 'chapter-not-found' };
        const boardId = chapterBoardOf(chapter.volumeId, s.volumes, s.boards);
        const board = s.boards[boardId];
        if (!board) return { ok: false, error: 'board-not-found' };
        const region = board.regions.find((r) => r.chapterId === chapterId);
        if (!region) return { ok: false, error: 'region-not-found' };
        const snapshot = captureSnapshotPure(board, region, { source: opts?.source ?? 'manual' });
        set({
          chapters: s.chapters.map((c) => (c.id === chapterId ? { ...c, snapshot } : c)),
        });
        return { ok: true, snapshot };
      },
      refreshChapterSnapshot: (chapterId) => {
        const s = get();
        const chapter = s.chapters.find((c) => c.id === chapterId);
        if (!chapter) return { ok: false, error: 'chapter-not-found' };
        const prev = chapter.snapshot;
        if (!prev) return { ok: false, error: 'snapshot-not-found' };
        const board = s.boards[prev.boardId];
        if (!board) return { ok: false, error: 'board-not-found' };
        const region = board.regions.find((r) => r.chapterId === chapterId);
        if (!region) return { ok: false, error: 'region-not-found' };
        const snapshot = refreshSnapshotPure(prev, board, region);
        set({
          chapters: s.chapters.map((c) => (c.id === chapterId ? { ...c, snapshot } : c)),
        });
        return { ok: true, snapshot };
      },
      addSnapshotEntry: (chapterId, characterId, opts) => {
        const s = get();
        const chapter = s.chapters.find((c) => c.id === chapterId);
        if (!chapter) return { ok: false, error: 'chapter-not-found' };
        const snap = chapter.snapshot;
        if (!snap) return { ok: false, error: 'snapshot-not-found' };
        if (snap.entries.some((e) => e.characterId === characterId)) return { ok: true };
        const board = s.boards[snap.boardId];
        if (!board) return { ok: false, error: 'board-not-found' };
        const node = board.nodes.find((n) => n.id === characterId);
        if (!node || node.data.kind !== 'character') return { ok: false, error: 'character-not-found' };
        if (opts?.stateId && !node.data.states.some((st) => st.id === opts.stateId)) {
          return { ok: false, error: 'state-not-found' };
        }
        const entry = manualSnapshotEntry(board, characterId, opts);
        if (!entry) return { ok: false, error: 'character-not-found' };
        const entries = [...snap.entries, entry];
        const region = snap.regions[0];
        const snapshot = {
          ...snap,
          updatedAt: Date.now(),
          entries,
          ...(region ? { envRefs: collectSnapshotEnvRefs(board, region, entries) } : {}),
        };
        set({
          chapters: s.chapters.map((c) => (c.id === chapterId ? { ...c, snapshot } : c)),
        });
        return { ok: true };
      },
      removeSnapshotEntry: (chapterId, characterId) => {
        const s = get();
        const chapter = s.chapters.find((c) => c.id === chapterId);
        if (!chapter) return { ok: false, error: 'chapter-not-found' };
        const snap = chapter.snapshot;
        if (!snap) return { ok: false, error: 'snapshot-not-found' };
        if (!snap.entries.some((e) => e.characterId === characterId)) {
          return { ok: false, error: 'entry-not-found' };
        }
        const board = s.boards[snap.boardId];
        const entries = snap.entries.filter((e) => e.characterId !== characterId);
        const region = snap.regions[0];
        const snapshot = {
          ...snap,
          updatedAt: Date.now(),
          entries,
          ...(board && region ? { envRefs: collectSnapshotEnvRefs(board, region, entries) } : {}),
        };
        set({
          chapters: s.chapters.map((c) => (c.id === chapterId ? { ...c, snapshot } : c)),
        });
        return { ok: true };
      },
      updateSnapshotEntry: (chapterId, characterId, patch) => {
        const s = get();
        const chapter = s.chapters.find((c) => c.id === chapterId);
        if (!chapter) return { ok: false, error: 'chapter-not-found' };
        const snap = chapter.snapshot;
        if (!snap) return { ok: false, error: 'snapshot-not-found' };
        const entry = snap.entries.find((e) => e.characterId === characterId);
        if (!entry) return { ok: false, error: 'entry-not-found' };
        const board = s.boards[snap.boardId];
        if (!board) return { ok: false, error: 'board-not-found' };
        const node = board.nodes.find((n) => n.id === characterId);
        if (!node || node.data.kind !== 'character') return { ok: false, error: 'character-not-found' };
        if (patch.stateId && !node.data.states.some((st) => st.id === patch.stateId)) {
          return { ok: false, error: 'state-not-found' };
        }
        const next = manualSnapshotEntry(board, characterId, {
          role: patch.role ?? entry.role,
          stateId: patch.stateId ?? entry.stateId,
        });
        if (!next) return { ok: false, error: 'character-not-found' };
        // 保留区域来源；只锁定人工改过的维度（未改的维度继续跟随刷新）
        next.origin = entry.origin;
        const roleLocked = entry.roleLocked === true || patch.role !== undefined;
        const stateLocked = entry.stateLocked === true || patch.stateId !== undefined;
        if (roleLocked) next.roleLocked = true;
        else delete next.roleLocked;
        if (stateLocked) next.stateLocked = true;
        else delete next.stateLocked;
        const entries = snap.entries.map((e) => (e.characterId === characterId ? next : e));
        const region = snap.regions[0];
        const snapshot = {
          ...snap,
          updatedAt: Date.now(),
          entries,
          ...(region ? { envRefs: collectSnapshotEnvRefs(board, region, entries) } : {}),
        };
        set({
          chapters: s.chapters.map((c) => (c.id === chapterId ? { ...c, snapshot } : c)),
        });
        return { ok: true };
      },
      clearChapterSnapshot: (chapterId) => {
        const s = get();
        const chapter = s.chapters.find((c) => c.id === chapterId);
        if (!chapter) return { ok: false, error: 'chapter-not-found' };
        if (!chapter.snapshot) return { ok: false, error: 'snapshot-not-found' };
        set({
          chapters: s.chapters.map((c) => {
            if (c.id !== chapterId) return c;
            const next = { ...c };
            delete next.snapshot;
            return next;
          }),
        });
        return { ok: true };
      },
      syncChapterScene: (chapterId) => {
        const s = get();
        const chapter = s.chapters.find((c) => c.id === chapterId);
        if (!chapter) return { ok: false, changed: false, created: false, error: 'chapter-not-found' };
        const boardId = chapterBoardOf(chapter.volumeId, s.volumes, s.boards);
        const board = s.boards[boardId];
        if (!board) return { ok: false, changed: false, created: false, error: 'board-not-found' };
        const region = board.regions.find((r) => r.chapterId === chapterId);
        if (!region) return { ok: false, changed: false, created: false, error: 'region-not-found' };
        const now = Date.now();
        const fresh = captureSnapshotPure(board, region, { source: 'auto-scene', now });
        const prev = chapter.snapshot;
        if (prev && prev.boardId === boardId && sameSnapshotScene(prev, fresh)) {
          return { ok: true, changed: false, created: false, snapshot: prev };
        }
        const snapshot: ChapterSnapshot = {
          ...fresh,
          // 场景自动跟随：首次采集时间保留，内容变化只刷新 updatedAt
          capturedAt: prev?.boardId === boardId ? prev.capturedAt : now,
          updatedAt: now,
        };
        set({
          chapters: s.chapters.map((c) => (c.id === chapterId ? { ...c, snapshot } : c)),
        });
        return { ok: true, changed: true, created: !prev, snapshot };
      },
      applyChapterScene: (chapterId) => {
        const s = get();
        const chapter = s.chapters.find((c) => c.id === chapterId);
        if (!chapter) {
          return {
            ok: false,
            changed: false,
            moved: 0,
            reparented: 0,
            stateRestored: 0,
            missingCharacters: [],
            missingStates: [],
            missingParents: [],
            error: 'chapter-not-found',
          };
        }
        const snapshot = chapter.snapshot;
        if (!snapshot) {
          return {
            ok: false,
            changed: false,
            moved: 0,
            reparented: 0,
            stateRestored: 0,
            missingCharacters: [],
            missingStates: [],
            missingParents: [],
            error: 'snapshot-not-found',
          };
        }
        const board = s.boards[snapshot.boardId];
        if (!board) {
          return {
            ok: false,
            changed: false,
            moved: 0,
            reparented: 0,
            stateRestored: 0,
            missingCharacters: [],
            missingStates: [],
            missingParents: [],
            error: 'board-not-found',
          };
        }
        const r: ApplyChapterSceneResult = applyChapterScenePure(board, snapshot);
        if (r.changed) set(setBoardNodes(s, snapshot.boardId, r.nodes));
        return {
          ok: true,
          changed: r.changed,
          moved: r.moved,
          reparented: r.reparented,
          stateRestored: r.stateRestored,
          missingCharacters: r.missingCharacters,
          missingStates: r.missingStates,
          missingParents: r.missingParents,
        };
      },

      createCharacter: (pos) => get().createCharacterOnBoard(get().activeBoardId, pos) ?? '',
      createEnvironment: (pos, size) => get().createEnvironmentOnBoard(get().activeBoardId, pos, size) ?? '',

      createCharacterOnBoard: (boardId, pos, opts) => {
        const s = get();
        const b = s.boards[boardId];
        if (!b) return null;
        // 缺省人物列 x=0：排在既有节点最低处下方
        const y = b.nodes.length ? Math.max(...b.nodes.map((n) => n.position.y + (n.height ?? 150))) + 60 : 0;
        const id = uid();
        const data = initialCharacterData(id);
        const select = opts?.select ?? boardId === s.activeBoardId;
        // 创建即选中：右侧属性面板（SimInspector）立刻可填人名——节点面上不内嵌输入框（v2.3）
        const nodes = select ? b.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)) : b.nodes;
        set({
          boards: {
            ...s.boards,
            [boardId]: {
              ...b,
              nodes: [
                ...nodes,
                { id, type: 'character', position: pos ?? { x: 0, y }, data, zIndex: CHAR_ZINDEX, selected: select },
              ],
            },
          },
        });
        return id;
      },

      createEnvironmentOnBoard: (boardId, pos, size, opts) => {
        const s = get();
        const b = s.boards[boardId];
        if (!b) return null;
        // 缺省环境列 x=320：排在既有节点最低处下方
        const y = b.nodes.length ? Math.max(...b.nodes.map((n) => n.position.y + (n.height ?? 150))) + 60 : 0;
        const id = uid();
        const data: EnvironmentData = { kind: 'environment', name: '', etype: 'building', desc: '' };
        const w = Math.max(ENV_MIN_W, Math.round(size?.w ?? ENV_DEFAULT_W));
        const h = Math.max(ENV_MIN_H, Math.round(size?.h ?? ENV_DEFAULT_H));
        const select = opts?.select ?? boardId === s.activeBoardId;
        // 创建即选中：属性面板立刻可填名称/类型/描述（v2.3）
        const nodes = select ? b.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)) : b.nodes;
        set({
          boards: {
            ...s.boards,
            [boardId]: {
              ...b,
              nodes: [
                ...nodes,
                { id, type: 'environment', position: pos ?? { x: 320, y }, data, width: w, height: h, selected: select },
              ],
            },
          },
        });
        return id;
      },

      updateCharacter: (id, patch) => get().updateCharacterOnBoard(get().activeBoardId, id, patch),
      updateEnvironment: (id, patch) => get().updateEnvironmentOnBoard(get().activeBoardId, id, patch),
      resizeEnvironment: (id, w, h) => get().resizeEnvironmentOnBoard(get().activeBoardId, id, w, h),

      addCharacterState: (id, opts) => get().addCharacterStateOnBoard(get().activeBoardId, id, opts),
      updateCharacterState: (id, patch, stateId) =>
        get().updateCharacterStateOnBoard(get().activeBoardId, id, patch, stateId),
      updateActiveCharacterState: (id, patch) =>
        get().updateActiveCharacterStateOnBoard(get().activeBoardId, id, patch),
      switchCharacterState: (id, stateId) =>
        get().switchCharacterStateOnBoard(get().activeBoardId, id, stateId),
      renameCharacterState: (id, stateId, label) =>
        get().renameCharacterStateOnBoard(get().activeBoardId, id, stateId, label),
      deleteCharacterState: (id, stateId) =>
        get().deleteCharacterStateOnBoard(get().activeBoardId, id, stateId),

      updateCharacterOnBoard: (boardId, id, patch) =>
        set((s) => {
          const b = s.boards[boardId];
          if (!b) return {};
          return setBoardNodes(
            s,
            boardId,
            b.nodes.map((n) =>
              n.id === id && n.data.kind === 'character'
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      ...(patch.name !== undefined ? { name: patch.name } : {}),
                      ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
                    },
                  }
                : n,
            ),
          );
        }),

      addCharacterStateOnBoard: (boardId, id, opts) => {
        const s = get();
        const b = s.boards[boardId];
        const node = b?.nodes.find((n) => n.id === id);
        if (!b || !node || node.data.kind !== 'character') return { ok: false, error: 'not-found' };
        const d = node.data;
        const base = opts?.baseStateId
          ? d.states.find((st) => st.id === opts.baseStateId)
          : activeCharacterState(d);
        if (!base) return { ok: false, error: 'base-not-found' };
        const rawLabel = opts?.label;
        if (rawLabel !== undefined && !rawLabel.trim()) return { ok: false, error: 'empty-label' };
        const label = (rawLabel?.trim() || nextStateLabel(d.states)).slice(0, STATE_LABEL_CAP);
        if (stateLabelTaken(d.states, label)) return { ok: false, error: 'duplicate-label' };
        const stateId = newStateId();
        // 复制基准状态的全部属性（含形象/写真引用），再覆盖块中明确写出的字段
        const next: CharacterState = {
          ...base,
          ...(opts?.patch ?? {}),
          id: stateId,
          label,
        };
        const activate = opts?.activate ?? true;
        set(
          setBoardNodes(
            s,
            boardId,
            b.nodes.map((n) =>
              n.id === id && n.data.kind === 'character'
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      states: [...n.data.states, next],
                      activeStateId: activate ? stateId : n.data.activeStateId,
                    },
                  }
                : n,
            ),
          ),
        );
        return { ok: true, stateId };
      },

      updateCharacterStateOnBoard: (boardId, id, patch, stateId) => {
        const s = get();
        const b = s.boards[boardId];
        const node = b?.nodes.find((n) => n.id === id);
        if (!b || !node || node.data.kind !== 'character') return { ok: false, error: 'not-found' };
        const targetId = stateId ?? node.data.activeStateId;
        const target = node.data.states.find((st) => st.id === targetId);
        if (!target) return { ok: false, error: 'not-found' };
        const next: CharacterState = { ...target, ...patch };
        if ('age' in patch) {
          const age = sanitizeStateAge(patch.age);
          if (age === undefined) delete next.age;
          else next.age = age;
        }
        if ('portraitKey' in patch) {
          const key = patch.portraitKey?.trim();
          if (key) next.portraitKey = key;
          else delete next.portraitKey;
        }
        if ('avatar' in patch && !patch.avatar?.trim()) delete next.avatar;
        if ('relations' in patch && !patch.relations?.trim()) delete next.relations;
        set(
          setBoardNodes(
            s,
            boardId,
            b.nodes.map((n) =>
              n.id === id && n.data.kind === 'character'
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      states: n.data.states.map((st) => (st.id === targetId ? next : st)),
                    },
                  }
                : n,
            ),
          ),
        );
        return { ok: true, stateId: targetId };
      },

      updateActiveCharacterStateOnBoard: (boardId, id, patch) => {
        const node = get().boards[boardId]?.nodes.find((n) => n.id === id);
        if (!node || node.data.kind !== 'character') return { ok: false, error: 'not-found' };
        return get().updateCharacterStateOnBoard(boardId, id, patch, node.data.activeStateId);
      },

      switchCharacterStateOnBoard: (boardId, id, stateId) => {
        const s = get();
        const b = s.boards[boardId];
        const node = b?.nodes.find((n) => n.id === id);
        if (!b || !node || node.data.kind !== 'character') return { ok: false, error: 'not-found' };
        if (!node.data.states.some((st) => st.id === stateId)) return { ok: false, error: 'not-found' };
        set(
          setBoardNodes(
            s,
            boardId,
            b.nodes.map((n) =>
              n.id === id && n.data.kind === 'character' ? { ...n, data: { ...n.data, activeStateId: stateId } } : n,
            ),
          ),
        );
        return { ok: true, stateId };
      },

      renameCharacterStateOnBoard: (boardId, id, stateId, label) => {
        const s = get();
        const b = s.boards[boardId];
        const node = b?.nodes.find((n) => n.id === id);
        if (!b || !node || node.data.kind !== 'character') return { ok: false, error: 'not-found' };
        if (!node.data.states.some((st) => st.id === stateId)) return { ok: false, error: 'not-found' };
        const nextLabel = label.trim().slice(0, STATE_LABEL_CAP);
        if (!nextLabel) return { ok: false, error: 'empty-label' };
        if (stateLabelTaken(node.data.states, nextLabel, stateId)) return { ok: false, error: 'duplicate-label' };
        set(
          setBoardNodes(
            s,
            boardId,
            b.nodes.map((n) =>
              n.id === id && n.data.kind === 'character'
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      states: n.data.states.map((st) => (st.id === stateId ? { ...st, label: nextLabel } : st)),
                    },
                  }
                : n,
            ),
          ),
        );
        return { ok: true, stateId };
      },

      deleteCharacterStateOnBoard: (boardId, id, stateId) => {
        const s = get();
        const b = s.boards[boardId];
        const node = b?.nodes.find((n) => n.id === id);
        if (!b || !node || node.data.kind !== 'character') return { ok: false, error: 'not-found' };
        const index = node.data.states.findIndex((st) => st.id === stateId);
        if (index < 0) return { ok: false, error: 'not-found' };
        if (node.data.states.length <= 1) return { ok: false, error: 'last-state' };
        if (index === 0) return { ok: false, error: 'protected' }; // 默认状态不可删（可改名）
        const removed = node.data.states[index];
        const states = node.data.states.filter((st) => st.id !== stateId);
        set(
          setBoardNodes(
            s,
            boardId,
            b.nodes.map((n) =>
              n.id === id && n.data.kind === 'character'
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      states,
                      activeStateId: n.data.activeStateId === stateId ? states[0].id : n.data.activeStateId,
                    },
                  }
                : n,
            ),
          ),
        );
        return { ok: true, removed };
      },

      updateEnvironmentOnBoard: (boardId, id, patch) =>
        set((s) => {
          const b = s.boards[boardId];
          if (!b) return {};
          return setBoardNodes(
            s,
            boardId,
            b.nodes.map((n) => (n.id === id && n.data.kind === 'environment' ? { ...n, data: { ...n.data, ...patch } } : n)),
          );
        }),

      resizeEnvironmentOnBoard: (boardId, id, w, h) =>
        set((s) => {
          const b = s.boards[boardId];
          if (!b) return {};
          return setBoardNodes(
            s,
            boardId,
            b.nodes.map((n) =>
              n.id === id && n.data.kind === 'environment'
                ? { ...n, width: Math.max(ENV_MIN_W, Math.round(w)), height: Math.max(ENV_MIN_H, Math.round(h)) }
                : n,
            ),
          );
        }),

      reparentNode: (childId, parentId) => get().reparentNodeOnBoard(get().activeBoardId, childId, parentId),

      reparentNodeOnBoard: (boardId, childId, parentId) => {
        const s = get();
        const b = s.boards[boardId];
        if (!b) return;
        const child = b.nodes.find((n) => n.id === childId);
        if (!child) return;
        if ((child.parentId ?? null) === parentId) return; // 已是目标父子，无操作
        const byId = new Map(b.nodes.map((n) => [n.id, n]));
        if (parentId) {
          if (parentId === childId) return; // 自挂防御：self-parent 会让 RF12 定位坏掉、节点凭空消失（v2.1 踩坑）
          const parent = byId.get(parentId);
          if (!parent || parent.data.kind !== 'environment') return;
          if (isDescendantOf(parentId, childId, byId)) return; // 环：不能挂到自己后代
        }
        const abs = absPositionOf(child, byId);
        let pos = abs;
        if (parentId) {
          const pabs = absPositionOf(byId.get(parentId)!, byId);
          pos = { x: abs.x - pabs.x, y: abs.y - pabs.y };
        }
        const nodes = sortParentsFirst(
          b.nodes.map((n) =>
            n.id === childId
              // ⚠ 不设 expandParent：否则子节点拖出父缘时父容器被自动撑大、中心点永远出不去（v2 踩坑）
              ? { ...n, parentId: parentId ?? undefined, position: pos, zIndex: n.data.kind === 'character' ? CHAR_ZINDEX : undefined }
              : n,
          ),
        );
        set(setBoardNodes(s, boardId, nodes));
      },

      deleteNode: (id) => {
        const s = get();
        const b = s.boards[s.activeBoardId];
        if (!b || !b.nodes.some((n) => n.id === id)) return;
        // 后代提升回根：按删除前的父链换算绝对坐标（ towns 删掉不该连房子一起没）
        const byId = new Map(b.nodes.map((n) => [n.id, n]));
        const lifted = new Map(
          b.nodes
            .filter((n) => n.id !== id && isDescendantOf(n.id, id, byId))
            .map((n) => [n.id, { ...n, parentId: undefined, position: absPositionOf(n, byId), zIndex: n.data.kind === 'character' ? CHAR_ZINDEX : undefined }]),
        );
        set(
          setBoardNodes(
            s,
            s.activeBoardId,
            b.nodes.filter((n) => n.id !== id).map((n) => lifted.get(n.id) ?? n),
            b.edges.filter((e) => e.source !== id && e.target !== id),
          ),
        );
      },

      copyNodesToBoard: (opts) => {
        const s = get();
        const source = s.boards[opts.sourceBoardId ?? s.activeBoardId];
        const target = s.boards[opts.targetBoardId];
        if (!source) throw new Error('源画布不存在');
        if (!target) throw new Error('目标画布不存在');
        const { targetBoardId, sourceBoardId: _src, switchAfter, selectResult, ...planInput } = opts;
        const result = planBoardCopy(source, target, planInput);
        const clean = sanitizeSimNodes(result.nodes, result.edges);
        const selectedIds = selectResult ? new Set(Object.values(result.idMap)) : null;
        const nodes = selectedIds
          ? clean.nodes.map((n) => (selectedIds.has(n.id) ? { ...n, selected: true } : n))
          : clean.nodes;
        const nextBoard: SimBoard = { ...target, nodes, edges: clean.edges };
        set({
          boards: { ...s.boards, [targetBoardId]: nextBoard },
          ...(switchAfter ? { activeBoardId: targetBoardId } : {}),
        });
        return { ...result, nodes, edges: clean.edges };
      },

      // 载入存档/新建作品：整体替换画布与作品状态；rules 等不传 = 保留现值
      replaceState: (snap) =>
        set((prev) => {
          const volumes = snap.volumes !== undefined ? sanitizeVolumes(snap.volumes) : prev.volumes;
          const chapters = snap.chapters !== undefined ? sanitizeChapters(snap.chapters) : prev.chapters;
          // 区域按章节当前所属画布过滤，所以 chapters 必须先于 boards 清洗
          const boards = sanitizeBoards(snap.boards, volumes, undefined, chapters);
          const activeBoardId = snap.activeBoardId && boards[snap.activeBoardId] ? snap.activeBoardId : DEFAULT_BOARD_ID;
          return {
            ...prev,
            boards,
            activeBoardId,
            ...(snap.graphName !== undefined ? { graphName: snap.graphName } : {}),
            ...(snap.rules !== undefined ? { rules: rulesText(snap.rules) } : {}),
            ...(snap.outlineRules !== undefined ? { outlineRules: rulesText(snap.outlineRules) } : {}),
            ...(snap.charGenRules !== undefined ? { charGenRules: rulesText(snap.charGenRules) } : {}),
            ...(snap.mainGoal !== undefined ? { mainGoal: rulesText(snap.mainGoal) } : {}),
            ...(snap.volumes !== undefined ? { volumes } : {}),
            ...(snap.chapters !== undefined ? { chapters, outlineBusyId: null, contentBusyId: null } : {}),
            ...(snap.responsibleId !== undefined ? { responsibleId: snap.responsibleId } : {}),
            ...(snap.cover !== undefined ? { cover: snap.cover } : {}),
          };
        }),

      onNodesChange: (changes) => {
        // Del/Backspace 删除（含框选多选）：confirm 后删除；其余（位置/尺寸/选择）照常——
        // NodeResizer 的 dimensions change 也走这里 applyNodeChanges 写 node.width/height
        const removes = changes.filter((c) => c.type === 'remove');
        const rest = changes.filter((c) => c.type !== 'remove') as NodeChange<SimNodeType>[];
        if (rest.length) {
          set((s) => {
            const b = s.boards[s.activeBoardId];
            if (!b) return {};
            return setBoardNodes(s, s.activeBoardId, applyNodeChanges(rest, b.nodes));
          });
        }
        if (!removes.length) return;
        const active = get().boards[get().activeBoardId];
        const targets = removes
          .map((r) => active?.nodes.find((n) => n.id === r.id))
          .filter((n): n is SimNodeType => !!n);
        if (!targets.length) return;
        if (!window.confirm(`删除选中的 ${targets.length} 个节点？（父环境的内部节点将提升回根层）`)) return;
        targets.forEach((n) => get().deleteNode(n.id));
      },
      onEdgesChange: (changes) =>
        set((s) => {
          const b = s.boards[s.activeBoardId];
          if (!b) return {};
          return setBoardNodes(s, s.activeBoardId, b.nodes, applyEdgeChanges(changes, b.edges));
        }),
    }),
    {
      name: 'nc2-sim-v1',
      version: 2,
      storage: studioPersistStorage,
      // 本地恢复后 sanitize 兜底（画布集合/节点/连线/卷/章节）。
      // 必须放 merge：persist 的 hydrate 在 create() 期间同步执行，onRehydrateStorage 回调里
      // useStudioStore 尚未初始化（TDZ），setState 抛 ReferenceError 且被 persist 静默吞掉
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        const merged = { ...current, ...p } as Record<string, unknown>;
        const legacyNodes = merged.nodes;
        const legacyEdges = merged.edges;
        delete merged.nodes;
        delete merged.edges;
        const volumes = sanitizeVolumes(merged.volumes);
        // 区域按章节归属画布过滤，chapters 必须先于 boards 清洗
        const chapters = sanitizeChapters(merged.chapters);
        // ⚠ 只能用持久化数据里的 boards：merged 已并入 current 的默认空 boards，
        // 拿它当新格式会把旧档顶层 nodes/edges 当成「已有画布」而丢掉（旧档迁移必须走 legacy 参数）
        const boards = sanitizeBoards(p.boards, volumes, { nodes: legacyNodes, edges: legacyEdges }, chapters);
        const activeBoardId =
          typeof merged.activeBoardId === 'string' && boards[merged.activeBoardId]
            ? merged.activeBoardId
            : DEFAULT_BOARD_ID;
        // 规则兜底：string 直通、旧对象形态 {world,style} 拼接、损坏回空串（新增字段无需版本迁移）
        // 章节列表兜底重建；大纲生成瞬态归 null
        return {
          ...(merged as unknown as SimState),
          boards,
          activeBoardId,
          rules: rulesText(merged.rules),
          outlineRules: rulesText(merged.outlineRules),
          charGenRules: rulesText(merged.charGenRules),
          mainGoal: rulesText(merged.mainGoal),
          volumes,
          chapters,
          responsibleId: typeof merged.responsibleId === 'string' ? merged.responsibleId : '',
          // 封面兜底：只认本地图片 data URL（旧档/损坏缓存回未设置）
          cover: typeof merged.cover === 'string' && merged.cover.startsWith('data:image/') ? merged.cover : '',
          outlineBusyId: null,
          contentBusyId: null,
        };
      },
    },
  ),
);

// 初始化/恢复完成：把内存状态视为已保存基线；之后的选中、测量、平移不会误报“未保存”
studioPersistStorage.markClean(useStudioStore.getState());

export function useActiveBoard(): SimBoard | undefined {
  return useStudioStore(selectActiveBoard);
}

export function useActiveNodes(): SimNodeType[] {
  return useStudioStore(selectActiveNodes);
}

export function useActiveEdges(): Edge[] {
  return useStudioStore(selectActiveEdges);
}

/** 命令式读取（引擎/事件处理器用；组件内请用 hooks） */
export function getActiveBoard(s = useStudioStore.getState()): SimBoard | undefined {
  return s.boards[s.activeBoardId];
}

export function getActiveNodes(s = useStudioStore.getState()): SimNodeType[] {
  return s.boards[s.activeBoardId]?.nodes ?? EMPTY_NODES;
}

export function getActiveEdges(s = useStudioStore.getState()): Edge[] {
  return s.boards[s.activeBoardId]?.edges ?? EMPTY_EDGES;
}
