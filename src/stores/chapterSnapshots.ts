/** 📸 章节快照纯逻辑（R2/R3）：区域命中采集、环境引用冻结、刷新、过期检测、存档清洗。
 *  只依赖类型 + 几何/状态纯工具，不引入 store；UI、store、引擎与临时脚本可共用。
 *
 *  几何约定：
 *  - 节点位置用父链绝对坐标（absPositionOf）；人物命中用「中心点」。
 *  - 区域边缘带（默认较小的 15%，24–80px）内 → mentioned（仅提及）；内侧 → present（在场）。
 *  - 区域坐标/尺寸本身存绝对画布坐标。
 *
 *  快照只引用人物/状态 id，并冻结采集时标签、环境路径与环境描述；人物属性仍从画布解析，
 *  因此原地修改状态会反映到历史章，UI 用指纹对比提示“未同步”。 */
import type {
  CastRole,
  ChapterRegion,
  ChapterSnapshot,
  ChapterSnapshotEntry,
  CharacterData,
  CharacterState,
  EnvironmentType,
  SimBoard,
  SimNodeType,
  SnapshotEnvRef,
  SnapshotSource,
} from '../types/sim';
import { ENV_TYPES } from '../types/sim';
import { absPositionOf } from './graphGeom';
import { activeCharacterState } from './characterStates';
import { sanitizeRegionRect, sanitizeRegions } from './chapterRegions';

export const SNAPSHOT_MAX_REGIONS = 8;
export const SNAPSHOT_MAX_ENTRIES = 200;
export const SNAPSHOT_MAX_ENVS = 64;
export const SNAPSHOT_ENV_DESC_CAP = 240;
export const SNAPSHOT_PATH_CAP = 400;
export const SNAPSHOT_NAME_CAP = 80;
export const SNAPSHOT_LABEL_CAP = 60;
export const SNAPSHOT_FINGERPRINT_CAP = 64;

/** 人物节点无显式 width/height；measured 缺失时用近似卡片尺寸做命中兜底 */
const CHAR_FALLBACK_W = 96;
const CHAR_FALLBACK_H = 96;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 左/上包含，右/下不包含（相邻矩形不重叠） */
export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/** 边缘带宽度：较小的 15%，钳在 24–80px；但不超过短边的 1/3，避免小区域整块都算边缘 */
export function regionEdgeBand(r: Rect): number {
  const min = Math.max(1, Math.min(r.width, r.height));
  return Math.max(0, Math.min(80, Math.max(24, min * 0.15), Math.floor(min / 3)));
}

/** 中心点是否位于区域边缘带（命中区域但不在内侧） */
export function pointInRegionEdge(r: Rect, p: Point): boolean {
  if (!rectContainsPoint(r, p)) return false;
  const band = regionEdgeBand(r);
  return (
    p.x - r.x < band ||
    r.x + r.width - p.x < band ||
    p.y - r.y < band ||
    r.y + r.height - p.y < band
  );
}

/** 状态属性稳定指纹：不含 label（重命名不算内容变化），用于检测采集后的原地修改。
 *  FNV-1a 32 位即可：只做“是否变化”比较，不做安全用途。 */
export function stateFingerprint(state: CharacterState): string {
  const parts = [
    typeof state.age === 'number' ? state.age : '',
    state.avatar ?? '',
    state.basicInfo,
    state.identityInfo,
    state.relations ?? '',
    state.portraitKey ?? '',
  ];
  const text = JSON.stringify(parts);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function pickStr(v: unknown, cap = SNAPSHOT_PATH_CAP): string {
  return typeof v === 'string' ? v.slice(0, cap) : '';
}

function finite(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
}

function nodeSize(n: SimNodeType): { w: number; h: number } {
  return {
    w: n.width ?? n.measured?.width ?? (n.data.kind === 'character' ? CHAR_FALLBACK_W : 0),
    h: n.height ?? n.measured?.height ?? (n.data.kind === 'character' ? CHAR_FALLBACK_H : 0),
  };
}

/** 中心点绝对坐标（人物采集/区域环境判定共用） */
export function absCenterOf(n: SimNodeType, byId: Map<string, SimNodeType>): Point {
  const a = absPositionOf(n, byId);
  const { w, h } = nodeSize(n);
  return { x: a.x + w / 2, y: a.y + h / 2 };
}

/** 环境链路径：城镇「…」＞建筑「…」＞房间「…」，含环境自身；环保护 */
export function envPathOf(env: SimNodeType, byId: Map<string, SimNodeType>): string {
  const chain: SimNodeType[] = [];
  const guard = new Set<string>();
  let cur: SimNodeType | undefined = env;
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    if (cur.data.kind === 'environment') chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain
    .map((n) => {
      const d = n.data as { name?: string; etype?: EnvironmentType };
      return `${ENV_LABELS[d.etype ?? 'building']}「${(d.name ?? '').trim() || '未命名'}」`;
    })
    .join('＞')
    .slice(0, SNAPSHOT_PATH_CAP);
}

const ENV_LABELS: Record<EnvironmentType, string> = {
  room: '房间',
  building: '建筑',
  community: '社区',
  town: '城镇',
  area: '区域',
  bed: '床',
  item: '物品',
};

/** 人物当前所属直接父环境（仅当 parent 是环境节点） */
export function parentEnvOf(n: SimNodeType, byId: Map<string, SimNodeType>): SimNodeType | undefined {
  const p = n.parentId ? byId.get(n.parentId) : undefined;
  return p && p.data.kind === 'environment' ? p : undefined;
}

/** 人物环境路径（无环境父节点时为空串） */
export function envPathForCharacter(n: SimNodeType, byId: Map<string, SimNodeType>): string {
  const p = parentEnvOf(n, byId);
  return p ? envPathOf(p, byId) : '';
}

function entryFromNode(
  n: SimNodeType,
  byId: Map<string, SimNodeType>,
  role: CastRole,
  stateId?: string,
): ChapterSnapshotEntry {
  const d = n.data as CharacterData;
  const abs = absPositionOf(n, byId);
  const parent = parentEnvOf(n, byId);
  const state = (stateId ? d.states.find((s) => s.id === stateId) : undefined) ?? activeCharacterState(d);
  return {
    characterId: n.id,
    stateId: state.id,
    role,
    x: abs.x,
    y: abs.y,
    ...(parent ? { parentEnvId: parent.id } : {}),
    envPathAtCapture: envPathForCharacter(n, byId),
    nameAtCapture: (d.name || '未命名').trim().slice(0, SNAPSHOT_NAME_CAP),
    stateLabelAtCapture: state.label.slice(0, SNAPSHOT_LABEL_CAP),
    stateFingerprintAtCapture: stateFingerprint(state),
    origin: 'region',
  };
}

/** 采集区域名单：中心点在区域内的人物；边缘带默认 mentioned，内侧 present。
 *  按名称、状态、id 排序，保证同一画布多次采集结果稳定。 */
export function collectRegionRoster(board: SimBoard, region: Rect): ChapterSnapshotEntry[] {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const out: ChapterSnapshotEntry[] = [];
  for (const n of board.nodes) {
    if (n.data.kind !== 'character') continue;
    const center = absCenterOf(n, byId);
    if (!rectContainsPoint(region, center)) continue;
    out.push(entryFromNode(n, byId, pointInRegionEdge(region, center) ? 'mentioned' : 'present'));
  }
  out.sort((a, b) =>
    a.role !== b.role
      ? (a.role === 'present' ? -1 : 1)
      : a.nameAtCapture.localeCompare(b.nameAtCapture, 'zh-Hans-CN') ||
        a.stateLabelAtCapture.localeCompare(b.stateLabelAtCapture, 'zh-Hans-CN') ||
        a.characterId.localeCompare(b.characterId),
  );
  return out.slice(0, SNAPSHOT_MAX_ENTRIES);
}

/** 快照环境引用：名单人物祖先环境 + 中心落在区域内的环境；冻结名称/类型/路径/截断描述。 */
export function collectSnapshotEnvRefs(
  board: SimBoard,
  region: Rect,
  entries: ChapterSnapshotEntry[],
): SnapshotEnvRef[] {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const picked = new Map<string, SimNodeType>();

  const addAncestors = (id: string | undefined) => {
    const guard = new Set<string>();
    let cur = id ? byId.get(id) : undefined;
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      if (cur.data.kind === 'environment') picked.set(cur.id, cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  };
  entries.forEach((e) => addAncestors(e.parentEnvId));

  for (const n of board.nodes) {
    if (n.data.kind !== 'environment') continue;
    const center = absCenterOf(n, byId);
    if (rectContainsPoint(region, center)) picked.set(n.id, n);
  }

  const out: SnapshotEnvRef[] = [];
  for (const n of picked.values()) {
    if (n.data.kind !== 'environment') continue;
    const d = n.data;
    out.push({
      id: n.id,
      name: (d.name.trim() || '未命名').slice(0, SNAPSHOT_NAME_CAP),
      etype: d.etype,
      path: envPathOf(n, byId),
      desc: d.desc.trim().slice(0, SNAPSHOT_ENV_DESC_CAP),
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN') || a.id.localeCompare(b.id));
  return out.slice(0, SNAPSHOT_MAX_ENVS);
}

export interface CaptureSnapshotOptions {
  source?: SnapshotSource;
  now?: number;
}

/** 首次采集：区域 + 自动名单 + 环境引用全部冻结 */
export function captureChapterSnapshot(
  board: SimBoard,
  region: ChapterRegion,
  opts: CaptureSnapshotOptions = {},
): ChapterSnapshot {
  const now = opts.now ?? Date.now();
  const rect = { ...region, ...sanitizeRegionRect(region) };
  const entries = collectRegionRoster(board, rect);
  return {
    version: 1,
    boardId: board.id,
    capturedAt: now,
    updatedAt: now,
    source: opts.source ?? 'manual',
    regions: [rect],
    entries,
    envRefs: collectSnapshotEnvRefs(board, rect, entries),
  };
}

/** 刷新：重采自动名单 + 更新几何/环境引用。
 *  - 手动词条始终保留；区域自动条目的角色/状态若被人工改过（roleLocked/stateLocked）也保留；
 *  - 自动条目已不在区域 → 移除（人工加过的除外）；
 *  - 人物/状态已从画布缺失 → 保留采集值，等待 UI 标“资料缺失”；
 *  - 区域不再存在时保留旧几何，由调用方决定是否允许刷新。 */
export function refreshChapterSnapshot(
  snapshot: ChapterSnapshot,
  board: SimBoard,
  region: ChapterRegion,
  opts: { now?: number } = {},
): ChapterSnapshot {
  const now = opts.now ?? Date.now();
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const rect = { ...region, ...sanitizeRegionRect(region) };
  const auto = new Map(collectRegionRoster(board, rect).map((e) => [e.characterId, e]));
  const existing = new Map(snapshot.entries.map((e) => [e.characterId, e]));
  const merged: ChapterSnapshotEntry[] = [];

  const applyCurrentState = (e: ChapterSnapshotEntry, node: SimNodeType & { data: CharacterData }): ChapterSnapshotEntry => {
    const abs = absPositionOf(node, byId);
    const parent = parentEnvOf(node, byId);
    const current = node.data.states.find((s) => s.id === e.stateId);
    return {
      ...e,
      x: abs.x,
      y: abs.y,
      ...(parent ? { parentEnvId: parent.id } : { parentEnvId: undefined }),
      envPathAtCapture: envPathForCharacter(node, byId),
      nameAtCapture: (node.data.name || '未命名').trim().slice(0, SNAPSHOT_NAME_CAP),
      ...(current
        ? {
            stateLabelAtCapture: current.label.slice(0, SNAPSHOT_LABEL_CAP),
            stateFingerprintAtCapture: stateFingerprint(current),
          }
        : {}),
    };
  };

  for (const a of auto.values()) {
    const old = existing.get(a.characterId);
    if (!old) {
      merged.push(a);
      continue;
    }
    const node = byId.get(a.characterId) as (SimNodeType & { data: CharacterData }) | undefined;
    const preserveRole = old.origin === 'manual' || old.roleLocked;
    const preserveState = old.origin === 'manual' || old.stateLocked;
    let e: ChapterSnapshotEntry = {
      ...a,
      origin: old.origin,
      role: preserveRole ? old.role : a.role,
      stateId: preserveState ? old.stateId : a.stateId,
      ...(old.roleLocked ? { roleLocked: true } : {}),
      ...(old.stateLocked ? { stateLocked: true } : {}),
    };
    if (node) e = applyCurrentState(e, node);
    merged.push(e);
  }

  // 人工条目 / 非本区域自动条目：只保留人工条目
  for (const old of snapshot.entries) {
    if (auto.has(old.characterId)) continue;
    if (old.origin !== 'manual') continue;
    const node = byId.get(old.characterId) as (SimNodeType & { data: CharacterData }) | undefined;
    merged.push(node ? applyCurrentState(old, node) : old);
  }

  merged.sort((a, b) =>
    a.role !== b.role ? (a.role === 'present' ? -1 : 1) : a.nameAtCapture.localeCompare(b.nameAtCapture, 'zh-Hans-CN'),
  );
  const entries = merged.slice(0, SNAPSHOT_MAX_ENTRIES);
  return {
    ...snapshot,
    updatedAt: now,
    regions: [rect],
    entries,
    envRefs: collectSnapshotEnvRefs(board, rect, entries),
  };
}

/** 手动添加条目：默认仅提及 + 当前状态；已存在则原样返回 */
export function manualSnapshotEntry(
  board: SimBoard,
  characterId: string,
  opts: { role?: CastRole; stateId?: string } = {},
): ChapterSnapshotEntry | null {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const node = byId.get(characterId);
  if (!node || node.data.kind !== 'character') return null;
  const entry = entryFromNode(node, byId, opts.role ?? 'mentioned', opts.stateId);
  return {
    ...entry,
    origin: 'manual',
    ...(opts.role ? { roleLocked: true } : {}),
    ...(opts.stateId ? { stateLocked: true } : {}),
  };
}

export type SnapshotIssueCode =
  | 'source-board-missing'
  | 'region-missing'
  | 'region-moved'
  | 'roster-changed'
  | 'missing-character'
  | 'missing-state'
  | 'state-changed'
  | 'name-changed'
  | 'env-changed';

export interface SnapshotStaleness {
  codes: SnapshotIssueCode[];
  /** 人物或状态在源画布上解析不到的条目数 */
  missingCount: number;
  /** 解析到但内容/名称/环境与采集时不同的条目数 */
  changedCount: number;
  /** 自动名单与当前区域采集结果的差集条数（新增 + 移除） */
  rosterDelta: number;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** 快照与源画布/当前区域的差异：用于“未同步”提示（不自动刷新）。
 *  源画布缺失时仍检查条目（无法解析），返回 source-board-missing。 */
export function snapshotStaleness(
  snapshot: ChapterSnapshot,
  board: SimBoard | undefined,
  currentRegion: ChapterRegion | undefined,
): SnapshotStaleness {
  const codes = new Set<SnapshotIssueCode>();
  let missingCount = 0;
  let changedCount = 0;
  let rosterDelta = 0;
  const byId = board ? new Map(board.nodes.map((n) => [n.id, n])) : new Map<string, SimNodeType>();

  if (!board) {
    codes.add('source-board-missing');
    const missing = snapshot.entries.filter((e) => !byId.has(e.characterId)).length;
    return { codes: [...codes], missingCount: missing, changedCount: 0, rosterDelta: 0 };
  }

  const frozen = snapshot.regions[0];
  if (!currentRegion) {
    codes.add('region-missing');
  } else if (frozen && !sameRect(frozen, currentRegion)) {
    codes.add('region-moved');
  }

  const autoNow = currentRegion ? collectRegionRoster(board, currentRegion) : [];
  const autoIds = new Set(snapshot.entries.filter((e) => e.origin === 'region').map((e) => e.characterId));
  const nowIds = new Set(autoNow.map((e) => e.characterId));
  for (const id of nowIds) if (!autoIds.has(id)) rosterDelta++;
  for (const id of autoIds) if (!nowIds.has(id)) rosterDelta++;
  if (rosterDelta) codes.add('roster-changed');

  for (const e of snapshot.entries) {
    const n = byId.get(e.characterId);
    if (!n || n.data.kind !== 'character') {
      missingCount++;
      codes.add('missing-character');
      continue;
    }
    const state = n.data.states.find((s) => s.id === e.stateId);
    if (!state) {
      missingCount++;
      codes.add('missing-state');
      continue;
    }
    let changed = false;
    if ((n.data.name || '未命名').trim() !== e.nameAtCapture || state.label !== e.stateLabelAtCapture) {
      changed = true;
      codes.add('name-changed');
    }
    if (stateFingerprint(state) !== e.stateFingerprintAtCapture) {
      changed = true;
      codes.add('state-changed');
    }
    if (envPathForCharacter(n, byId) !== e.envPathAtCapture) {
      changed = true;
      codes.add('env-changed');
    }
    if (changed) changedCount++;
  }

  return { codes: [...codes], missingCount, changedCount, rosterDelta };
}

const SNAPSHOT_ISSUE_LABELS: Record<SnapshotIssueCode, string> = {
  'source-board-missing': '来源画布已不存在',
  'region-missing': '本章区域已删除',
  'region-moved': '区域位置/大小已变化',
  'roster-changed': '区域内人物名单已变化',
  'missing-character': '名单人物已不存在',
  'missing-state': '名单状态已不存在',
  'state-changed': '名单状态内容已被修改',
  'name-changed': '人物名或状态标签已变化',
  'env-changed': '人物环境归属已变化',
};

export function snapshotIssueLabel(code: SnapshotIssueCode): string {
  return SNAPSHOT_ISSUE_LABELS[code];
}

/** 供生成前提示/面板一行展示：无问题返回空串 */
export function snapshotIssueText(
  snapshot: ChapterSnapshot,
  board: SimBoard | undefined,
  currentRegion: ChapterRegion | undefined,
): string {
  const s = snapshotStaleness(snapshot, board, currentRegion);
  if (!s.codes.length) return '';
  return s.codes.map((c) => SNAPSHOT_ISSUE_LABELS[c]).join('；');
}

function sanitizeRole(v: unknown): CastRole {
  return v === 'present' ? 'present' : 'mentioned';
}

function sanitizeSource(v: unknown): SnapshotSource {
  return v === 'auto-outline' || v === 'auto-content' || v === 'manual' ? v : 'manual';
}

function sanitizeEnvType(v: unknown): EnvironmentType {
  return typeof v === 'string' && (ENV_TYPES as readonly string[]).includes(v)
    ? (v as EnvironmentType)
    : 'building';
}

/** 存档/persist 恢复：重建快照白名单字段、去重、截断；坏数据返回 undefined（旧章节保持无快照）。
 *  源画布不在当前数据中也保留（跨卷/删卷后仍可展示与提示）。 */
export function sanitizeChapterSnapshot(raw: unknown): ChapterSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const boardId = pickStr(o.boardId, 128).trim();
  if (!boardId) return undefined;

  const now = Date.now();
  const capturedAt = finite(o.capturedAt, now) || now;
  const updatedAt = finite(o.updatedAt, capturedAt) || capturedAt;
  const regions = sanitizeRegions(o.regions).slice(0, SNAPSHOT_MAX_REGIONS);

  const seenChars = new Set<string>();
  const entries: ChapterSnapshotEntry[] = [];
  for (const rawEntry of Array.isArray(o.entries) ? o.entries : []) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const e = rawEntry as Record<string, unknown>;
    const characterId = pickStr(e.characterId, 128).trim();
    const stateId = pickStr(e.stateId, 128).trim();
    if (!characterId || !stateId || seenChars.has(characterId)) continue;
    seenChars.add(characterId);
    const origin = e.origin === 'manual' ? 'manual' : 'region';
    const parentEnvId = pickStr(e.parentEnvId, 128).trim();
    entries.push({
      characterId,
      stateId,
      role: sanitizeRole(e.role),
      x: finite(e.x),
      y: finite(e.y),
      ...(parentEnvId ? { parentEnvId } : {}),
      envPathAtCapture: pickStr(e.envPathAtCapture).trim(),
      nameAtCapture: pickStr(e.nameAtCapture, SNAPSHOT_NAME_CAP).trim() || '未命名',
      stateLabelAtCapture: pickStr(e.stateLabelAtCapture, SNAPSHOT_LABEL_CAP).trim() || '状态',
      stateFingerprintAtCapture: pickStr(e.stateFingerprintAtCapture, SNAPSHOT_FINGERPRINT_CAP).trim(),
      origin,
      ...(e.roleLocked === true ? { roleLocked: true } : {}),
      ...(e.stateLocked === true ? { stateLocked: true } : {}),
    });
    if (entries.length >= SNAPSHOT_MAX_ENTRIES) break;
  }

  const seenEnv = new Set<string>();
  const envRefs: SnapshotEnvRef[] = [];
  for (const rawEnv of Array.isArray(o.envRefs) ? o.envRefs : []) {
    if (!rawEnv || typeof rawEnv !== 'object') continue;
    const e = rawEnv as Record<string, unknown>;
    const id = pickStr(e.id, 128).trim();
    if (!id || seenEnv.has(id)) continue;
    seenEnv.add(id);
    envRefs.push({
      id,
      name: pickStr(e.name, SNAPSHOT_NAME_CAP).trim() || '未命名',
      etype: sanitizeEnvType(e.etype),
      path: pickStr(e.path).trim(),
      desc: pickStr(e.desc, SNAPSHOT_ENV_DESC_CAP).trim(),
    });
    if (envRefs.length >= SNAPSHOT_MAX_ENVS) break;
  }

  return {
    version: 1,
    boardId,
    capturedAt,
    updatedAt,
    source: sanitizeSource(o.source),
    regions,
    entries,
    envRefs,
  };
}
