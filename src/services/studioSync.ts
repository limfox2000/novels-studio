/**
 * 创作台本地存档（v2.12 用户拍板：创作台内容一律保存在本机，不再上传服务器）。
 * 两层本地保存（手动）：所有编辑先留在内存并标记未保存；
 *  ① 当前作品手动保存到 localStorage（zustand persist nc2-sim-v1；点「保存」/Ctrl+S 或载入存档时写入）；
 *  ② 命名存档列表（localStorage nc2-sim-archives-v1）：💾 保存按图名快照（同名覆盖），📂 打开列出/载入/删除。
 * 快照结构 v4（人物库 v3）：graph: {boards, characters, activeBoardId, rules, outlineRules, chapters, volumes, snapshots 随 chapters}；
 * v3 及更早旧快照载入时迁移：单画布 nodes/edges 迁进默认主画布、旧卷补空画布、人物从画布节点一次性提取
 * （characterId=旧 node.id——用户豁免无迁移向导，不兼容的旧人物数据直接丢弃）；未来版本拒绝载入且不改数据。
 * 历史服务器存档未删除，如需找回可从 simgraphs/ 手动取回。
 */
import {
  useStudioStore,
  sanitizeSimNodes,
  sanitizeBoards,
  sanitizeChapters,
  sanitizeVolumes,
  rulesText,
  DEFAULT_BOARD_ID,
  saveStudioWorkspace,
} from '../stores/studioStore';
import { extractCharactersFromBoards, sanitizeCharacters } from '../stores/characterStates';
import { sanitizeSimProfiles } from '../stores/simProfiles';
import { sanitizeRelations } from '../stores/simTags';
import { useUiStore } from '../stores/uiStore';
import { persistActiveChapterId } from '../stores/activeChapter';
import { syncActiveChapterScene, withChapterSceneSyncSuppressed } from '../stores/chapterSceneSync';
import type { Edge } from '@xyflow/react';
import type { SimBoard, SimChapter, SimNodeType, SimProfile, SimRelation, SimVolume, WorkCharacter } from '../types/sim';

const ARCHIVES_KEY = 'nc2-sim-archives-v1';
export const ARCHIVE_VERSION = 4;

export interface ArchiveGraph {
  boards?: Record<string, SimBoard>;
  /** 📇 人物库（v4；v3 及更早无此字段 → 载入时从画布节点一次性提取） */
  characters?: unknown;
  /** 🎬 推演档案（v4 可选内嵌字段；缺失 → 按人物库自动补默认档，不升版本） */
  simProfiles?: unknown;
  /** 🔗 人物关系边（v4 可选内嵌字段；缺失 → 空数组，不升版本） */
  relations?: unknown;
  activeBoardId?: string;
  /** 保存时的当前章节（v2.32，可选；旧档无此字段 → 载入后回落到首章） */
  activeChapterId?: string;
  /** 旧格式（无 boards）：单画布节点/连线 */
  nodes?: SimNodeType[];
  edges?: unknown[];
  rules?: unknown;
  outlineRules?: unknown;
  charGenRules?: unknown;
  mainGoal?: unknown;
  volumes?: unknown;
  chapters?: unknown;
  responsibleId?: unknown;
  cover?: unknown;
}

export interface SimArchive {
  name: string;
  savedAt: string;
  version?: number;
  graph: ArchiveGraph;
}

export interface ArchiveMigrationStep {
  code: string;
  message: string;
}

export interface LoadArchiveResult {
  ok: boolean;
  fromVersion: number;
  steps: ArchiveMigrationStep[];
  warnings: string[];
  error?: string;
}

export interface ImportArchiveResult extends LoadArchiveResult {
  name?: string;
  /** 同名存档已存在且未确认覆盖 */
  conflict?: boolean;
}

interface NormalizedGraph {
  boards: Record<string, SimBoard>;
  characters: Record<string, WorkCharacter>;
  /** 🎬 推演档案（与人物库一一对应，缺失自动补默认档） */
  simProfiles: Record<string, SimProfile>;
  /** 🔗 人物关系边（作品级；缺失=空） */
  relations: SimRelation[];
  activeBoardId: string;
  activeChapterId: string;
  rules: string;
  outlineRules: string;
  charGenRules: string;
  mainGoal: string;
  volumes: SimVolume[];
  chapters: SimChapter[];
  responsibleId: string;
  cover: string;
}

interface PreparedArchive {
  result: LoadArchiveResult;
  name: string;
  savedAt: string;
  graph?: NormalizedGraph;
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

function archiveVersion(a: SimArchive): number {
  if (typeof a.version === 'number' && Number.isFinite(a.version)) return a.version;
  const g = a.graph;
  return g && typeof g === 'object' && g.boards && typeof g.boards === 'object' ? 2 : 0;
}

// ── 存档验证/迁移（载入与导入共用同一路径，绝不改旧存档） ──

function normalizeArchive(raw: unknown, fallbackName: string, extraSteps: ArchiveMigrationStep[] = []): PreparedArchive {
  const steps: ArchiveMigrationStep[] = [...extraSteps];
  const warnings: string[] = [];
  const fail = (error: string, fromVersion = 0): PreparedArchive => ({
    result: { ok: false, fromVersion, steps, warnings, error },
    name: fallbackName,
    savedAt: new Date().toISOString(),
  });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('存档数据不是有效对象');
  const a = raw as Partial<SimArchive> & Record<string, unknown>;
  const graph = (a.graph && typeof a.graph === 'object' && !Array.isArray(a.graph) ? a.graph : null) as ArchiveGraph | null;
  if (!graph) return fail('存档缺少 graph 数据');

  const rawVersion = typeof a.version === 'number' && Number.isFinite(a.version) ? a.version : undefined;
  const hasBoards = !!graph.boards && typeof graph.boards === 'object' && !Array.isArray(graph.boards);
  const fromVersion = rawVersion ?? (hasBoards ? 2 : 0);
  if (fromVersion > ARCHIVE_VERSION) {
    return fail(`存档版本 ${fromVersion} 高于当前支持的 v${ARCHIVE_VERSION}，已拒绝载入（未修改任何数据）`, fromVersion);
  }
  if (fromVersion < ARCHIVE_VERSION) {
    steps.push({ code: 'upgrade-v3', message: `存档版本 ${fromVersion || '旧版'} → v${ARCHIVE_VERSION}（仅本次载入/导入时迁移，旧存档不改写）` });
  }

  const name = (typeof a.name === 'string' && a.name.trim()) || fallbackName.trim() || '导入存档';
  const savedAt = typeof a.savedAt === 'string' && a.savedAt ? a.savedAt : new Date().toISOString();
  const rules = rulesText(graph.rules);
  const outlineRules = rulesText(graph.outlineRules);
  const charGenRules = rulesText(graph.charGenRules);
  const mainGoal = rulesText(graph.mainGoal);
  const volumes = sanitizeVolumes(graph.volumes);
  const chapters = sanitizeChapters(graph.chapters);
  const responsibleId = typeof graph.responsibleId === 'string' ? graph.responsibleId : '';
  const cover = typeof graph.cover === 'string' && graph.cover.startsWith('data:image/') ? graph.cover : '';

  // 📇 人物库：v4 直读；v3 及更早无 characters → 从画布节点一次性提取（见文件头注释）
  const hasLibrary = !!graph.characters && typeof graph.characters === 'object' && !Array.isArray(graph.characters);
  const knownCharacters = hasLibrary ? sanitizeCharacters(graph.characters) : undefined;

  let boards: Record<string, SimBoard>;
  let characters: Record<string, WorkCharacter>;
  if (hasBoards) {
    ({ boards, characters } = sanitizeBoards(graph.boards, volumes, undefined, chapters, knownCharacters));
  } else {
    // 旧归档：单画布 nodes/edges 迁进默认主画布，旧卷补空画布
    const nodes = graph.nodes ?? [];
    if (!Array.isArray(nodes) || nodes.some((n) => !n || !n.data)) {
      return fail(`存档「${name}」数据损坏，无法载入`, fromVersion);
    }
    // 先提取人物（characterId=旧 node.id），再带库清洗节点（无法兼容的旧人物数据直接丢弃）
    const preCharacters = knownCharacters ?? extractCharactersFromBoards([{ nodes }]).characters;
    const clean = sanitizeSimNodes(nodes, (graph.edges as Edge[] | undefined) ?? [], preCharacters);
    if (!clean.nodes.length && nodes.length) {
      return fail(`「${name}」存档与当前创作台节点形态不兼容（已过滤 ${nodes.length} 个节点）`, fromVersion);
    }
    if (clean.dropped > 0) warnings.push(`已过滤 ${clean.dropped} 个非法节点`);
    ({ boards, characters } = sanitizeBoards(
      undefined,
      volumes,
      { nodes: clean.nodes, edges: clean.edges },
      chapters,
      preCharacters,
    ));
    steps.push({ code: 'single-canvas', message: '旧单画布存档已迁入默认主画布' });
  }
  if (!hasLibrary && characters && Object.keys(characters).length) {
    steps.push({ code: 'character-library', message: `人物已迁入作品级人物库（${Object.keys(characters).length} 人）` });
  }
  // 🎬 推演档案：旧档缺失 → 按人物库补默认档（与人物库一一对应）
  const simProfiles = sanitizeSimProfiles(graph.simProfiles, characters);
  // 🔗 关系边：旧档缺失 → 空数组；悬空/未知标签过滤
  const relations = sanitizeRelations(graph.relations, characters);

  for (const c of chapters) {
    const snap = c.snapshot;
    if (snap && !boards[snap.boardId]) {
      warnings.push(`章节「${c.title || '未命名'}」的名单来源画布已不存在；快照保留，可在新画布重新采集`);
    }
  }
  const activeBoardId =
    typeof graph.activeBoardId === 'string' && boards[graph.activeBoardId] ? graph.activeBoardId : DEFAULT_BOARD_ID;
  const activeChapterId =
    typeof graph.activeChapterId === 'string' && chapters.some((c) => c.id === graph.activeChapterId)
      ? graph.activeChapterId
      : (chapters[0]?.id ?? '');

  return {
    result: { ok: true, fromVersion, steps, warnings },
    name,
    savedAt,
    graph: {
      boards,
      characters,
      simProfiles,
      relations,
      activeBoardId,
      activeChapterId,
      rules,
      outlineRules,
      charGenRules,
      mainGoal,
      volumes,
      chapters,
      responsibleId,
      cover,
    },
  };
}

/** 供 UI 显示迁移/警告摘要（无问题返回空串） */
export function archiveResultSummary(r: LoadArchiveResult): string {
  const lines: string[] = [];
  if (r.steps.length) lines.push(`迁移：${r.steps.map((s) => s.message).join('；')}`);
  if (r.warnings.length) lines.push(`提示：${r.warnings.join('；')}`);
  return lines.join('\n');
}

/** 💾 手动保存：先写当前作品进度（nc2-sim-v1），再更新本地命名存档（同名覆盖） */
export function saveLocal(): void {
  const ui = useUiStore.getState();
  // 先同步当前章场景，保证正在摆放的人物位置/状态一起落盘
  syncActiveChapterScene();
  // 作品进度最关键：写失败时保留待保存数据，不再写命名存档
  if (!saveStudioWorkspace()) return;
  const s = useStudioStore.getState();
  // UI 章节定位只在保存成功后记下；刷新时用它让高亮与画布场景一致
  persistActiveChapterId(useUiStore.getState().activeChapterId);
  const activeChapterId = useUiStore.getState().activeChapterId ?? '';
  try {
    const graph = { boards: s.boards, characters: s.characters, simProfiles: s.simProfiles, relations: s.relations, activeBoardId: s.activeBoardId, activeChapterId, rules: s.rules, outlineRules: s.outlineRules, charGenRules: s.charGenRules, mainGoal: s.mainGoal, volumes: s.volumes, chapters: s.chapters, responsibleId: s.responsibleId, cover: s.cover };
    const list = loadArchives().filter((a) => a.name !== s.graphName);
    list.push({ name: s.graphName, savedAt: new Date().toISOString(), version: ARCHIVE_VERSION, graph });
    writeArchives(list);
    ui.setSaveStatus('saved', '✓ 已保存 ' + new Date().toLocaleTimeString());
  } catch (e) {
    ui.setSaveStatus('error', '⚠ 作品进度已保存，但命名存档失败：' + (e as Error).message);
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

/** 载入本地命名存档：验证/迁移后替换当前图；失败返回结构化错误，不破坏当前状态 */
export function loadLocalArchive(name: string, extraSteps: ArchiveMigrationStep[] = []): LoadArchiveResult {
  const a = loadArchives().find((x) => x.name === name);
  if (!a) {
    return { ok: false, fromVersion: 0, steps: [], warnings: [], error: `❌ 本地存档「${name}」不存在。` };
  }
  const prep = normalizeArchive(a, name, extraSteps);
  if (!prep.result.ok || !prep.graph) return prep.result;
  withChapterSceneSyncSuppressed(() => {
    const s = useStudioStore.getState();
    s.replaceState(prep.graph!);
    s.setGraphName(name);
    useUiStore.getState().setActiveChapterId(prep.graph!.activeChapterId || null);
    persistActiveChapterId(prep.graph!.activeChapterId || null);
  });
  // 载入是显式操作：立即把载入结果写为当前作品，避免刷新后回到载入前的图
  if (saveStudioWorkspace()) {
    useUiStore.getState().setSaveStatus('saved', '✓ 已载入并保存 ' + new Date().toLocaleTimeString());
  }
  return prep.result;
}

/** 导出当前命名存档为 v4 JSON（旧档先走同一验证/迁移路径，不修改本地存档） */
export function exportLocalArchive(name: string): { ok: true; json: string } | { ok: false; error: string } {
  const a = loadArchives().find((x) => x.name === name);
  if (!a) return { ok: false, error: `本地存档「${name}」不存在。` };
  const prep = normalizeArchive(a, name);
  if (!prep.result.ok || !prep.graph) return { ok: false, error: prep.result.error || '存档校验失败' };
  const out: SimArchive = { name: prep.name, savedAt: prep.savedAt, version: ARCHIVE_VERSION, graph: prep.graph };
  return { ok: true, json: JSON.stringify(out, null, 2) };
}

/** 导入 JSON：走与载入相同的验证/迁移路径，保存为本地命名存档（不替换当前图）。
 *  同名存档默认拒绝；UI 确认后以 overwrite 再调用。失败不写任何存档。 */
export function importLocalArchive(
  jsonText: string,
  fileName: string,
  opts: { overwrite?: boolean } = {},
): ImportArchiveResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { ok: false, fromVersion: 0, steps: [], warnings: [], error: '文件不是有效 JSON' };
  }
  const fallback = fileName.replace(/\.(json|novels-canvas)$/i, '').replace(/\.novels-canvas$/i, '').trim() || '导入存档';
  const prep = normalizeArchive(raw, fallback, [{ code: 'import', message: `从文件「${fileName}」导入` }]);
  if (!prep.result.ok || !prep.graph) return { ...prep.result, name: prep.name };
  const existing = loadArchives();
  if (existing.some((x) => x.name === prep.name) && !opts.overwrite) {
    return { ...prep.result, ok: false, name: prep.name, conflict: true };
  }
  try {
    const list = existing.filter((x) => x.name !== prep.name);
    list.push({ name: prep.name, savedAt: new Date().toISOString(), version: ARCHIVE_VERSION, graph: prep.graph });
    writeArchives(list);
  } catch (e) {
    return {
      ...prep.result,
      ok: false,
      name: prep.name,
      error: `写入本地存档失败：${(e as Error).message}`,
    };
  }
  return { ...prep.result, name: prep.name };
}

/** 兼容入口（main.tsx 调用）：本地模式无需初始化——persist 每次 set 已实时写 localStorage，不上服务器 */
export function initStudioSync(): void {}
