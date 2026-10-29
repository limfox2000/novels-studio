/** 跨卷复制纯逻辑（v2.29 · v3 人物库）：不读写 store，便于独立断言。
 *
 *  两种语义（人物身份=人物库 ID）：
 *  - mirror：保留节点 ID，视作同一人物/环境在另一卷的镜像；人物只复制「放置」
 *    （characterId + activeStateId，不复制状态/图片）；目标已有同 ID 时按 conflict 更新或跳过
 *    （冲突更新只同步环境尺寸，不覆盖目标放置的当前状态——activeStateId 是场景态，按放置独立 C1）。
 *  - new：全部节点换新 ID；环境深拷贝；人物生成新的人物库记录（新 characterId + 各状态图片 key 重写
 *    + imageTasks 异步复制字节），成为独立副本。
 *
 *  选择环境时可选带上全部后代；未选中的祖先不会被自动带上：
 *  父在复制集 → 挂到映射后的父；父不在集但目标卷已有同 ID 环境 → 挂入该容器；
 *  否则提升为根层，用源绝对坐标，避免相对坐标落到根层后错位。 */
import type { Edge } from '@xyflow/react';
import type { SimBoard, SimNodeType, WorkCharacter } from '../types/sim';
import { uid } from '../utils/id';
import { newCharacterHeadKey, newCharacterImageKey } from './characterStates';
import { absPositionOf, sortParentsFirst } from './graphGeom';

export type BoardCopyMode = 'mirror' | 'new';
export type BoardCopyConflict = 'update' | 'skip';

export interface BoardCopyInput {
  /** 源画布中要复制的节点（通常=当前选中） */
  nodeIds: string[];
  mode: BoardCopyMode;
  /** mirror 生效；默认 skip（安全：只补缺失节点） */
  conflict?: BoardCopyConflict;
  /** 选中环境时是否带上其全部后代；默认 true */
  includeDescendants?: boolean;
  /** 复制结果整体平移到的目标画布中心（flow 坐标）；缺省不平移 */
  placement?: { x: number; y: number };
}

export interface BoardCopyReport {
  added: number;
  updated: number;
  skipped: number;
  edgesAdded: number;
  parentFallbacks: number;
  conflicts: string[];
  warnings: string[];
}

export interface BoardCopyResult {
  nodes: SimNodeType[];
  edges: Edge[];
  report: BoardCopyReport;
  /** 源节点 id → 目标节点 id（跳过/更新的镜像节点映射到自身 id） */
  idMap: Record<string, string>;
  /** new 模式的人物形象/头像复制任务；由 UI 异步执行，不阻塞节点复制 */
  imageTasks: Array<{ fromKey: string; toKey: string }>;
  /** new 模式产生的新人物库记录；调用方必须与 boards 同一 set() 落库（否则 sanitize 丢放置） */
  newCharacters: WorkCharacter[];
}

const CHAR_Z_INDEX = 100;
const CHAR_BOX = { w: 144, h: 104 };
const ENV_BOX = { w: 220, h: 150 };

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function nodeLabel(n: SimNodeType, characters: Record<string, WorkCharacter>): string {
  const d = n.data;
  if (d.kind === 'character') {
    return `人物「${characters[d.characterId]?.name || '未命名'}」`;
  }
  return `环境「${d.name || '未命名'}」`;
}

function nodeBox(n: SimNodeType): { w: number; h: number } {
  const w = typeof n.width === 'number' && n.width > 0 ? n.width : undefined;
  const h = typeof n.height === 'number' && n.height > 0 ? n.height : undefined;
  if (n.data.kind === 'character') return { w: w ?? CHAR_BOX.w, h: h ?? CHAR_BOX.h };
  return { w: w ?? ENV_BOX.w, h: h ?? ENV_BOX.h };
}

/** 展开复制集：选中节点 + （可选）被选中环境的全部后代。 */
export function collectCopySet(
  source: SimBoard,
  nodeIds: string[],
  includeDescendants = true,
): { nodes: SimNodeType[]; edges: Edge[] } {
  const byId = new Map(source.nodes.map((n) => [n.id, n]));
  const ids = new Set(nodeIds.filter((id) => byId.has(id)));
  if (includeDescendants) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of source.nodes) {
        if (ids.has(n.id) || !n.parentId || !ids.has(n.parentId)) continue;
        const parent = byId.get(n.parentId);
        // 只沿环境后代展开；父已被选中就说明属于某个选中环境的分支
        if (parent?.data.kind === 'environment') {
          ids.add(n.id);
          changed = true;
        }
      }
    }
  }
  const nodes = source.nodes.filter((n) => ids.has(n.id));
  const edges = source.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges };
}

/** 跨卷复制规划：返回新的目标画布 nodes/edges（不修改 source/target 入参）。
 *  characters=源人物库（new 模式读取源人物记录建新库记录）。 */
export function planBoardCopy(
  source: SimBoard,
  target: SimBoard,
  input: BoardCopyInput,
  characters: Record<string, WorkCharacter> = {},
): BoardCopyResult {
  if (source.id === target.id) throw new Error('不能复制到同一张画布');
  const mode = input.mode;
  const conflict = input.conflict ?? 'skip';
  const copySet = collectCopySet(source, input.nodeIds, input.includeDescendants ?? true);
  if (!copySet.nodes.length) throw new Error('没有可复制的节点（请先在画布上选中节点）');

  const sourceById = new Map(source.nodes.map((n) => [n.id, n]));
  const sourceOrder = sortParentsFirst(copySet.nodes);
  const targetById = new Map(target.nodes.map((n) => [n.id, n]));
  const working = [...target.nodes];
  const report: BoardCopyReport = {
    added: 0,
    updated: 0,
    skipped: 0,
    edgesAdded: 0,
    parentFallbacks: 0,
    conflicts: [],
    warnings: [],
  };
  const idMap: Record<string, string> = {};
  const inserted = new Set<string>();
  const imageTasks: Array<{ fromKey: string; toKey: string }> = [];
  const newCharacters: WorkCharacter[] = [];
  const charIdMap = new Map<string, string>(); // 源 characterId → 新 characterId（new 模式）

  // 0) new 模式：为复制集中的人物先建新库记录（每源人物一条；镜像同 characterId 共享一条新记录）
  if (mode === 'new') {
    for (const n of sourceOrder) {
      if (n.data.kind !== 'character') continue;
      const src = characters[n.data.characterId];
      if (!src || charIdMap.has(n.data.characterId)) continue;
      const newId = uid();
      charIdMap.set(n.data.characterId, newId);
      // 复制全部状态（保留 stateId），每个状态的图/头像引用改写到新人物自己的新 key
      // （继承同一张基准图的多个状态会产生多个目标 key，由 imageTasks 分别复制）
      const states = src.states.map((s) => {
        if (!s.image) return { ...s };
        const key = newCharacterImageKey(newId, s.id);
        const headKey = s.image.headKey ? newCharacterHeadKey(newId, s.id) : undefined;
        imageTasks.push({ fromKey: s.image.key, toKey: key });
        if (s.image.headKey && headKey) imageTasks.push({ fromKey: s.image.headKey, toKey: headKey });
        return {
          ...s,
          image: {
            ...s.image,
            key,
            ...(headKey ? { headKey } : { headKey: undefined }),
          },
        };
      });
      newCharacters.push({ id: newId, name: src.name, gender: src.gender, states });
    }
  }

  // 1) 先决定每个节点的目标 id，并处理镜像冲突
  for (const n of sourceOrder) {
    if (mode === 'new') {
      idMap[n.id] = uid();
      continue;
    }
    idMap[n.id] = n.id;
    const existing = targetById.get(n.id);
    if (!existing) continue;
    if (existing.data.kind !== n.data.kind) {
      report.skipped++;
      report.conflicts.push(nodeLabel(n, characters));
      report.warnings.push(`${nodeLabel(n, characters)} 在目标画布同 ID 是另一类节点，已跳过`);
      continue;
    }
    report.conflicts.push(nodeLabel(n, characters));
    if (conflict === 'skip') {
      report.skipped++;
      continue;
    }
    // 更新：镜像只同步环境尺寸/数据；人物放置的 activeStateId 是场景态，
    // 保留目标画布里的当前状态与位置/父子关系（不复制源 activeStateId）
    const updated: SimNodeType =
      n.data.kind === 'environment'
        ? {
            ...existing,
            data: clone(n.data),
            width: n.width ?? existing.width,
            height: n.height ?? existing.height,
            zIndex: undefined,
          }
        : n.data.kind === 'character' && existing.data.kind === 'character'
          ? { ...existing, zIndex: CHAR_Z_INDEX } // 同一人物镜像：目标放置已是权威，无需改动数据
          : existing;
    targetById.set(n.id, updated);
    const idx = working.findIndex((x) => x.id === n.id);
    if (idx >= 0) working[idx] = updated;
    report.updated++;
  }

  // 2) 插入缺失节点（按父先子后），解析父级与相对坐标
  for (const n of sourceOrder) {
    const mappedId = idMap[n.id];
    if (!mappedId) continue;
    if (mode === 'mirror' && targetById.has(n.id)) continue; // 更新/跳过都已在目标存在

    let mappedParent: string | undefined;
    if (n.parentId) {
      const mappedSourceParent = idMap[n.parentId];
      if (mappedSourceParent && targetById.has(mappedSourceParent)) {
        mappedParent = mappedSourceParent;
      } else if (sourceById.has(n.parentId) && targetById.has(n.parentId)) {
        // 未选中的源父在目标卷已有同 ID 镜像 → 挂进去
        mappedParent = n.parentId;
      }
      if (mappedParent) {
        const p = targetById.get(mappedParent);
        if (!p || p.data.kind !== 'environment') {
          mappedParent = undefined;
          report.parentFallbacks++;
        }
      } else {
        report.parentFallbacks++;
      }
    }

    // 有目标父级：保留源相对坐标（父容器无论是否被平移/本身在目标卷的另一位置，
    // 子节点都应留在容器内的同一相对位置）；无父级才用源绝对坐标，交由下面的整体平移。
    const pos = mappedParent ? { x: n.position.x, y: n.position.y } : absPositionOf(n, sourceById);

    const raw = n as unknown as Record<string, unknown>;
    const {
      selected: _selected,
      dragging: _dragging,
      resizing: _resizing,
      measured: _measured,
      positionAbsolute: _positionAbsolute,
      internals: _internals,
      expandParent: _expandParent,
      ...rest
    } = raw;
    // 人物：放置形态落库。mirror 保留 characterId（共享库记录，状态/图片不复制）；
    // new 指向第 0 步生成的新库记录（activeStateId 沿用源放置——stateId 在复制时保留）
    let data: SimNodeType['data'];
    if (n.data.kind === 'character') {
      const cid =
        mode === 'new' ? (charIdMap.get(n.data.characterId) ?? n.data.characterId) : n.data.characterId;
      data = { kind: 'character', characterId: cid, activeStateId: n.data.activeStateId };
    } else {
      data = clone(n.data);
    }
    const node: SimNodeType = {
      ...(rest as unknown as SimNodeType),
      id: mappedId,
      position: pos,
      data,
      ...(n.style !== undefined ? { style: clone(n.style) } : {}),
      ...(mappedParent ? { parentId: mappedParent } : { parentId: undefined }),
      zIndex: n.data.kind === 'character' ? CHAR_Z_INDEX : undefined,
      selected: false,
    };
    targetById.set(mappedId, node);
    working.push(node);
    inserted.add(mappedId);
    report.added++;
  }

  // 3) 新插入的根级节点整组平移到目标视口中心；已挂目标既有父级的节点不参与
  if (input.placement) {
    const roots = [...inserted]
      .map((id) => targetById.get(id))
      .filter((n): n is SimNodeType => !!n && !n.parentId);
    if (roots.length) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of roots) {
        const box = nodeBox(n);
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x + box.w);
        maxY = Math.max(maxY, n.position.y + box.h);
      }
      const dx = input.placement.x - (minX + maxX) / 2;
      const dy = input.placement.y - (minY + maxY) / 2;
      for (const id of inserted) {
        const n = targetById.get(id);
        if (!n || n.parentId) continue;
        n.position = { x: n.position.x + dx, y: n.position.y + dy };
      }
    }
  }

  // 4) 内部连线：两端在目标已存在才连；镜像去重，new 生成新边 id
  const edges = [...target.edges];
  const edgeKeys = new Set(
    edges.map((e) => `${e.source}|${e.target}|${e.sourceHandle ?? ''}|${e.targetHandle ?? ''}`),
  );
  const edgeIds = new Set(edges.map((e) => e.id));
  for (const e of copySet.edges) {
    const src = idMap[e.source];
    const dst = idMap[e.target];
    if (!src || !dst || !targetById.has(src) || !targetById.has(dst)) continue;
    const key = `${src}|${dst}|${e.sourceHandle ?? ''}|${e.targetHandle ?? ''}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    let id = mode === 'new' ? uid() : e.id;
    if (!id || edgeIds.has(id)) id = uid();
    edgeIds.add(id);
    edges.push({
      ...clone(e),
      id,
      source: src,
      target: dst,
      selected: false,
    });
    report.edgesAdded++;
  }

  return {
    nodes: sortParentsFirst(working),
    edges,
    report,
    idMap,
    imageTasks,
    newCharacters,
  };
}
