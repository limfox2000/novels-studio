/** 卷画布基础操作（v2.29）：画布 id、标签、卷名解析、视口清洗。
 *  只依赖类型，供 store / UI / 引擎共用；不引入 store 避免循环依赖。 */
import type { Edge } from '@xyflow/react';
import type { SimBoard, SimNodeType, SimVolume, SimViewport } from '../types/sim';

export const DEFAULT_BOARD_ID = 'main';
export const DEFAULT_BOARD_LABEL = '默认主画布';
/** 🎬 剧情推演舞台：作品内固定一张，与默认主画布/卷画布并列；不参与卷派生、不可删除 */
export const STAGE_BOARD_ID = 'stage';
export const STAGE_BOARD_LABEL = '🎬 舞台';

/** 卷画布 id 固定派生：一卷一画布，迁移/存档无需额外映射表 */
export function volumeBoardId(volumeId: string): string {
  return `vol:${volumeId}`;
}

export function emptyBoard(id: string, volumeId?: string): SimBoard {
  return {
    id,
    ...(volumeId ? { volumeId } : {}),
    nodes: [] as SimNodeType[],
    edges: [] as Edge[],
    regions: [],
  };
}

/** 🎬 舞台板：固定 id、无卷；推演只在这里发生（docs/剧情推演模拟器设计.md §4） */
export function stageBoard(): SimBoard {
  return { id: STAGE_BOARD_ID, kind: 'stage', nodes: [], edges: [], regions: [] };
}

/** 卷名归一化：去引号/书名号/首尾空白，内部空白折叠——用于精确匹配与重名判定 */
export function normalizeVolumeTitle(s: string): string {
  return s
    .replace(/[「」『』《》"'“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 画布标签：默认主画布 / 卷标题 / 异常数据里的未关联画布 */
export function boardLabel(board: SimBoard, volumes: SimVolume[]): string {
  if (board.kind === 'stage' || board.id === STAGE_BOARD_ID) return STAGE_BOARD_LABEL;
  if (!board.volumeId) return DEFAULT_BOARD_LABEL;
  const v = volumes.find((x) => x.id === board.volumeId);
  return v ? v.title || '未命名卷' : `未关联卷的画布（${board.id}）`;
}

export function sanitizeViewport(v: unknown): SimViewport | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const x = typeof o.x === 'number' && Number.isFinite(o.x) ? o.x : NaN;
  const y = typeof o.y === 'number' && Number.isFinite(o.y) ? o.y : NaN;
  const zoom = typeof o.zoom === 'number' && Number.isFinite(o.zoom) ? o.zoom : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return undefined;
  return { x, y, zoom: Math.min(1.6, Math.max(0.15, zoom)) };
}

/** 下一个未占用的自动卷名「第N卷」 */
export function nextVolumeTitle(volumes: SimVolume[]): string {
  const used = new Set(volumes.map((v) => normalizeVolumeTitle(v.title)));
  let n = 1;
  while (used.has(normalizeVolumeTitle(`第${n}卷`))) n++;
  return `第${n}卷`;
}

export type BoardRefResult =
  | { board: SimBoard }
  | { error: 'not-found' | 'ambiguous'; message: string };

/** 卷目标解析：空引用不在这里处理（调用方决定「省略=当前画布」）。
 *  只认默认画布别名与卷标题精确匹配；找不到/重名一律报错，绝不回退当前画布。 */
export function resolveBoardRef(boards: Record<string, SimBoard>, volumes: SimVolume[], ref: string): BoardRefResult {
  const norm = normalizeVolumeTitle(ref);
  if (!norm) return { error: 'not-found', message: '卷名为空' };
  if (norm === DEFAULT_BOARD_LABEL || norm === '主画布') {
    const board = boards[DEFAULT_BOARD_ID];
    return board ? { board } : { error: 'not-found', message: '默认主画布不存在' };
  }
  const hits = volumes.filter((v) => normalizeVolumeTitle(v.title) === norm);
  if (hits.length > 1) return { error: 'ambiguous', message: `卷名「${ref}」有 ${hits.length} 个同名卷，无法确定目标` };
  if (!hits.length) return { error: 'not-found', message: `未找到卷「${ref}」` };
  const board = boards[volumeBoardId(hits[0].id)];
  return board ? { board } : { error: 'not-found', message: `卷「${ref}」没有对应画布` };
}
