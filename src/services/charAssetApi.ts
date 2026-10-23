/** 人物资源素材库（服务器 charassets/{性别}/{年龄段}/）：人物节点形象图。素材 id = 文件名（去扩展名），全库唯一。 */
import { API_BASE } from '../shared/apiBase';

/** 默认形象：未指定形象的人物节点统一使用此素材 */
export const DEFAULT_CHARASSET = 'man-y-01';

export const CHARASSET_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

export type CharAssetGender = '男' | '女';
export type CharAssetStage = '少年' | '青年' | '中年' | '老年';

export interface CharAsset {
  id: string;
  gender: CharAssetGender;
  stage: CharAssetStage;
}

/** 年龄 → 年龄段（人物形象按年龄段分组）；未设年龄返回 undefined（选择器列出该性别全部素材） */
export function charStageOf(age: number | undefined): CharAssetStage | undefined {
  if (typeof age !== 'number' || !Number.isFinite(age) || age < 0) return undefined;
  if (age < 18) return '少年';
  if (age < 36) return '青年';
  if (age < 60) return '中年';
  return '老年';
}

export function charAssetUrl(id: string): string {
  return `${API_BASE}/api/charasset/file/${encodeURIComponent(id)}`;
}

export async function listCharAssets(): Promise<CharAsset[]> {
  const r = await fetch(`${API_BASE}/api/charassets`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = (await r.json()) as { assets?: CharAsset[] };
  return d.assets ?? [];
}

/** 按性别+年龄段随机挑一个素材 id；该分类无素材或未设年龄返回 undefined（节点回落默认形象） */
export async function pickRandomCharAsset(gender: CharAssetGender, age: number | undefined): Promise<string | undefined> {
  const stage = charStageOf(age);
  if (!stage) return undefined;
  const pool = (await listCharAssets()).filter((a) => a.gender === gender && a.stage === stage);
  if (!pool.length) return undefined;
  return pool[Math.floor(Math.random() * pool.length)].id;
}

export async function uploadCharAsset(
  name: string,
  gender: CharAssetGender,
  stage: CharAssetStage,
  dataUrl: string,
): Promise<void> {
  const r = await fetch(`${API_BASE}/api/charasset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, gender, stage, dataUrl }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `上传失败 HTTP ${r.status}`);
  }
}

export async function deleteCharAsset(id: string): Promise<void> {
  const r = await fetch(`${API_BASE}/api/charasset?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`删除失败 HTTP ${r.status}`);
}
