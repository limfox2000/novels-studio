/**
 * 创作台本地存档（v2.12 用户拍板：创作台内容一律保存在本机，不再上传服务器）。
 * 两层本地保存：
 *  ① 当前图实时持久化 localStorage（zustand persist nc2-sim-v1，每次 set 自动写，刷新/关浏览器不丢）；
 *  ② 命名存档列表（localStorage nc2-sim-archives-v1）：💾 保存按图名快照（同名覆盖），📂 打开列出/载入/删除。
 * 快照结构与原服务器存档一致（graph: {nodes,edges,rules,outlineRules,chapters}）；历史服务器存档未删除，
 * 如需找回可从 simgraphs/ 手动取回。
 */
import { useStudioStore, sanitizeSimNodes, sanitizeChapters, sanitizeVolumes, rulesText } from '../stores/studioStore';
import { useUiStore } from '../stores/uiStore';
import type { Edge } from '@xyflow/react';
import type { SimNodeType } from '../types/sim';

const ARCHIVES_KEY = 'nc2-sim-archives-v1';

interface SimArchive {
  name: string;
  savedAt: string;
  graph: { nodes?: SimNodeType[]; edges?: unknown[]; rules?: unknown; outlineRules?: unknown; charGenRules?: unknown; mainGoal?: unknown; volumes?: unknown; chapters?: unknown; responsibleId?: unknown; cover?: unknown };
}

function loadArchives(): SimArchive[] {
  try {
    const v = JSON.parse(localStorage.getItem(ARCHIVES_KEY) || '[]') as unknown;
    return Array.isArray(v) ? (v as SimArchive[]) : [];
  } catch {
    return [];
  }
}

function writeArchives(list: SimArchive[]): void {
  localStorage.setItem(ARCHIVES_KEY, JSON.stringify(list));
}

/** 💾 保存：当前图快照进本地命名存档（同名覆盖；当前状态本身已由 persist 实时保存，这里提供多存档位） */
export function saveLocal(): void {
  const s = useStudioStore.getState();
  const ui = useUiStore.getState();
  try {
    const graph = { nodes: s.nodes, edges: s.edges, rules: s.rules, outlineRules: s.outlineRules, charGenRules: s.charGenRules, mainGoal: s.mainGoal, volumes: s.volumes, chapters: s.chapters, responsibleId: s.responsibleId, cover: s.cover };
    const list = loadArchives().filter((a) => a.name !== s.graphName);
    list.push({ name: s.graphName, savedAt: new Date().toISOString(), graph });
    writeArchives(list);
    ui.setSaveStatus('saved', '✓ 已存本机 ' + new Date().toLocaleTimeString());
  } catch (e) {
    ui.setSaveStatus('error', '⚠ 本地保存失败：' + (e as Error).message);
  }
}

/** 本地存档列表（新→旧）；cover 为快照里保存的封面 data URL（旧存档无封面 → undefined） */
export function listLocalArchives(): Array<{ name: string; savedAt: string; cover?: string }> {
  return loadArchives()
    .slice()
    .reverse()
    .map(({ name, savedAt, graph }) => {
      const cover = graph?.cover;
      return { name, savedAt, ...(typeof cover === 'string' && cover.startsWith('data:image/') ? { cover } : {}) };
    });
}

/** 删除本地命名存档 */
export function deleteLocalArchive(name: string): void {
  writeArchives(loadArchives().filter((a) => a.name !== name));
}

/** 载入本地命名存档：节点/连线/规则/章节 sanitize 兜底（与原服务器载入同路径），成功返回 true */
export function loadLocalArchive(name: string): boolean {
  const a = loadArchives().find((x) => x.name === name);
  if (!a) {
    alert(`❌ 本地存档「${name}」不存在。`);
    return false;
  }
  const nodes = a.graph?.nodes ?? [];
  if (!Array.isArray(nodes) || nodes.some((n) => !n || !n.data)) {
    alert(`❌ 「${name}」存档数据损坏，无法载入。`);
    return false;
  }
  const { nodes: kept, edges: keptEdges, dropped } = sanitizeSimNodes(nodes, (a.graph?.edges as Edge[] | undefined) ?? []);
  if (!kept.length && nodes.length) {
    alert(`「${name}」存档与当前创作台节点形态不兼容（已过滤 ${nodes.length} 个节点）。`);
    return false;
  }
  // 规则/章节兜底同服务器路径：旧快照缺字段 → 空串/空列表防串图
  const rules = rulesText(a.graph?.rules);
  const outlineRules = rulesText(a.graph?.outlineRules);
  const charGenRules = rulesText(a.graph?.charGenRules);
  const mainGoal = rulesText(a.graph?.mainGoal);
  const volumes = sanitizeVolumes(a.graph?.volumes);
  const chapters = sanitizeChapters(a.graph?.chapters);
  // 🏛 作品责编随快照恢复（旧快照缺字段 → ''=未设置）
  const responsibleId = typeof a.graph?.responsibleId === 'string' ? a.graph.responsibleId : '';
  // 📕 封面随快照恢复（旧快照无此字段 → 清空，避免串上一部作品的封面）
  const cover = typeof a.graph?.cover === 'string' && a.graph.cover.startsWith('data:image/') ? a.graph.cover : '';
  const s = useStudioStore.getState();
  s.replaceState({ nodes: kept, edges: keptEdges, rules, outlineRules, charGenRules, mainGoal, volumes, chapters, responsibleId, cover });
  if (dropped > 0) alert(`已过滤 ${dropped} 个非法节点。`);
  s.setGraphName(name);
  return true;
}

/** 兼容入口（main.tsx 调用）：本地模式无需初始化——persist 每次 set 已实时写 localStorage，不上服务器 */
export function initStudioSync(): void {}
