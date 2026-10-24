/** 📐 章节区域（v2.31）纯逻辑：几何清洗、章节→画布解析、跨板清理。
 *  只用类型与 boardOps，不引入 store，便于 UI / store / 引擎共用与临时脚本断言。 */
import type { ChapterRegion, SimBoard, SimChapter, SimVolume } from '../types/sim';
import { DEFAULT_BOARD_ID, volumeBoardId } from './boardOps';
import { uid } from '../utils/id';

export const REGION_MIN_W = 120;
export const REGION_MIN_H = 80;
export const REGION_DEFAULT_W = 360;
export const REGION_DEFAULT_H = 240;

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ChapterRegionPatch = Partial<Pick<ChapterRegion, 'x' | 'y' | 'width' | 'height' | 'color'>>;

export interface ChapterRegionCreateOptions {
  id?: string;
  color?: string;
}

export type ChapterRegionError = 'board-not-found' | 'chapter-not-found' | 'wrong-board';
export type ChapterRegionAddResult =
  | { ok: true; regionId: string; existing: boolean }
  | { ok: false; error: ChapterRegionError };

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** 几何兜底：缺省/NaN/Infinity 回默认，取整，宽高不低于最小尺寸；负坐标合法 */
export function sanitizeRegionRect(r: Partial<RegionRect> = {}): RegionRect {
  return {
    x: Math.round(num(r.x) ?? 0),
    y: Math.round(num(r.y) ?? 0),
    width: Math.max(REGION_MIN_W, Math.round(num(r.width) ?? REGION_DEFAULT_W)),
    height: Math.max(REGION_MIN_H, Math.round(num(r.height) ?? REGION_DEFAULT_H)),
  };
}

/** 区域数组兜底：重建字段；同画布同章只留第一个；坏章节/坏 id 修复或丢弃。
 *  keepChapter 用于载入时只保留「章节当前所属画布」上的区域。 */
export function sanitizeRegions(
  v: unknown,
  keepChapter?: (chapterId: string) => boolean,
): ChapterRegion[] {
  if (!Array.isArray(v)) return [];
  const seenChapter = new Set<string>();
  const seenId = new Set<string>();
  const out: ChapterRegion[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const chapterId = typeof o.chapterId === 'string' ? o.chapterId.trim() : '';
    if (!chapterId || seenChapter.has(chapterId)) continue;
    if (keepChapter && !keepChapter(chapterId)) continue;
    let id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `rg-${uid()}`;
    if (seenId.has(id)) id = `rg-${uid()}`;
    const color = typeof o.color === 'string' ? o.color.trim().slice(0, 32) : '';
    seenChapter.add(chapterId);
    seenId.add(id);
    out.push({
      id,
      chapterId,
      ...sanitizeRegionRect({
        x: num(o.x),
        y: num(o.y),
        width: num(o.width),
        height: num(o.height),
      }),
      ...(color ? { color } : {}),
    });
  }
  return out;
}

/** 章节所属画布：未分卷/未知卷/画布缺失一律回默认主画布 */
export function chapterBoardOf(
  volumeId: string | undefined,
  volumes: SimVolume[],
  boards?: Record<string, SimBoard>,
): string {
  if (!volumeId || !volumes.some((v) => v.id === volumeId)) return DEFAULT_BOARD_ID;
  const id = volumeBoardId(volumeId);
  return boards && !boards[id] ? DEFAULT_BOARD_ID : id;
}

/** 载入时建立 chapterId → boardId 映射（不含 boards 参数；卷画布缺失时 sanitizeBoards 会补空） */
export function buildChapterBoardMap(chapters: SimChapter[], volumes: SimVolume[]): Map<string, string> {
  return new Map(chapters.map((c) => [c.id, chapterBoardOf(c.volumeId, volumes)]));
}

/** 找某章的区域；优先在期望画布，找不到再全画布兜底（运行期自愈用） */
export function findChapterRegion(
  boards: Record<string, SimBoard>,
  chapterId: string,
  preferredBoardId?: string,
): { boardId: string; region: ChapterRegion } | null {
  if (preferredBoardId) {
    const region = boards[preferredBoardId]?.regions.find((r) => r.chapterId === chapterId);
    if (region) return { boardId: preferredBoardId, region };
  }
  for (const b of Object.values(boards)) {
    if (b.id === preferredBoardId) continue;
    const region = b.regions.find((r) => r.chapterId === chapterId);
    if (region) return { boardId: b.id, region };
  }
  return null;
}

/** 从全部画布删除指定章节的区域；无变化返回原对象，避免无意义持久化 */
export function removeChapterRegions(
  boards: Record<string, SimBoard>,
  chapterIds: ReadonlySet<string>,
): Record<string, SimBoard> {
  if (!chapterIds.size) return boards;
  let changed = false;
  const next = { ...boards };
  for (const [id, b] of Object.entries(boards)) {
    const regions = b.regions.filter((r) => !chapterIds.has(r.chapterId));
    if (regions.length !== b.regions.length) {
      next[id] = { ...b, regions };
      changed = true;
    }
  }
  return changed ? next : boards;
}
