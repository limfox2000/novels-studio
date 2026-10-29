/** 🎬 推演档案（SimProfile）默认值 / 校验 / 运行时解析。
 *
 *  与人物档案（characterStates.ts）完全分离：这里只放「数值行为」，不碰姓名/状态/形象。
 *  **零内置内容**：需求来自作品级定义库 SimSchema（作者在设计页定义），人物档案只存实例
 *  （启停 + 覆盖参数）。运行时合并「定义默认 ← 档案实例」。
 *  设计依据：docs/剧情推演模拟器设计.md §6 / §19。 */
import type {
  SimCapabilities,
  SimNeedInstance,
  SimProfile,
  SimStanceKind,
  SimTagDef,
} from '../types/sim';
import {
  emotionInitialsOf,
  sanitizeProfileTags,
  tagDefOf,
  traitIdsOf,
  type SimSchemaIndex,
} from './simSchema';

// ── 世界模型默认常量（设计文档 §5.9；档案未覆盖时取这些值） ──

export const SIM_CAPABILITY_DEFAULTS: SimCapabilities = { speed: 80, perception: 400, observation: 50 };

/** 能力可调范围（UI 输入钳制；速度上限防一拍飞出画布） */
export const SIM_CAPABILITY_RANGES = {
  speed: { min: 10, max: 300, step: 5, unit: 'px/拍' },
  perception: { min: 0, max: 2000, step: 50, unit: 'px' },
  observation: { min: 0, max: 100, step: 5, unit: '' },
} as const;

/** 张望基准耗时（分子）：耗时 = OBSERVE_BASE / (0.5 + observation/100)，最少 1 拍 */
export const SIM_OBSERVE_BASE = 1;

// ── 建档 / 校验 ──

/** 默认推演档案：能力取世界模型默认；需求实例 = schema 中每个 need 的定义默认 */
export function defaultSimProfile(characterId: string, index: SimSchemaIndex): SimProfile {
  return {
    characterId,
    capabilities: { ...SIM_CAPABILITY_DEFAULTS },
    tags: [],
    needs: index.needs.map((def) => ({ defId: def.id, enabled: true })),
  };
}

const clampNum = (v: unknown, min: number, max: number, fallback: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
};

function sanitizeCapabilities(raw: unknown): SimCapabilities {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    speed: clampNum(o.speed, SIM_CAPABILITY_RANGES.speed.min, SIM_CAPABILITY_RANGES.speed.max, SIM_CAPABILITY_DEFAULTS.speed),
    perception: clampNum(
      o.perception,
      SIM_CAPABILITY_RANGES.perception.min,
      SIM_CAPABILITY_RANGES.perception.max,
      SIM_CAPABILITY_DEFAULTS.perception,
    ),
    observation: clampNum(
      o.observation,
      SIM_CAPABILITY_RANGES.observation.min,
      SIM_CAPABILITY_RANGES.observation.max,
      SIM_CAPABILITY_DEFAULTS.observation,
    ),
  };
}

/** 单份档案校验：能力钳制；标签/需求实例按当前 schema 过滤（未知定义丢弃），
 *  schema 中每个 need 缺实例时补默认（新增需求自动出现在老档案里）。 */
export function sanitizeSimProfile(raw: unknown, characterId: string, index: SimSchemaIndex): SimProfile {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawNeeds = Array.isArray(o.needs) ? (o.needs as unknown[]) : [];
  const byDef = new Map<string, SimNeedInstance>();
  for (const item of rawNeeds) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const defId = typeof d.defId === 'string' ? d.defId : '';
    const def = tagDefOf(index, defId);
    if (!def || def.role !== 'need' || byDef.has(defId)) continue;
    const p = def.need!;
    byDef.set(defId, {
      defId,
      intensity: clampNum(d.intensity, 0, 100, p.initial),
      ...(typeof d.growthPerTick === 'number' && Number.isFinite(d.growthPerTick)
        ? { growthPerTick: clampNum(d.growthPerTick, 0, 20, p.growth) }
        : {}),
      ...(typeof d.threshold === 'number' && Number.isFinite(d.threshold)
        ? { threshold: clampNum(d.threshold, 0, 100, p.threshold) }
        : {}),
      ...(typeof d.emergency === 'number' && Number.isFinite(d.emergency)
        ? { emergency: clampNum(d.emergency, 0, 100, p.emergency) }
        : {}),
      enabled: d.enabled !== false,
    });
  }
  const needs = index.needs.map(
    (def) => byDef.get(def.id) ?? ({ defId: def.id, enabled: true } satisfies SimNeedInstance),
  );

  return {
    characterId,
    capabilities: sanitizeCapabilities(o.capabilities),
    tags: sanitizeProfileTags(o.tags, index),
    needs,
  };
}

/** 全量校验：只保留人物库中仍有记录的档案；**每位人物都保证有一份**（旧人物/缺失自动补默认档）。 */
export function sanitizeSimProfiles(
  raw: unknown,
  characters: Record<string, { id: string }>,
  index: SimSchemaIndex,
): Record<string, SimProfile> {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, SimProfile> = {};
  for (const characterId of Object.keys(characters)) {
    const candidate = src[characterId];
    let val: unknown = candidate;
    if (val === undefined && Array.isArray(src)) val = (src as unknown[]).find((x) => (x as SimProfile | undefined)?.characterId === characterId);
    out[characterId] = sanitizeSimProfile(val, characterId, index);
  }
  return out;
}

// ── 运行时解析：定义默认 ← 档案实例 ──

export interface ResolvedNeed {
  def: SimTagDef;
  /** 初始值（运行时随需求增长/缓解变化） */
  value: number;
  growth: number;
  threshold: number;
  emergency: number;
  enabled: boolean;
  relievers: { novelty?: number; observe?: number; social?: number };
}

export interface ResolvedEmotion {
  def: SimTagDef;
  value: number;
  decay: number;
  breakThreshold: number;
  clearThreshold: number;
  stance: SimStanceKind | 'none';
}

export interface ResolvedSimProfile {
  capabilities: SimCapabilities;
  /** defId → 需求（遍历顺序由 index.needs 决定，天然按 id 排序） */
  needs: Record<string, ResolvedNeed>;
  emotions: Record<string, ResolvedEmotion>;
  /** 人物 trait 标签 id（感知/移动/反应；建会话时冻结，已排序） */
  traits: string[];
}

/** 张望耗时：观察力越高越快（设计文档 §5.5），最少 1 拍 */
export function observeTicks(observation: number): number {
  return Math.max(1, Math.round(SIM_OBSERVE_BASE / (0.5 + Math.max(0, Math.min(100, observation)) / 100)));
}

export function resolveSimProfile(profile: SimProfile, index: SimSchemaIndex): ResolvedSimProfile {
  const needs: Record<string, ResolvedNeed> = {};
  for (const def of index.needs) {
    const inst = profile.needs.find((n) => n.defId === def.id);
    const p = def.need!;
    needs[def.id] = {
      def,
      value: clampNum(inst?.intensity, 0, 100, p.initial),
      growth: clampNum(inst?.growthPerTick, 0, 20, p.growth),
      threshold: clampNum(inst?.threshold, 0, 100, p.threshold),
      emergency: clampNum(inst?.emergency, 0, 100, p.emergency),
      enabled: inst?.enabled !== false,
      relievers: { ...(p.relievers ?? {}) },
    };
  }
  const emotions: Record<string, ResolvedEmotion> = {};
  const initials = emotionInitialsOf(profile.tags, index);
  for (const def of index.emotions) {
    const p = def.emotion!;
    emotions[def.id] = {
      def,
      value: clampNum(initials[def.id], 0, 100, p.initial),
      decay: p.decay,
      breakThreshold: p.breakThreshold,
      clearThreshold: p.clearThreshold,
      stance: p.stance ?? 'none',
    };
  }
  return {
    capabilities: { ...profile.capabilities },
    needs,
    emotions,
    traits: traitIdsOf(profile.tags, index),
  };
}
