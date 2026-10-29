/** 🎬 推演档案（SimProfile）默认值 / 内置定义 / 校验 / 运行时解析。
 *
 *  与人物档案（characterStates.ts）完全分离：这里只放「数值行为」，不碰姓名/状态/形象。
 *  作品级定义库（SimPlaySchema）尚未实现，本文件内置 MVP 的两项欲望与四个行为作为定义底稿；
 *  人物档案只存实例（启停 + 覆盖参数），运行时三级合并「内置默认 ← 档案实例」（状态覆盖待后续切片）。
 *  设计依据：docs/剧情推演模拟器设计.md §6。 */
import type { SimCapabilities, SimDesireInstance, SimBehaviorInstance, SimProfile } from '../types/sim';

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
/** 到达一个没去过的环境 → 好奇缓解量（新颖度信号） */
export const SIM_NOVELTY_RELIEF = 25;
/** 张望完成 → 好奇缓解量 */
export const SIM_OBSERVE_RELIEF = 18;
/** 休息完成 → 疲劳缓解量 */
export const SIM_REST_RELIEF = 55;
/** 好奇低于该值不再张望（避免张望刷屏） */
export const SIM_OBSERVE_MIN_CURIOSITY = 28;

// ── 内置欲望定义（定义库落地前的固定底稿） ──

export const DESIRE_CURIOSITY = 'builtin:curiosity';
export const DESIRE_FATIGUE = 'builtin:fatigue';

export interface SimDesireDefMeta {
  id: string;
  name: string;
  icon: string;
  category: 'physio' | 'social' | 'cognitive' | 'emotional';
  /** 何时增长 / 什么算满足（面板说明与后续叙事化素材） */
  desc: string;
  defaultValue: number;
  growthPerTick: number;
  threshold: number;
  /** 缓解来源说明（面板展示） */
  relief: string;
}

export const SIM_BUILTIN_DESIRES: SimDesireDefMeta[] = [
  {
    id: DESIRE_CURIOSITY,
    name: '好奇',
    icon: '🔍',
    category: 'cognitive',
    desc: '每拍增长；到达没去过的环境、张望后缓解。驱动探索与张望。',
    defaultValue: 30,
    growthPerTick: 0.9,
    threshold: 45,
    relief: `新环境 −${SIM_NOVELTY_RELIEF} · 张望 −${SIM_OBSERVE_RELIEF}`,
  },
  {
    id: DESIRE_FATIGUE,
    name: '疲劳',
    icon: '😪',
    category: 'physio',
    desc: '每拍增长；达到阈值会找地方坐下休息。驱动休息。',
    defaultValue: 10,
    growthPerTick: 0.5,
    threshold: 65,
    relief: `休息 −${SIM_REST_RELIEF}`,
  },
];

export function desireDefOf(defId: string): SimDesireDefMeta | undefined {
  return SIM_BUILTIN_DESIRES.find((d) => d.id === defId);
}

// ── 内置行为定义 ──

export const BEHAVIOR_EXPLORE = 'builtin:explore';
export const BEHAVIOR_WANDER = 'builtin:wander';
export const BEHAVIOR_OBSERVE = 'builtin:observe';
export const BEHAVIOR_REST = 'builtin:rest';

export interface SimBehaviorDefMeta {
  id: string;
  name: string;
  icon: string;
  desc: string;
  /** 默认权重；张望用它当触发概率 */
  weight: number;
  /** 权重是否被当前引擎消费（探索/走动/休息按阈值或保底触发，权重为预留） */
  weightEditable?: boolean;
  /** 触发方式简述（不消费权重时在面板展示） */
  trigger?: string;
  /** 默认耗时（拍）；缺省=由能力计算（张望）或不适用（移动类） */
  duration?: number;
  /** 由哪项欲望驱动（面板展示；wander 为保底动作） */
  drivenBy?: string;
  /** 是否可编辑耗时 */
  durationEditable?: boolean;
}

export const SIM_BUILTIN_BEHAVIORS: SimBehaviorDefMeta[] = [
  {
    id: BEHAVIOR_EXPLORE,
    name: '探索',
    icon: '🧭',
    desc: '走向没去过的环境（到达后好奇大幅缓解）',
    weight: 1,
    trigger: '好奇达阈值触发',
    drivenBy: DESIRE_CURIOSITY,
  },
  { id: BEHAVIOR_WANDER, name: '走动', icon: '🚶', desc: '在当前环境内随意走动（好奇未达阈值时的保底动作）', weight: 1, trigger: '保底动作' },
  {
    id: BEHAVIOR_OBSERVE,
    name: '张望',
    icon: '👀',
    desc: '停下观察四周，缓解好奇；耗时由观察力决定',
    weight: 0.6,
    weightEditable: true,
    drivenBy: DESIRE_CURIOSITY,
    durationEditable: true,
  },
  {
    id: BEHAVIOR_REST,
    name: '休息',
    icon: '🛋',
    desc: '坐下恢复精神（疲劳达到阈值时触发）',
    weight: 1,
    duration: 3,
    trigger: '疲劳达阈值触发',
    drivenBy: DESIRE_FATIGUE,
    durationEditable: true,
  },
];

export function behaviorDefOf(defId: string): SimBehaviorDefMeta | undefined {
  return SIM_BUILTIN_BEHAVIORS.find((b) => b.id === defId);
}

// ── 建档 / 校验 ──

/** 默认推演档案：能力取世界模型默认；欲望/行为取内置定义全集并启用（设计文档 §6.1 自动创建） */
export function defaultSimProfile(characterId: string): SimProfile {
  return {
    characterId,
    capabilities: { ...SIM_CAPABILITY_DEFAULTS },
    attributes: {},
    desires: SIM_BUILTIN_DESIRES.map((d) => ({ defId: d.id, intensity: d.defaultValue, enabled: true })),
    behaviors: SIM_BUILTIN_BEHAVIORS.map((b) => ({
      defId: b.id,
      enabled: true,
      ...(b.weight !== 1 ? { weight: b.weight } : {}),
      ...(b.duration !== undefined ? { duration: b.duration } : {}),
    })),
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

/** 单份档案校验：能力钳制、欲望/行为实例按内置定义补全（缺的补默认，未知 defId 丢弃），
 *  characterId 一律以入参为准（防止串档）。 */
export function sanitizeSimProfile(raw: unknown, characterId: string): SimProfile {
  const base = defaultSimProfile(characterId);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const rawDesires = Array.isArray(o.desires) ? (o.desires as unknown[]) : [];
  const desireById = new Map<string, SimDesireInstance>();
  for (const item of rawDesires) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const defId = typeof d.defId === 'string' ? d.defId : '';
    const def = desireDefOf(defId);
    if (!def || desireById.has(defId)) continue;
    desireById.set(defId, {
      defId,
      intensity: clampNum(d.intensity, 0, 100, def.defaultValue),
      ...(typeof d.growthPerTick === 'number' && Number.isFinite(d.growthPerTick)
        ? { growthPerTick: clampNum(d.growthPerTick, 0, 20, def.growthPerTick) }
        : {}),
      ...(typeof d.threshold === 'number' && Number.isFinite(d.threshold)
        ? { threshold: clampNum(d.threshold, 0, 100, def.threshold) }
        : {}),
      enabled: d.enabled !== false,
    });
  }
  // 内置定义全集补全：缺实例的人物视为启用默认（新增内置欲望自动出现在老档案里）
  const desires = SIM_BUILTIN_DESIRES.map((def) => desireById.get(def.id) ?? base.desires.find((x) => x.defId === def.id)!);

  const rawBehaviors = Array.isArray(o.behaviors) ? (o.behaviors as unknown[]) : [];
  const behaviorById = new Map<string, SimBehaviorInstance>();
  for (const item of rawBehaviors) {
    if (!item || typeof item !== 'object') continue;
    const b = item as Record<string, unknown>;
    const defId = typeof b.defId === 'string' ? b.defId : '';
    const def = behaviorDefOf(defId);
    if (!def || behaviorById.has(defId)) continue;
    behaviorById.set(defId, {
      defId,
      enabled: b.enabled !== false,
      ...(typeof b.weight === 'number' && Number.isFinite(b.weight) ? { weight: clampNum(b.weight, 0, 1, def.weight) } : {}),
      ...(typeof b.duration === 'number' && Number.isFinite(b.duration) ? { duration: Math.round(clampNum(b.duration, 1, 20, def.duration ?? 1)) } : {}),
    });
  }
  const behaviors = SIM_BUILTIN_BEHAVIORS.map(
    (def) => behaviorById.get(def.id) ?? base.behaviors.find((x) => x.defId === def.id)!,
  );

  // 属性初值：定义库未实现，只保留合法的数字键值（当前恒空）
  const attributes: Record<string, number> = {};
  if (o.attributes && typeof o.attributes === 'object') {
    for (const [k, v] of Object.entries(o.attributes as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) attributes[k] = v;
    }
  }

  return {
    characterId,
    capabilities: sanitizeCapabilities(o.capabilities),
    attributes,
    desires,
    behaviors,
    ...(o.stateOverrides && typeof o.stateOverrides === 'object'
      ? { stateOverrides: o.stateOverrides as SimProfile['stateOverrides'] }
      : {}),
  };
}

/** 全量校验：只保留人物库中仍有记录的档案；**每位人物都保证有一份**（旧人物/缺失自动补默认档）。
 *  返回新 map（调用方与 characters 一起落库，保持「一人一档」）。 */
export function sanitizeSimProfiles(
  raw: unknown,
  characters: Record<string, { id: string }>,
): Record<string, SimProfile> {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, SimProfile> = {};
  for (const characterId of Object.keys(characters)) {
    const candidate = src[characterId];
    // 支持两种历史形态：按 id 键的对象 / 数组（以 characterId 字段为准）
    let val: unknown = candidate;
    if (val === undefined && Array.isArray(src)) val = (src as unknown[]).find((x) => (x as SimProfile | undefined)?.characterId === characterId);
    out[characterId] = sanitizeSimProfile(val, characterId);
  }
  return out;
}

// ── 运行时解析：内置默认 ← 档案实例（状态覆盖待后续切片） ──

export interface ResolvedDesire {
  value: number;
  growth: number;
  threshold: number;
  enabled: boolean;
}

export interface ResolvedBehavior {
  enabled: boolean;
  weight: number;
  /** undefined = 由能力计算（张望）或不适用（移动类） */
  duration?: number;
}

export interface ResolvedSimProfile {
  capabilities: SimCapabilities;
  desires: Record<string, ResolvedDesire>;
  behaviors: Record<string, ResolvedBehavior>;
}

/** 张望耗时：观察力越高越快（设计文档 §5.5），最少 1 拍 */
export function observeTicks(observation: number): number {
  return Math.max(1, Math.round(SIM_OBSERVE_BASE / (0.5 + Math.max(0, Math.min(100, observation)) / 100)));
}

export function resolveSimProfile(profile: SimProfile): ResolvedSimProfile {
  const desires: Record<string, ResolvedDesire> = {};
  for (const def of SIM_BUILTIN_DESIRES) {
    const inst = profile.desires.find((d) => d.defId === def.id);
    desires[def.id] = {
      value: inst?.intensity ?? def.defaultValue,
      growth: inst?.growthPerTick ?? def.growthPerTick,
      threshold: inst?.threshold ?? def.threshold,
      enabled: inst?.enabled !== false,
    };
  }
  const behaviors: Record<string, ResolvedBehavior> = {};
  for (const def of SIM_BUILTIN_BEHAVIORS) {
    const inst = profile.behaviors.find((b) => b.defId === def.id);
    behaviors[def.id] = {
      enabled: inst?.enabled !== false,
      weight: inst?.weight ?? def.weight,
      duration: inst?.duration,
    };
  }
  return { capabilities: { ...profile.capabilities }, desires, behaviors };
}
