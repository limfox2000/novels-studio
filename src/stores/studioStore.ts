/**
 * 创作台画布 store（persist nc2-sim-v1 v2）：地图式画布。
 * 🧑 人物节点（人名胶囊——面上仅显示人名，基础信息/身份信息在属性面板；zIndex 恒 CHAR_ZINDEX 恒顶层）+
 * 🏗 环境节点（可缩放容器：NodeResizer 写 node.width/height；可嵌套层级——镇>建筑>房间…，RF12 parentId 父子；
 * v2.18 类型扩 床（容纳人物休息的容器）/物品（非容器标记——告知 AI 此处存在一个东西），按类型清淡配色）。
 * 节点面上**只展示不输入**：属性在左侧面板（SimInspector，顶栏 ⚙ 属性 开关、可关闭、不自动弹出——v2.4）。
 * 嵌套语义：拖拽落点「中心点落入哪个环境节点」即成为其子节点（随父移动），移出回根层；
 * 子节点**不设 expandParent**（否则拖动会自动撑大父容器，中心点永远出不去——v2 踩坑）；
 * 删除父环境时后代提升回根（绝对坐标展开，不丢内容）。规则系统/演进生成的连线语义随后续需求定义（edges 占位）。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type Edge,
} from '@xyflow/react';
import {
  ENV_TYPES,
  SIM_KINDS,
  genderOf,
  isContainerEnv,
  type CharacterData,
  type EnvironmentData,
  type EnvironmentType,
  type SimChapter,
  type SimData,
  type SimNodeType,
  type SimVolume,
} from '../types/sim';
import { uid } from '../utils/id';

// ── 常量与几何工具 ──

export const CHAR_ZINDEX = 100; // 人物恒在环境之上
export const ENV_DEFAULT_W = 220;
export const ENV_DEFAULT_H = 150;
export const ENV_MIN_W = 140;
export const ENV_MIN_H = 90;

function pickStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 📜 规则文本兜底：string 直通；短暂对象形态 {world,style}（v2.8 上线当日存档）拼接非空段；其余回空串 */
export function rulesText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as { world?: unknown; style?: unknown };
    return [o.world, o.style].filter((x): x is string => typeof x === 'string' && !!x.trim()).join('\n');
  }
  return '';
}

/** 📚 卷列表兜底（persist 恢复 + 存档载入共用）：重建字段、剔非法项、缺 id 补新 id */
export function sanitizeVolumes(v: unknown): SimVolume[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x, i) => ({
      id: typeof x.id === 'string' && x.id ? x.id : `vol-${i}-${uid()}`,
      title: pickStr(x.title),
      intro: pickStr(x.intro),
    }));
}

/** 📋 章节列表兜底（persist 恢复 + 服务器存档载入共用）：重建字段、剔非法项、缺 id 补新 id */
export function sanitizeChapters(v: unknown): SimChapter[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c, i) => ({
      id: typeof c.id === 'string' && c.id ? c.id : `ch-${i}-${uid()}`,
      title: pickStr(c.title),
      volumeId: pickStr(c.volumeId),
      requirement: pickStr(c.requirement),
      outline: pickStr(c.outline),
      content: pickStr(c.content),
    }));
}

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

function isDescendantOf(id: string, rootId: string, byId: Map<string, SimNodeType>): boolean {
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

/** 点 (cx,cy) 所在的最内层环境容器（面积最小者优先；排除 excludeId 自身及其后代——防环）。
 *  拖拽落点重定父级与「创建即归容器」共用。
 *  draggedRect（拖拽判定可选）：中心点没进任何容器、但拖拽矩形与容器重叠 ≥45% 也算「放进去了」——贴边放置不再漏判；
 *  创建路径（只传点）保持原语义。容器尺寸优先显式 width/height，缺了退 measured（RF 实测值兜底）。 */
export function findContainerAt(
  nodes: SimNodeType[],
  cx: number,
  cy: number,
  excludeId?: string,
  draggedRect?: { x: number; y: number; w: number; h: number },
): SimNodeType | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let best: SimNodeType | null = null;
  let bestArea = Infinity;
  for (const n of nodes) {
    if (n.data.kind !== 'environment' || n.id === excludeId) continue;
    if (!isContainerEnv(n.data.etype)) continue; // 物品等非容器类型：不可被拖入（v2.18）
    if (excludeId && isDescendantOf(n.id, excludeId, byId)) continue;
    const a = absPositionOf(n, byId);
    const w = n.width ?? n.measured?.width ?? 0;
    const h = n.height ?? n.measured?.height ?? 0;
    if (w <= 0 || h <= 0) continue;
    const inside = cx >= a.x && cx <= a.x + w && cy >= a.y && cy <= a.y + h;
    let overlaps = false;
    if (!inside && draggedRect && draggedRect.w > 0 && draggedRect.h > 0) {
      const ix = Math.min(a.x + w, draggedRect.x + draggedRect.w) - Math.max(a.x, draggedRect.x);
      const iy = Math.min(a.y + h, draggedRect.y + draggedRect.h) - Math.max(a.y, draggedRect.y);
      overlaps = ix > 0 && iy > 0 && (ix * iy) / (draggedRect.w * draggedRect.h) >= 0.45;
    }
    if (inside || overlaps) {
      const area = w * h;
      if (area < bestArea) {
        best = n;
        bestArea = area;
      }
    }
  }
  return best;
}

// ── 载入/恢复兜底 ──

/** 过滤非法 kind/缺 data 节点 → 剥 expandParent/resizing 瞬态键 → 重建数据（人物剥到仅 name；环境补尺寸默认值）→
 *  人物 zIndex 强制顶层 →
 *  parentId 清洗（父必须存在且为 environment，且不成环）→ 清洗连线（悬空/自环/重复，静默丢弃）。
 *  dropped>0 调用方提示「已过滤 N 个非法节点」。 */
export function sanitizeSimNodes(
  nodes: SimNodeType[],
  edges: Edge[] = [],
): { nodes: SimNodeType[]; edges: Edge[]; dropped: number } {
  const valid = nodes.filter(
    (n) => n && n.data && (SIM_KINDS as readonly string[]).includes((n.data as { kind?: string }).kind as string),
  );
  const fixed = valid.map((n) => {
    const d = n.data as unknown as Record<string, unknown>;
    // 剥离 expandParent（v2 曾误设：拖子节点会自动撑大父容器，导致无法拖出）、resizing（瞬态）、selected（选中态不持久化）
    const base = { ...n } as Record<string, unknown>;
    delete base.expandParent;
    delete base.resizing;
    delete base.selected;
    const clean = base as unknown as SimNodeType;
    if (clean.data.kind === 'character') {
      // v2.20 年龄/关系信息：新增可选字段随 sanitize 保留（age 仅收合法数字，relations 任意文本）
      // v2.27 详细信息拆为 基础信息/身份信息：旧档 desc 整体落入 basicInfo（旧文混写背景/目标，无法确定性再拆），
      // identityInfo 留空待补；旧键不随 sanitize 写出
      const age = typeof d.age === 'number' && Number.isFinite(d.age) ? Math.max(0, Math.min(999, Math.round(d.age))) : undefined;
      const data: CharacterData = {
        kind: 'character',
        name: pickStr(d.name),
        gender: genderOf(d.gender),
        basicInfo: pickStr(d.basicInfo) || pickStr(d.desc),
        identityInfo: pickStr(d.identityInfo),
        age,
        relations: pickStr(d.relations) || undefined,
        avatar: pickStr(d.avatar) || undefined,
      };
      return { ...clean, data, zIndex: CHAR_ZINDEX };
    }
    // environment：etype 不在集合内归位 building；尺寸缺失/过小回默认（旧档案/损坏缓存兜底）
    const etype = (ENV_TYPES as readonly string[]).includes(pickStr(d.etype)) ? (pickStr(d.etype) as EnvironmentType) : 'building';
    const data: EnvironmentData = { kind: 'environment', name: pickStr(d.name), etype, desc: pickStr(d.desc) };
    const w = typeof clean.width === 'number' && clean.width >= ENV_MIN_W ? clean.width : ENV_DEFAULT_W;
    const h = typeof clean.height === 'number' && clean.height >= ENV_MIN_H ? clean.height : ENV_DEFAULT_H;
    return { ...clean, data, width: w, height: h, zIndex: undefined };
  });
  // parentId 清洗：链上每个祖先都必须存在且是 environment，且不成环；非法则提升回根
  const byId = new Map(fixed.map((n) => [n.id, n]));
  const cleaned = fixed.map((n) => {
    if (!n.parentId) return n;
    const guard = new Set<string>([n.id]);
    let cur: string | undefined = n.parentId;
    while (cur) {
      if (guard.has(cur)) return { ...n, parentId: undefined }; // 环
      guard.add(cur);
      const p = byId.get(cur);
      if (!p || p.data.kind !== 'environment') return { ...n, parentId: undefined };
      cur = p.parentId;
    }
    return n;
  });
  const keptEdges: Edge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!e || !e.source || !e.target || e.source === e.target) continue;
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    const key = `${e.source}→${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keptEdges.push(e);
  }
  return { nodes: sortParentsFirst(cleaned), edges: keptEdges, dropped: nodes.length - fixed.length };
}

// ── Store ──

interface SimState {
  nodes: SimNodeType[];
  edges: Edge[]; // 占位持久化：连线语义随规则系统需求定义
  graphName: string;
  /** 📕 作品封面（v2.28）：上传后压成的 5:7 JPEG data URL（''=未设置）；随作品状态与存档保存，书架上显示 */
  cover: string;
  /** 📜 全文规则：世界法则/写作文风（v2.19b 起不再含故事走向——方向由 🎯 全文目标管）（随地图存档保存） */
  rules: string;
  /** 📜 章节大纲规则：如何生成章节大纲的要求（结构/节奏/要素等；演进生成管线与编辑室拟纲都遵守） */
  outlineRules: string;
  /** 🧬 人物生成规则（v2.15）：如何随机生成人物的要求——规则非空时「＋人物」自动按规则随机生成人物
   *  （⚠ 编辑室 v2.19 起默认不注入，⚙「📜 附带规则与目标」开启才按需参考——编辑室不被默认约束） */
  charGenRules: string;
  /** 🎯 全文目标（v2.16）：几句话写明这部小说的主要目标——📋大纲/📝正文/随机人物默认注入统一方向
   *  （⚠ 编辑室 v2.19 起默认不注入，⚙「📜 附带规则与目标」开启才按需参考） */
  mainGoal: string;
  /** 🏛 作品责任编辑（v2.21）：当前作品的全局责编（编辑 ID，''=未设置），随地图存档保存。
   *  生成各模块内容与总编辑对话时注入其职责 + 对应模块的技能记忆（getWorkResponsibleData） */
  responsibleId: string;
  /** 📚 卷（v2.17）：章节的分卷列表——每卷一段介绍，生成该卷各章大纲时注入控制整卷方向 */
  volumes: SimVolume[];
  /** 📋 章节大纲管理器：章节列表（章名/本章需求/生成的大纲/生成的正文，随地图存档保存；v2.10/v2.11） */
  chapters: SimChapter[];
  /** 正在大纲生成的章节 id（瞬态：只用于 UI 状态，persist merge 归 null） */
  outlineBusyId: string | null;
  /** 正在生成正文的章节 id（瞬态：只用于 UI 状态，persist merge 归 null） */
  contentBusyId: string | null;
  setGraphName: (name: string) => void;
  setCover: (cover: string) => void;
  setResponsibleId: (id: string) => void;
  setRules: (text: string) => void;
  setOutlineRules: (text: string) => void;
  setCharGenRules: (text: string) => void;
  setMainGoal: (text: string) => void;
  /** 新增章节（章名自动「第N章」；返回新 id 供选中） */
  addChapter: () => string;
  /** 📚 新增卷（卷名自动「第N卷」；返回新 id 供选中） */
  addVolume: () => string;
  updateVolume: (id: string, patch: Partial<SimVolume>) => void;
  /** 删除卷（卷内章节回到「未分卷」，章节本身不删） */
  deleteVolume: (id: string) => void;
  updateChapter: (id: string, patch: Partial<SimChapter>) => void;
  deleteChapter: (id: string) => void;
  /** 章节上移/下移一位 */
  moveChapter: (id: string, dir: -1 | 1) => void;
  setOutlineBusy: (id: string | null) => void;
  setContentBusy: (id: string | null) => void;

  /** 新建人物节点（pos=地图落点；缺省人物列堆叠） */
  createCharacter: (pos?: { x: number; y: number }) => string;
  /** 新建环境节点（pos=地图落点；缺省环境列堆叠；size=初始尺寸（下限钳制，区域规划整组落地用），缺省默认尺寸；选中后可 NodeResizer 缩放） */
  createEnvironment: (pos?: { x: number; y: number }, size?: { w: number; h: number }) => string;
  /** 更新人物节点字段（仅 kind==='character' 生效） */
  updateCharacter: (id: string, patch: Partial<CharacterData>) => void;
  /** 更新环境节点字段（仅 kind==='environment' 生效） */
  updateEnvironment: (id: string, patch: Partial<EnvironmentData>) => void;
  /** 重定父级：parentId=null 提升回根（position 换算回绝对坐标），否则挂到目标环境节点下（position 换算为相对父坐标） */
  reparentNode: (childId: string, parentId: string | null) => void;
  /** 删除节点（父环境被删时，其后代提升回根层，绝对坐标展开） */
  deleteNode: (id: string) => void;
  replaceState: (s: { nodes: SimNodeType[]; edges: Edge[]; rules?: string; outlineRules?: string; charGenRules?: string; mainGoal?: string; volumes?: SimVolume[]; chapters?: SimChapter[]; responsibleId?: string; cover?: string }) => void;

  onNodesChange: (changes: NodeChange<SimNodeType>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
}

export const useStudioStore = create<SimState>()(
  persist(
    (set, get) => ({
      nodes: [],
      edges: [],
      graphName: '未命名',
      cover: '',
      responsibleId: '',
      rules: '',
      outlineRules: '',
      charGenRules: '',
      mainGoal: '',
      volumes: [],
      chapters: [],
      outlineBusyId: null,
      contentBusyId: null,
      setGraphName: (name) => set({ graphName: name }),
      setCover: (cover) => set({ cover }),

      setResponsibleId: (id) => set({ responsibleId: id }),
      setRules: (text) => set({ rules: text }),
      setOutlineRules: (text) => set({ outlineRules: text }),
      setCharGenRules: (text) => set({ charGenRules: text }),
      setMainGoal: (text) => set({ mainGoal: text }),

      addChapter: () => {
        const { chapters } = get();
        const id = uid();
        set({ chapters: [...chapters, { id, title: `第${chapters.length + 1}章`, volumeId: '', requirement: '', outline: '', content: '' }] });
        return id;
      },
      addVolume: () => {
        const { volumes } = get();
        const id = uid();
        set({ volumes: [...volumes, { id, title: `第${volumes.length + 1}卷`, intro: '' }] });
        return id;
      },
      updateVolume: (id, patch) =>
        set((s) => ({ volumes: s.volumes.map((v) => (v.id === id ? { ...v, ...patch } : v)) })),
      deleteVolume: (id) =>
        set((s) => ({
          volumes: s.volumes.filter((v) => v.id !== id),
          chapters: s.chapters.map((c) => (c.volumeId === id ? { ...c, volumeId: '' } : c)),
        })),
      updateChapter: (id, patch) =>
        set((s) => ({ chapters: s.chapters.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
      deleteChapter: (id) =>
        set((s) => ({
          chapters: s.chapters.filter((c) => c.id !== id),
          outlineBusyId: s.outlineBusyId === id ? null : s.outlineBusyId,
          contentBusyId: s.contentBusyId === id ? null : s.contentBusyId,
        })),
      moveChapter: (id, dir) =>
        set((s) => {
          const i = s.chapters.findIndex((c) => c.id === id);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= s.chapters.length) return {};
          const chapters = [...s.chapters];
          [chapters[i], chapters[j]] = [chapters[j], chapters[i]];
          return { chapters };
        }),
      setOutlineBusy: (id) => set({ outlineBusyId: id }),
      setContentBusy: (id) => set({ contentBusyId: id }),

      createCharacter: (pos) => {
        const { nodes } = get();
        // 缺省人物列 x=0：排在既有节点最低处下方
        const y = nodes.length ? Math.max(...nodes.map((n) => n.position.y + (n.height ?? 150))) + 60 : 0;
        const id = uid();
        const data: CharacterData = { kind: 'character', name: '', gender: 'male', basicInfo: '', identityInfo: '' };
        // 创建即选中：右侧属性面板（SimInspector）立刻可填人名——节点面上不内嵌输入框（v2.3）
        set({
          nodes: [
            ...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
            { id, type: 'character', position: pos ?? { x: 0, y }, data, zIndex: CHAR_ZINDEX, selected: true },
          ],
        });
        return id;
      },

      createEnvironment: (pos, size) => {
        const { nodes } = get();
        // 缺省环境列 x=320：排在既有节点最低处下方
        const y = nodes.length ? Math.max(...nodes.map((n) => n.position.y + (n.height ?? 150))) + 60 : 0;
        const id = uid();
        const data: EnvironmentData = { kind: 'environment', name: '', etype: 'building', desc: '' };
        const w = Math.max(ENV_MIN_W, Math.round(size?.w ?? ENV_DEFAULT_W));
        const h = Math.max(ENV_MIN_H, Math.round(size?.h ?? ENV_DEFAULT_H));
        // 创建即选中：属性面板立刻可填名称/类型/描述（v2.3）
        set({
          nodes: [
            ...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
            { id, type: 'environment', position: pos ?? { x: 320, y }, data, width: w, height: h, selected: true },
          ],
        });
        return id;
      },

      updateCharacter: (id, patch) =>
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === id && n.data.kind === 'character' ? { ...n, data: { ...n.data, ...patch } } : n)),
        })),

      updateEnvironment: (id, patch) =>
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === id && n.data.kind === 'environment' ? { ...n, data: { ...n.data, ...patch } } : n)),
        })),

      reparentNode: (childId, parentId) => {
        const s = get();
        const child = s.nodes.find((n) => n.id === childId);
        if (!child) return;
        if ((child.parentId ?? null) === parentId) return; // 已是目标父子，无操作
        const byId = new Map(s.nodes.map((n) => [n.id, n]));
        if (parentId) {
          if (parentId === childId) return; // 自挂防御：self-parent 会让 RF12 定位坏掉、节点凭空消失（v2.1 踩坑）
          const parent = byId.get(parentId);
          if (!parent || parent.data.kind !== 'environment') return;
          if (isDescendantOf(parentId, childId, byId)) return; // 环：不能挂到自己后代
        }
        const abs = absPositionOf(child, byId);
        let pos = abs;
        if (parentId) {
          const pabs = absPositionOf(byId.get(parentId)!, byId);
          pos = { x: abs.x - pabs.x, y: abs.y - pabs.y };
        }
        set({
          // ⚠ RF12 要求父节点在数组序上先于子节点（见 sortParentsFirst），重定父级后必须重排
          nodes: sortParentsFirst(
            s.nodes.map((n) =>
              n.id === childId
                // ⚠ 不设 expandParent：否则子节点拖出父缘时父容器被自动撑大、中心点永远出不去（v2 踩坑）
                ? { ...n, parentId: parentId ?? undefined, position: pos, zIndex: n.data.kind === 'character' ? CHAR_ZINDEX : undefined }
                : n,
            ),
          ),
        });
      },

      deleteNode: (id) => {
        const s = get();
        if (!s.nodes.some((n) => n.id === id)) return;
        // 后代提升回根：按删除前的父链换算绝对坐标（ towns 删掉不该连房子一起没）
        const byId = new Map(s.nodes.map((n) => [n.id, n]));
        const lifted = new Map(
          s.nodes
            .filter((n) => n.id !== id && isDescendantOf(n.id, id, byId))
            .map((n) => [n.id, { ...n, parentId: undefined, position: absPositionOf(n, byId), zIndex: n.data.kind === 'character' ? CHAR_ZINDEX : undefined }]),
        );
        set({
          nodes: s.nodes.filter((n) => n.id !== id).map((n) => lifted.get(n.id) ?? n),
          edges: s.edges.filter((e) => e.source !== id && e.target !== id),
        });
      },

      // rules/outlineRules/charGenRules/mainGoal/volumes/chapters/responsibleId 不传 = 保留现值（旧调用兼容）；传入则整体替换（存档载入，载入方已 sanitize）
      replaceState: (s) =>
        set((prev) => ({
          ...prev,
          nodes: sortParentsFirst(s.nodes),
          edges: s.edges,
          ...(s.rules !== undefined ? { rules: rulesText(s.rules) } : {}),
          ...(s.outlineRules !== undefined ? { outlineRules: rulesText(s.outlineRules) } : {}),
          ...(s.charGenRules !== undefined ? { charGenRules: rulesText(s.charGenRules) } : {}),
          ...(s.mainGoal !== undefined ? { mainGoal: rulesText(s.mainGoal) } : {}),
          ...(s.volumes !== undefined ? { volumes: s.volumes } : {}),
          ...(s.chapters !== undefined ? { chapters: s.chapters, outlineBusyId: null, contentBusyId: null } : {}),
          ...(s.responsibleId !== undefined ? { responsibleId: s.responsibleId } : {}),
          ...(s.cover !== undefined ? { cover: s.cover } : {}),
        })),

      onNodesChange: (changes) => {
        // Del/Backspace 删除（含框选多选）：confirm 后删除；其余（位置/尺寸/选择）照常——
        // NodeResizer 的 dimensions change 也走这里 applyNodeChanges 写 node.width/height
        const removes = changes.filter((c) => c.type === 'remove');
        const rest = changes.filter((c) => c.type !== 'remove') as NodeChange<SimNodeType>[];
        if (rest.length) set((s) => ({ nodes: applyNodeChanges(rest, s.nodes) }));
        if (!removes.length) return;
        const targets = removes
          .map((r) => get().nodes.find((n) => n.id === r.id))
          .filter((n): n is SimNodeType => !!n);
        if (!targets.length) return;
        if (!window.confirm(`删除选中的 ${targets.length} 个节点？（父环境的内部节点将提升回根层）`)) return;
        targets.forEach((n) => get().deleteNode(n.id));
      },
      onEdgesChange: (changes) => set((s) => ({ edges: applyEdgeChanges(changes, s.edges) })),
    }),
    {
      name: 'nc2-sim-v1',
      version: 2,
      // 本地恢复后 sanitize 兜底（重建数据/尺寸默认/parentId 清洗/连线清洗）。
      // 必须放 merge：persist 的 hydrate 在 create() 期间同步执行，onRehydrateStorage 回调里
      // useStudioStore 尚未初始化（TDZ），setState 抛 ReferenceError 且被 persist 静默吞掉
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SimState>;
        const merged = { ...current, ...p };
        const { nodes, edges } = sanitizeSimNodes(merged.nodes ?? [], merged.edges ?? []);
        // 规则兜底：string 直通、旧对象形态 {world,style} 拼接、损坏回空串（新增字段无需版本迁移）
        // 章节列表兜底重建；大纲生成瞬态归 null
        return {
          ...merged,
          nodes,
          edges,
          rules: rulesText(merged.rules),
          outlineRules: rulesText(merged.outlineRules),
          charGenRules: rulesText(merged.charGenRules),
          mainGoal: rulesText(merged.mainGoal),
          volumes: sanitizeVolumes(merged.volumes),
          chapters: sanitizeChapters(merged.chapters),
          responsibleId: typeof merged.responsibleId === 'string' ? merged.responsibleId : '',
          // 封面兜底：只认本地图片 data URL（旧档/损坏缓存回未设置）
          cover: typeof merged.cover === 'string' && merged.cover.startsWith('data:image/') ? merged.cover : '',
          outlineBusyId: null,
          contentBusyId: null,
        };
      },
    },
  ),
);
