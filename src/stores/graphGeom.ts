/** 画布几何纯工具（v2.29）：store、跨卷复制、拖放判定共用。
 *  单独成文件避免「store → boardCopy → store」循环依赖。 */
import type { SimNodeType } from '../types/sim';

/** 父链绝对坐标（环保护：链上出现自身/重复即停）——拖放落点判定也用它（store 基准，比 RF 内部节点可靠） */
export function absPositionOf(n: SimNodeType, byId: Map<string, SimNodeType>): { x: number; y: number } {
  let x = n.position.x;
  let y = n.position.y;
  const guard = new Set<string>([n.id]);
  let p = n.parentId ? byId.get(n.parentId) : undefined;
  while (p && !guard.has(p.id)) {
    guard.add(p.id);
    x += p.position.x;
    y += p.position.y;
    p = p.parentId ? byId.get(p.parentId) : undefined;
  }
  return { x, y };
}

export function isDescendantOf(id: string, rootId: string, byId: Map<string, SimNodeType>): boolean {
  const guard = new Set<string>([id]);
  let cur = byId.get(id)?.parentId;
  while (cur) {
    if (cur === rootId) return true;
    if (guard.has(cur)) break;
    guard.add(cur);
    cur = byId.get(cur)?.parentId;
  }
  return false;
}

/** RF12 硬要求：nodes 数组里父节点必须排在子节点前面——否则 adoptUserNodes 按数组序注册时先遇到子节点、
 *  父还不在 lookup 里 → updateChildNode 直接跳过（console.warn "parent nodes in front of their child nodes"）：
 *  子节点绝对坐标/z 永不重算 → 相对坐标被当绝对坐标用（人物瞬移到原点附近不可见）、不随父移动，
 *  直到缩放父节点触发 updateNodeInternals→updateAbsolutePositions 才修复。store 追加式创建天然不保证此序
 *  （人物先建、建筑后建即中招），且损坏顺序会随 persist 存档固化——重定父级/清洗/整体替换三处统一排序。 */
export function sortParentsFirst(nodes: SimNodeType[]): SimNodeType[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const emitted = new Set<string>();
  const out: SimNodeType[] = [];
  let pending = nodes;
  while (pending.length) {
    const rest: SimNodeType[] = [];
    for (const n of pending) {
      const p = n.parentId ? byId.get(n.parentId) : undefined;
      // 父不存在（悬空，sanitize 已剥）或已输出 → 可输出；否则等下一轮
      if (!p || emitted.has(p.id)) {
        out.push(n);
        emitted.add(n.id);
      } else {
        rest.push(n);
      }
    }
    if (rest.length === pending.length) {
      out.push(...rest); // 环兜底（理论上 sanitize 已防环）：原序吐出防死循环
      break;
    }
    pending = rest;
  }
  return out;
}
