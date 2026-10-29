/** 🧬 人物状态纯逻辑（v3 人物库）：迁移/解析/人物形象 key。
 *  不依赖 store，persist 恢复、存档载入、跨卷复制后的 sanitize 与 UI/引擎共用。
 *
 *  数据约定：
 *  - 人名/性别在 WorkCharacter 顶层，跨状态稳定；画布人物节点只是放置（characterId + activeStateId）；
 *  - 其余属性（年龄/基础信息/身份信息/关系信息/人物形象）属于 CharacterState；
 *  - states 至少一项，首项=默认状态「状态0」；当前状态由放置的 activeStateId 决定（按画布独立）。
 *  - 旧版平铺字段只在「没有可用 states」时迁入状态0；已有 states 时绝不覆盖（避免把用户改过的状态0重置）。
 *  - v2.31 起旧 avatar / portraitKey 不再迁移：形象改为每状态独立的大图 + 手动裁切头像。 */
import { uid } from '../utils/id';
import {
  CHARACTER_IMAGE_PRESETS,
  genderOf,
  type CharacterImageCrop,
  type CharacterImagePreset,
  type CharacterState,
  type CharacterStateImage,
  type WorkCharacter,
} from '../types/sim';

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

const IMAGE_KEY_CAP = 200;

/** 新大图 key：带 nonce，换图/重裁总是写新 key，继承同一张图的其它状态不会被原地覆盖 */
export function newCharacterImageKey(nodeId: string, stateId: string): string {
  return `charimg:${nodeId}:${stateId}:${uid()}`;
}

/** 新头像 key：headKey 业务同上 */
export function newCharacterHeadKey(nodeId: string, stateId: string): string {
  return `charhead:${nodeId}:${stateId}:${uid()}`;
}

function validImageKey(v: unknown, prefix: 'charimg:' | 'charhead:'): v is string {
  const key = typeof v === 'string' ? v.trim() : '';
  return key.startsWith(prefix) && key.length <= IMAGE_KEY_CAP;
}

export function isCharacterImageKey(v: unknown): v is string {
  return validImageKey(v, 'charimg:');
}

export function isCharacterHeadKey(v: unknown): v is string {
  return validImageKey(v, 'charhead:');
}

/** 一个状态引用的大图/头像 key（用于引用计数与清理） */
export function collectStateImageKeys(state: CharacterState): string[] {
  const image = state.image;
  if (!image) return [];
  return [image.key, image.headKey].filter((k): k is string => !!k);
}

/** 人物当前状态：activeStateId（来自放置，按画布独立）非法/缺省时回落首项 */
export function characterActiveState(c: WorkCharacter, activeStateId?: string): CharacterState {
  return c.states.find((s) => s.id === activeStateId) ?? c.states[0];
}

/** 指定状态；缺省=放置当前状态（activeStateId）；都找不到回落首项 */
export function characterStateOf(c: WorkCharacter, stateId?: string, activeStateId?: string): CharacterState {
  return c.states.find((s) => s.id === (stateId ?? activeStateId)) ?? c.states[0];
}

export function characterStateIndex(c: WorkCharacter, stateId: string): number {
  return c.states.findIndex((s) => s.id === stateId);
}

export function characterHasState(c: WorkCharacter, stateId: string): boolean {
  return c.states.some((s) => s.id === stateId);
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

function intIn(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const n = Math.round(v);
  return n >= min && n <= max ? n : undefined;
}

/** 人物形象兜底：只接受轻量元数据 + 合法 IDB key；损坏值当作无图 */
export function sanitizeCharacterImage(v: unknown): CharacterStateImage | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const raw = v as Record<string, unknown>;
  const key = pickStr(raw.key).trim();
  if (!isCharacterImageKey(key)) return undefined;
  const width = intIn(raw.width, 1, 20000);
  const height = intIn(raw.height, 1, 20000);
  if (!width || !height) return undefined;
  const preset: CharacterImagePreset | 'original' = (CHARACTER_IMAGE_PRESETS as readonly unknown[]).includes(raw.preset)
    ? (raw.preset as CharacterImagePreset)
    : 'original';
  const headKey = isCharacterHeadKey(raw.headKey) ? raw.headKey.trim() : undefined;
  let crop: CharacterImageCrop | undefined;
  if (headKey && raw.crop && typeof raw.crop === 'object') {
    const c = raw.crop as Record<string, unknown>;
    const maxSize = Math.min(width, height);
    const size = intIn(c.size, 1, maxSize);
    if (size) {
      const x = Math.max(0, Math.min(width - size, intIn(c.x, -width, width) ?? 0));
      const y = Math.max(0, Math.min(height - size, intIn(c.y, -height, height) ?? 0));
      crop = { x, y, size };
    }
  }
  return { key, width, height, preset, ...(headKey ? { headKey } : {}), ...(crop ? { crop } : {}) };
}

/** 旧版平铺人物 → 状态0（仅在没有可用 states 时调用）；旧形象/写真不迁移 */
function legacyState(raw: Record<string, unknown>): CharacterState {
  return {
    id: DEFAULT_STATE_ID,
    label: DEFAULT_STATE_LABEL,
    ...(sanitizeStateAge(raw.age) !== undefined ? { age: sanitizeStateAge(raw.age) } : {}),
    basicInfo: pickStr(raw.basicInfo) || pickStr(raw.desc),
    identityInfo: pickStr(raw.identityInfo),
    ...(pickStr(raw.relations).trim() ? { relations: pickStr(raw.relations) } : {}),
  };
}

/** 从原始数据构建状态数组（恒 ≥1；确定性修复 ID/标签）——sanitizeWorkCharacter 共用 */
function buildStates(raw: Record<string, unknown>): CharacterState[] {
  const rawStates = Array.isArray(raw.states) ? raw.states : [];
  const entries = rawStates.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  if (!entries.length) return [legacyState(raw)];

  const usedIds = new Set<string>();
  const usedLabels = new Set<string>();
  return entries.map((s, i) => {
    const age = sanitizeStateAge(s.age);
    const relations = pickStr(s.relations);
    const image = sanitizeCharacterImage(s.image);
    return {
      id: uniqueId(s.id, usedIds, i),
      label: uniqueLabel(s.label, usedLabels, i),
      ...(age !== undefined ? { age } : {}),
      basicInfo: pickStr(s.basicInfo),
      identityInfo: pickStr(s.identityInfo),
      ...(relations.trim() ? { relations } : {}),
      ...(image ? { image } : {}),
    };
  });
}

/** 🆕 新人物库记录种子：空状态0，无图片 */
export function newWorkCharacter(id: string): WorkCharacter {
  return {
    id,
    name: '',
    gender: 'male',
    states: [
      {
        id: DEFAULT_STATE_ID,
        label: DEFAULT_STATE_LABEL,
        basicInfo: '',
        identityInfo: '',
      },
    ],
  };
}

/** 人物库记录兜底：状态恒 ≥1（无 states 时旧平铺字段迁入状态0），ID 由调用方决定（此处重建） */
export function sanitizeWorkCharacter(raw: unknown): WorkCharacter | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    id: pickStr(r.id).trim(),
    name: pickStr(r.name),
    gender: genderOf(r.gender),
    states: buildStates(r),
  };
}

/** 人物库整体兜底（persist / 存档 / replaceState 共用）：损坏条目丢弃，ID 缺失回落键名 */
export function sanitizeCharacters(raw: unknown): Record<string, WorkCharacter> {
  const out: Record<string, WorkCharacter> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const c = sanitizeWorkCharacter(value);
    if (!c) continue;
    const id = c.id || key;
    out[id] = { ...c, id };
  }
  return out;
}

/** 🔁 一次性提取（v2→v3，无迁移向导——用户豁免：无法兼容的旧数据直接丢弃）：
 *  扫描全部画布的旧格式人物节点（v2.31 带 states / 更早的平铺字段），以 node.id 建立人物库。
 *  - 同 ID 镜像（跨画布共享 node.id）：首见保留，其后分叉副本静默丢弃（按画布键序×节点序，确定性）；
 *  - 已是放置形态的节点（data.characterId 存在）跳过——只登记引用，不重复建库；
 *  - 幂等：v3 数据再跑一遍结果不变（放置节点带 characterId，提取出空库）。 */
export function extractCharactersFromBoards(boards: unknown): {
  characters: Record<string, WorkCharacter>;
  extracted: number;
} {
  const characters: Record<string, WorkCharacter> = {};
  let extracted = 0;
  if (!boards || typeof boards !== 'object') return { characters, extracted };
  const boardList: unknown[] = Array.isArray(boards) ? boards : Object.values(boards as Record<string, unknown>);
  for (const b of boardList) {
    if (!b || typeof b !== 'object') continue;
    const nodes = (b as Record<string, unknown>).nodes;
    if (!Array.isArray(nodes)) continue;
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const rec = n as Record<string, unknown>;
      const data = rec.data;
      if (!data || typeof data !== 'object') continue;
      const d = data as Record<string, unknown>;
      if (d.kind !== 'character') continue;
      // v3 放置形态（data.characterId 存在）不重复建库；旧格式（带 states 或平铺字段）都提取
      if (typeof d.characterId === 'string' && d.characterId.trim()) continue;
      const nodeId = typeof rec.id === 'string' ? rec.id.trim() : '';
      if (!nodeId || characters[nodeId]) continue;
      const c = sanitizeWorkCharacter(d);
      if (!c) continue;
      characters[nodeId] = { ...c, id: nodeId };
      extracted += 1;
    }
  }
  return { characters, extracted };
}

/** 放置 → 人物库记录（characterId 不在库中 = 悬空放置，返回 undefined 由调用方过滤/丢弃） */
export function placementCharacter(
  p: { characterId?: unknown },
  characters: Record<string, WorkCharacter>,
): WorkCharacter | undefined {
  const id = p?.characterId;
  return typeof id === 'string' ? characters[id] : undefined;
}

/** 新建状态的 ID（首项之外用 uid；调用方负责保证不与现有 ID 冲突） */
export function newStateId(): string {
  return uid();
}
