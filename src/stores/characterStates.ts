/** 🧬 人物状态纯逻辑（v2.30）：迁移/解析/写真 key。
 *  不依赖 store，persist 恢复、存档载入、跨卷复制后的 sanitize 与 UI/引擎共用。
 *
 *  数据约定：
 *  - 人名/性别在 CharacterData 顶层，跨状态稳定；
 *  - 其余属性（年龄/形象/基础信息/身份信息/关系信息/写真引用）属于 CharacterState；
 *  - states 至少一项，首项=默认状态「状态0」；activeStateId 决定当前显示/编辑/生成用哪个状态。
 *  - 旧版平铺字段只在「没有可用 states」时迁入状态0；已有 states 时绝不覆盖（避免把用户改过的状态0重置）。 */
import { uid } from '../utils/id';
import { genderOf, type CharacterData, type CharacterState } from '../types/sim';

export const DEFAULT_STATE_ID = 'state0';
export const DEFAULT_STATE_LABEL = '状态0';
export const STATE_LABEL_CAP = 20;

function pickStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 年龄兜底：非法/缺省=undefined；否则四舍五入并钳在 0–999 */
export function sanitizeStateAge(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(999, Math.round(v)));
}

/** 状态的规范写真 key：portrait:<nodeId>:<stateId> */
export function portraitKeyForState(nodeId: string, stateId: string): string {
  return `portrait:${nodeId}:${stateId}`;
}

/** 旧版写真 key：portrait:<nodeId>（迁移后只给状态0 引用，不搬字节） */
export function legacyPortraitKey(nodeId: string): string {
  return `portrait:${nodeId}`;
}

/** 当前状态；activeStateId 非法时回落首项（sanitize 后必有一项） */
export function activeCharacterState(d: CharacterData): CharacterState {
  return d.states.find((s) => s.id === d.activeStateId) ?? d.states[0];
}

/** 指定状态；缺省=当前；找不到回落首项 */
export function characterStateOf(d: CharacterData, stateId?: string): CharacterState {
  return d.states.find((s) => s.id === (stateId ?? d.activeStateId)) ?? d.states[0];
}

export function characterStateIndex(d: CharacterData, stateId: string): number {
  return d.states.findIndex((s) => s.id === stateId);
}

export function characterHasState(d: CharacterData, stateId: string): boolean {
  return d.states.some((s) => s.id === stateId);
}

/** 状态标签是否已被占用（trim 后精确比较；ignoreId 用于重命名自身） */
export function stateLabelTaken(states: CharacterState[], label: string, ignoreId?: string): boolean {
  const v = label.trim();
  return !!v && states.some((s) => s.id !== ignoreId && s.label === v);
}

/** 建议的下一个状态名：从「状态1」起找第一个未占用标签（状态0 是默认项，不再作为新增建议） */
export function nextStateLabel(states: CharacterState[]): string {
  const used = new Set(states.map((s) => s.label));
  for (let i = 1; i <= states.length + 1; i++) {
    const label = `状态${i}`;
    if (!used.has(label)) return label;
  }
  return `状态${states.length + 1}`;
}

/** 重复标签兜底：保留原标签，冲突时追加「（2）（3）…」（确定性，重复 sanitize 不变） */
function uniqueLabel(raw: unknown, used: Set<string>, index: number): string {
  const base = (pickStr(raw).replace(/\s+/g, ' ').trim() || `状态${index}`).slice(0, STATE_LABEL_CAP);
  let label = base;
  let n = 2;
  while (used.has(label)) {
    const suffix = `（${n}）`;
    label = `${base.slice(0, Math.max(1, STATE_LABEL_CAP - suffix.length))}${suffix}`;
    n++;
  }
  used.add(label);
  return label;
}

/** 重复/缺失 ID 兜底：首项优先 state0，其余 state-<i>；冲突追加 -2/-3…（确定性） */
function uniqueId(raw: unknown, used: Set<string>, index: number): string {
  const base = (pickStr(raw).trim() || (index === 0 ? DEFAULT_STATE_ID : `state-${index}`)).slice(0, 64);
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`.slice(0, 64);
    n++;
  }
  used.add(id);
  return id;
}

/** 写真引用兜底：只收 portrait: 前缀；损坏值当作无图 */
function sanitizePortraitKey(v: unknown): string | undefined {
  const key = pickStr(v).trim();
  return key.startsWith('portrait:') ? key : undefined;
}

/** 旧版平铺人物 → 状态0（仅在没有可用 states 时调用） */
function legacyState(raw: Record<string, unknown>, nodeId: string): CharacterState {
  return {
    id: DEFAULT_STATE_ID,
    label: DEFAULT_STATE_LABEL,
    ...(sanitizeStateAge(raw.age) !== undefined ? { age: sanitizeStateAge(raw.age) } : {}),
    basicInfo: pickStr(raw.basicInfo) || pickStr(raw.desc),
    identityInfo: pickStr(raw.identityInfo),
    ...(pickStr(raw.relations).trim() ? { relations: pickStr(raw.relations) } : {}),
    ...(pickStr(raw.avatar).trim() ? { avatar: pickStr(raw.avatar) } : {}),
    portraitKey: legacyPortraitKey(nodeId),
  };
}

/** 人物数据兜底（persist / 存档 / 复制共用）：
 *  - 有合法 states：逐项清洗，缺失/重复 ID 与标签确定性修复；
 *  - 无合法 states：旧平铺字段迁入状态0，旧写真 key 挂到状态0；
 *  - activeStateId 非法回落首项；名字/性别始终重建。 */
export function sanitizeCharacterData(raw: Record<string, unknown>, nodeId: string): CharacterData {
  const name = pickStr(raw.name);
  const gender = genderOf(raw.gender);
  const rawStates = Array.isArray(raw.states) ? raw.states : [];
  const entries = rawStates.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  if (!entries.length) {
    const state = legacyState(raw, nodeId);
    return { kind: 'character', name, gender, states: [state], activeStateId: state.id };
  }

  const usedIds = new Set<string>();
  const usedLabels = new Set<string>();
  const states: CharacterState[] = entries.map((s, i) => {
    const age = sanitizeStateAge(s.age);
    const relations = pickStr(s.relations);
    const avatar = pickStr(s.avatar).trim();
    return {
      id: uniqueId(s.id, usedIds, i),
      label: uniqueLabel(s.label, usedLabels, i),
      ...(age !== undefined ? { age } : {}),
      basicInfo: pickStr(s.basicInfo),
      identityInfo: pickStr(s.identityInfo),
      ...(relations.trim() ? { relations } : {}),
      ...(avatar ? { avatar } : {}),
      ...(sanitizePortraitKey(s.portraitKey) ? { portraitKey: sanitizePortraitKey(s.portraitKey) } : {}),
    };
  });
  const wanted = pickStr(raw.activeStateId).trim();
  const activeStateId = states.some((s) => s.id === wanted) ? wanted : states[0].id;
  return { kind: 'character', name, gender, states, activeStateId };
}

/** 🆕 新人物种子：空状态0（写真引用先指向规范 key，实际无图也安全） */
export function initialCharacterData(nodeId: string): CharacterData {
  const stateId = DEFAULT_STATE_ID;
  return {
    kind: 'character',
    name: '',
    gender: 'male',
    states: [
      {
        id: stateId,
        label: DEFAULT_STATE_LABEL,
        basicInfo: '',
        identityInfo: '',
        portraitKey: portraitKeyForState(nodeId, stateId),
      },
    ],
    activeStateId: stateId,
  };
}

/** 新建状态的 ID（首项之外用 uid；调用方负责保证不与现有 ID 冲突） */
export function newStateId(): string {
  return uid();
}
