/** 📚 编辑部 + 🪑 编辑会议状态。
 *  编辑分两类：本地编辑（localEditors，持久化在 nc2-editorial-v1，仅存浏览器）与服务器编辑（serverEditors，
 *  来自服务器 /api/meditors，只在内存中缓存，源数据在服务器 meeting_editors.json）。
 *  名单合并放在组件内用 useMemo 完成——选择器不能返回新数组（会无限重渲染）。
 *  会议草稿、议题与最近一次会议记录持久化；运行态（cancelled / pendingRemarks）不持久化，
 *  刷新时仍处于 running 的会议标记为 stopped。执行走 meetingEngine.runMeeting。 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  MAIN_MEMORY_CAP,
  MAIN_MEMORY_OPTIMIZE_AT,
  MAIN_MEMORY_OPTIMIZE_TARGET,
  SKILL_MEMORY_CAP,
  SKILL_MEMORY_OPTIMIZE_AT,
  SKILL_MEMORY_OPTIMIZE_TARGET,
  EDITOR_MODULES,
  SKILL_PROBE_TASKS,
  filterChatResidue,
  genSkillCheckSample,
  integrateEditorMemory,
  optimizeEditorMemory,
  runMeeting,
  sanitizeMemoryEntries,
  type Editor,
  type EditorModule,
  type EditorStorage,
  type MeetingTurn,
} from '../engines/meetingEngine';
import { appendToSkillCopy, blankSkillMemories, blankSkillMemory, isUntunedMemory, parseSectionDraft, revalidateSkillCopy, templateCraftSections, trimSkillCopy, upgradeSkillCopy, type SectionDraft } from '../engines/memoryTemplates';
import type { MaterialKey } from '../engines/studioEngine';

// 生成能力模块定义收拢在 meetingEngine（v2.21 作家编辑），此处转发给既有组件导入路径
export { EDITOR_MODULES, EDITOR_MODULE_DESC, type EditorModule } from '../engines/meetingEngine';

import { useEditorRoomStore } from './editorRoomStore';
import { useStudioStore } from './studioStore';
import { stopGeneration } from '../shared/generation';
import { snippetList, snippetSave, snippetDelete, EDITOR_SNIPPET_PREFIX, type TextSnippet } from '../services/imgApi';
import type { ResponsibleEditor } from '../engines/studioEngine';

export type EditorialMode = 'chat' | 'meeting';
export type MeetingStatus = 'idle' | 'running' | 'done' | 'stopped' | 'error';

export interface MeetingDraft {
  editorIds: string[];
  materials: MaterialKey[];
  rounds: number;
}

export interface EditorInput {
  name: string;
  /** 擅长题材（v2.22 描述式文本，如「善于科幻题材」；''=不限） */
  specialty: string;
  persona: string;
  storage: EditorStorage;
}

export const EDITOR_PRESETS: Array<Omit<Editor, 'id' | 'enabled' | 'storage'>> = [
  {
    name: '人物性格编辑',
    specialty: '不限题材',
    persona: '审视人物性格是否统一、动机是否可信、成长弧线是否清楚；指出人设与行为矛盾之处，并建议可落地的性格刻画方式。',
  },
  {
    name: '剧情节奏编辑',
    specialty: '不限题材',
    persona: '审视章节与事件的推进速度、张弛与高潮分布；指出拖沓或过快的段落，给出调整节拍的具体建议。',
  },
  {
    name: '世界观一致性编辑',
    specialty: '不限题材',
    persona: '对照全文规则与画布设定，检查世界观、地点、时间线与规则是否自相矛盾，并指出需要补充或修正的设定。',
  },
  {
    name: '文风编辑',
    specialty: '不限题材',
    persona: '审视叙述视角、语言风格与全文规则中的文风要求是否一致；关注冗余与语感，提出统一文风的写法建议。',
  },
  {
    name: '伏笔悬念编辑',
    specialty: '不限题材',
    persona: '检查伏笔是否有埋有收、悬念是否足够吸引读者；指出悬空的线索，并建议在哪一章回收或加强。',
  },
];

const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const PRESET_IDS = EDITOR_PRESETS.map((_, i) => `preset-${i}`);

/** v2.22 擅长题材=描述式字符串：兼容旧数据的功能模块数组（join 成文本，旧模块名原样保留可再编辑）与单值字符串 */
function normSpecialty(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean).join('、');
  return typeof v === 'string' ? v.trim() : '';
}

/** v2.21 技能记忆表规范化：只保留现役生成能力键、值必须为非空字符串（旧/异常键丢弃）；
 *  v2.27 读取时同步做模板升级（人物生成：旧「基本信息/外观/性格」→ 新「基础属性/基础信息/身份信息」），
 *  调教条目保留、旧骨架剔除——否则旧副本过不了 revalidateSkillCopy 的严格小节校验，新条目会被静默丢弃。 */
function normSkills(v: unknown): Partial<Record<EditorModule, string>> {
  const out: Partial<Record<EditorModule, string>> = {};
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if ((EDITOR_MODULES as readonly string[]).includes(k) && typeof val === 'string' && val.trim()) {
        const mod = k as EditorModule;
        out[mod] = upgradeSkillCopy(mod, val);
      }
    }
  }
  return out;
}

const withStorage = (items: Omit<Editor, 'storage'>[] | Editor[], storage: EditorStorage): Editor[] =>
  items.map((e) => {
    const skills = normSkills(e.skills);
    return { ...e, specialty: normSpecialty(e.specialty), ...(Object.keys(skills).length ? { skills } : {}), storage } as Editor;
  });

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 服务器编辑复用文本素材库接口（/api/snippet*），以 EDITOR_SNIPPET_PREFIX 区分 */
function toServerEditors(list: TextSnippet[]): Editor[] {
  const out: Editor[] = [];
  for (const s of list) {
    if (!s.name.startsWith(EDITOR_SNIPPET_PREFIX)) continue;
    try {
      const d = JSON.parse(s.text);
      out.push({
        id: s.name.slice(EDITOR_SNIPPET_PREFIX.length),
        name: String(d.name ?? ''),
        specialty: normSpecialty(d.specialty),
        persona: String(d.persona ?? ''),
        memory: typeof d.memory === 'string' && d.memory.trim() ? d.memory : undefined,
        skills: normSkills(d.skills),
        enabled: d.enabled !== false,
        storage: 'server',
      });
    } catch {
      continue;
    }
  }
  return out;
}

async function serverUpsert(e: Editor): Promise<Editor[]> {
  const list = await snippetSave(
    EDITOR_SNIPPET_PREFIX + e.id,
    JSON.stringify({ name: e.name, specialty: e.specialty, persona: e.persona, memory: e.memory ?? '', skills: e.skills ?? {}, enabled: e.enabled }),
  );
  return toServerEditors(list);
}

interface EditorialState {
  mode: EditorialMode;
  localEditors: Editor[];
  serverEditors: Editor[];
  serverError: string;
  draft: MeetingDraft;
  status: MeetingStatus;
  topic: string;
  turns: MeetingTurn[];
  error: string;
  pendingRemarks: string[];
  cancelled: boolean;
  /** 会议进行中：编辑室对话的发送是否转入会议讨论（不持久化） */
  routeChat: boolean;
  setMode: (m: EditorialMode) => void;
  setRouteChat: (on: boolean) => void;
  /** 🏛 当前作品责任编辑（v2.21，编辑 ID 存在 studioStore.responsibleId 随作品存档）：
   *  解析为纯数据（未设置/已删除/已停用返回 undefined）；memory 取该编辑在此模块的技能记忆，
   *  由引擎调用点传纯数据，避免引擎反向依赖 store */
  getWorkResponsibleData: (module: EditorModule) => ResponsibleEditor | undefined;
  loadServerEditors: () => Promise<void>;
  addEditor: (e: EditorInput) => Promise<boolean>;
  updateEditor: (id: string, patch: Partial<Pick<Editor, 'name' | 'specialty' | 'persona' | 'memory' | 'skills' | 'enabled'>>) => Promise<boolean>;
  /** 🧠 吸收一条记忆更新（v2.21 双通道，v2.26 模板副本模式）：target='main' 并入主记忆（上限 MAIN_MEMORY_CAP），
   *  target=模块名 并入该编辑的对应技能记忆副本（上限 SKILL_MEMORY_CAP，保骨架截断）。吸收门槛全是确定性代码
   *  校验（无模型评审）：正向表述剔除 → 对话残留过滤（客套/指称/转述/疑问句）→ 技能条目按模板小节归类
   *  （无小节头/归属无效的行宁可不记）→ 行级去重；任一步全剔 = 不写入（防患于未然，绝不让污染条目落库）。
   *  过关条目再交模型整合（合并近义、矛盾以新增为准），技能输出由 revalidateSkillCopy 重建式复验
   *  （骨架由模板原样补齐）；整合失败回退确定性追加（技能=appendToSkillCopy 按小节插入基线之下），
   *  超优化阈值先 AI 精简（失败回退 trimSkillCopy 保骨架截断）。技能副本被清空时按模板重新铺底。
   *  编辑已删除或清洗后无有效新条目则仅清掉该条待办（既有记忆绝不因截断/空草稿被洗掉） */
  absorbMemoryDraft: (msgId: string, editorId: string, target: string, draft: string) => Promise<void>;
  /** 🧪 手动检验技能记忆（干净子 agent）：不带对话历史，仅职责+当前该模块技能记忆+任务生成一次样例，
   *  结果写回该消息条目的 check 字段（checking→sample/error，可重复点击覆盖）；只展示，不影响已写入记忆。
   *  task 为空时用 SKILL_PROBE_TASKS 的该模块标准任务 */
  checkSkillMemory: (msgId: string, editorId: string, target: string, task?: string) => Promise<void>;
  removeEditor: (id: string) => Promise<boolean>;
  setDraft: (patch: Partial<MeetingDraft>) => void;
  startMeeting: (request: string) => Promise<void>;
  stopMeeting: () => void;
  addRemark: (text: string) => void;
  clearMeeting: () => void;
}

export const useEditorialStore = create<EditorialState>()(
  persist(
    (set, get) => ({
      mode: 'chat',
      localEditors: EDITOR_PRESETS.map((p, i) => ({ ...p, id: PRESET_IDS[i], enabled: true, storage: 'local' as const, skills: blankSkillMemories() })),
      serverEditors: [],
      serverError: '',
      draft: { editorIds: PRESET_IDS.slice(0, 2), materials: ['mainGoal', 'canvas'], rounds: 2 },
      status: 'idle',
      topic: '',
      turns: [],
      error: '',
      pendingRemarks: [],
      cancelled: false,
      routeChat: false,

      setMode: (m) => set({ mode: m }),

      setRouteChat: (on) => set({ routeChat: on }),

      getWorkResponsibleData: (module) => {
        const s = get();
        const rid = useStudioStore.getState().responsibleId;
        const ed = [...s.localEditors, ...s.serverEditors].find((e) => e.id === rid && e.enabled);
        if (!ed) return undefined;
        return { name: ed.name, specialty: ed.specialty, persona: ed.persona, memory: (ed.skills ?? {})[module] };
      },

      loadServerEditors: async () => {
        try {
          const items = toServerEditors(await snippetList());
          set({ serverEditors: items, serverError: '' });
        } catch (e) {
          set({ serverError: `正式编辑读取失败：${errMsg(e)}` });
        }
      },

      addEditor: async (input) => {
        const id = newId(input.storage === 'server' ? 'sv' : 'ed');
        // 记忆副本随创建复制：八个模块各一份模板全文（骨架+出厂基线），调教沉淀随后按小节追加
        const e: Editor = { id, name: input.name, specialty: input.specialty, persona: input.persona, skills: blankSkillMemories(), enabled: true, storage: input.storage };
        const addToDraft = (s: EditorialState) => ({ ...s.draft, editorIds: [...s.draft.editorIds, id] });
        if (input.storage === 'local') {
          set((s) => ({ localEditors: [...s.localEditors, e], draft: addToDraft(s) }));
          return true;
        }
        try {
          const items = await serverUpsert(e);
          set((s) => ({ serverEditors: items, serverError: '', draft: addToDraft(s) }));
          return true;
        } catch (err) {
          set({ serverError: `保存正式编辑失败：${errMsg(err)}` });
          return false;
        }
      },

      updateEditor: async (id, patch) => {
        const s = get();
        if (s.localEditors.some((e) => e.id === id)) {
          set((st) => ({ localEditors: st.localEditors.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
          return true;
        }
        const cur = s.serverEditors.find((e) => e.id === id);
        if (!cur) return false;
        try {
          const items = await serverUpsert({ ...cur, ...patch });
          set({ serverEditors: items, serverError: '' });
          return true;
        } catch (err) {
          set({ serverError: `保存正式编辑失败：${errMsg(err)}` });
          return false;
        }
      },

      absorbMemoryDraft: async (msgId, editorId, target, draft) => {
        // 主记忆 / 技能记忆双通道：目标无效一律落主记忆（genEditorTurn 已做过同样的兜底）
        const isMain = target === 'main' || !(EDITOR_MODULES as readonly string[]).includes(target);
        const cap = isMain ? MAIN_MEMORY_CAP : SKILL_MEMORY_CAP;
        const optimizeAt = isMain ? MAIN_MEMORY_OPTIMIZE_AT : SKILL_MEMORY_OPTIMIZE_AT;
        const optimizeTarget = isMain ? MAIN_MEMORY_OPTIMIZE_TARGET : SKILL_MEMORY_OPTIMIZE_TARGET;
        const setEntry = (patch: { done?: boolean; count?: number } | null) =>
          useEditorRoomStore.setState((s) => ({
            messages: s.messages.map((x) => {
              if (x.id !== msgId) return x;
              const list = (x.memUpdates ?? [])
                .map((u) => (u.target === target ? (patch ? { ...u, ...patch } : null) : u))
                .filter((u): u is NonNullable<typeof u> => !!u);
              return { ...x, memUpdates: list.length ? list : undefined };
            }),
          }));
        const cur = [...get().localEditors, ...get().serverEditors].find((e) => e.id === editorId);
        if (!cur) {
          setEntry(null);
          return;
        }
        // 先格式后写入（v2.26 模板副本模式）：吸收门槛全部是确定性代码校验（无模型评审），污染条目在写入前就被拦下——
        // 正向表述 → 对话残留过滤 →（技能）按模板小节归类（无小节头/归属无效的行宁可不记）→ 行级去重；任一步全剔 = 不写入。
        // 整合式吸收（v2.24）：过了门槛的新条目再与现有记忆交由模型整体整合（合并近义、矛盾以新增为准、无关条目保留），
        // 技能整合输出由 revalidateSkillCopy 重建式复验（骨架由模板原样补齐，条目再过行级过滤）。
        // 整合失败/互斥被占 → 回退确定性路径：主记忆直接追加（行已过校验）；技能 appendToSkillCopy 按小节插入基线之下。
        const normLine = (l: string) => l.trim().replace(/\s+/g, '');
        const mod = target as EditorModule;
        let oldText = isMain ? (cur.memory ?? '') : upgradeSkillCopy(mod, (cur.skills ?? {})[mod] ?? '');
        if (!isMain && !oldText.trim()) oldText = blankSkillMemory(mod); // 副本被清空过：按模板重新铺底再吸收
        const oldLines = new Set(oldText.split('\n').map(normLine).filter(Boolean));
        const residue = filterChatResidue(sanitizeMemoryEntries(draft));
        if (residue.dropped) console.warn(`[编辑记忆] 残留过滤剔除 ${residue.dropped} 条对话残留`);
        let groups: SectionDraft[] = [];
        let add = residue.kept;
        const seen = new Set<string>();
        const dedupeLine = (l: string) => {
          if (!l) return false;
          const k = normLine(l);
          if (oldLines.has(k) || seen.has(k)) return false; // 剔模型重抄的既有条目 + 草稿内重复行
          seen.add(k);
          return true;
        };
        if (isMain) {
          add = add
            .split('\n')
            .map((l) => l.trim())
            .filter(dedupeLine)
            .join('\n');
        } else {
          // 技能记忆（模板副本模式）：条目按模板小节归类，无小节头/归属无效（含固定契约小节）的行宁可不记
          const parsed = parseSectionDraft(add, templateCraftSections(mod));
          groups = parsed.groups;
          if (parsed.dropped) console.warn(`[编辑记忆] 小节归类剔除 ${parsed.dropped} 条（无小节头或归属无效）`);
          groups = groups
            .map((g) => ({ section: g.section, lines: g.lines.map((l) => l.trim()).filter(dedupeLine) }))
            .filter((g) => g.lines.length);
          add = groups.flatMap((g) => g.lines).join('\n');
        }
        if (!add.trim()) {
          setEntry(null);
          return;
        }
        const absorbed = add.split('\n').filter(Boolean).length;
        const engine = useEditorRoomStore.getState().settings.engine;
        let memory = oldText.trim();
        let integrated = false;
        if (isMain) {
          const r = await integrateEditorMemory({ oldMemory: memory, additions: add, engine, targetLen: cap });
          if (r.ok && r.memory) {
            memory = r.memory;
            integrated = true;
          } else console.warn('[编辑记忆] 整合失败，回退为直接追加：', r.error);
        } else {
          // 出厂副本（纯模板）免模型整合：条目按小节确定性追加进基线之下即可，省一次生成调用也消灭主要不确定源
          if (!isUntunedMemory(mod, memory)) {
            const additions = groups.map((g) => `## ${g.section}\n${g.lines.join('\n')}`).join('\n');
            const r = await integrateEditorMemory({ oldMemory: memory, additions, engine, targetLen: cap, module: mod });
            if (r.ok && r.memory) {
              const v = revalidateSkillCopy(r.memory, mod);
              // 新增条目必须逐条保留（normalize 后逐行比对）：整合模型静默丢弃新增时回退确定性追加，
              // 杜绝「done 已置位而条目未落库」（真机测试发现：整合输出纯模板也过骨架校验）
              const allKept = !!v.memory && groups.every((g) => g.lines.every((l) => v.memory!.includes(normLine(l))));
              if (v.ok && v.memory && allKept) {
                memory = v.memory;
                integrated = true;
                if (v.dropped) console.warn(`[编辑记忆] 整合输出剔除 ${v.dropped} 条不合格条目`);
              } else console.warn(v.ok ? '[编辑记忆] 整合输出未保留新增条目，回退为确定性追加' : '[编辑记忆] 整合输出骨架校验不合格，回退为确定性追加');
            } else if (!r.ok) console.warn('[编辑记忆] 整合失败，回退为确定性追加：', r.error);
          }
        }
        if (!integrated) {
          if (isMain) {
            memory = memory ? `${memory}\n${add}` : add;
            if (memory.length > optimizeAt) {
              // 记忆优化：合并去重精简回阈值内；失败（含生成互斥被占）回退为直接截断写入
              const o = await optimizeEditorMemory({ memory, engine, targetLen: optimizeTarget });
              if (o.ok && o.memory) memory = o.memory;
              else console.warn('[编辑记忆] 优化失败，按上限截断写入：', o.error);
            }
          } else {
            memory = appendToSkillCopy(memory, groups); // 行已过校验，确定性插入对应小节基线之下
            if (memory.length > optimizeAt) {
              const o = await optimizeEditorMemory({ memory, engine, targetLen: optimizeTarget, module: mod });
              if (o.ok && o.memory) {
                const v = revalidateSkillCopy(o.memory, mod);
                if (v.ok && v.memory) memory = v.memory;
                else console.warn('[编辑记忆] 优化输出骨架校验不合格，保骨架截断写入');
              } else console.warn('[编辑记忆] 优化失败，保骨架截断写入：', o.error);
            }
            memory = trimSkillCopy(memory, mod, cap);
          }
        } else if (!isMain) {
          memory = trimSkillCopy(memory, mod, cap); // 整合成功也可能超上限——同样保骨架截断
        }
        await get().updateEditor(editorId, isMain ? { memory: memory.slice(0, cap) } : { skills: { ...(cur.skills ?? {}), [mod]: memory } });
        // 吸收成功：条目保留在消息上（气泡「🧠 记忆已更新」点开可查看），置位标记防止 reload 后重复吸收
        setEntry({ done: true, count: absorbed });
      },

      checkSkillMemory: async (msgId, editorId, target, task) => {
        // 手动检验（干净子 agent）：只有职责+当前该模块技能记忆+一条任务，无对话历史/摘要——
        // 样例只展示不落库；可重复点击覆盖（status checking→sample/error）
        const mod = target as EditorModule;
        const cur = [...get().localEditors, ...get().serverEditors].find((e) => e.id === editorId);
        if (!cur) return;
        const realTask = (task ?? '').trim().slice(0, 500) || SKILL_PROBE_TASKS[mod] || '按你的技能记忆完成一项该能力的典型任务。';
        const setCheck = (patch: { status: 'checking' | 'sample' | 'error'; sample?: string; error?: string }) =>
          useEditorRoomStore.setState((s) => ({
            messages: s.messages.map((x) =>
              x.id !== msgId
                ? x
                : {
                    ...x,
                    memUpdates: (x.memUpdates ?? []).map((u) =>
                      u.target === target ? { ...u, check: { ...patch, task: realTask } } : u,
                    ),
                  },
            ),
          }));
        setCheck({ status: 'checking' });
        const engine = useEditorRoomStore.getState().settings.engine;
        const r = await genSkillCheckSample({
          editor: cur,
          module: mod,
          memory: ((cur.skills ?? {})[mod] ?? '').trim(),
          task: realTask,
          engine,
        });
        if (r.ok && r.sample) setCheck({ status: 'sample', sample: r.sample.slice(0, 2400) });
        else setCheck({ status: 'error', error: r.error ?? '生成失败' });
      },

      removeEditor: async (id) => {
        const dropId = (s: EditorialState) => ({ ...s.draft, editorIds: s.draft.editorIds.filter((x) => x !== id) });
        if (get().localEditors.some((e) => e.id === id)) {
          set((s) => ({ localEditors: s.localEditors.filter((e) => e.id !== id), draft: dropId(s) }));
          return true;
        }
        try {
          const items = toServerEditors(await snippetDelete(EDITOR_SNIPPET_PREFIX + id));
          set((s) => ({ serverEditors: items, serverError: '', draft: dropId(s) }));
          return true;
        } catch (err) {
          set({ serverError: `删除正式编辑失败：${errMsg(err)}` });
          return false;
        }
      },

      setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),

      startMeeting: async (request) => {
        const { status, draft, localEditors, serverEditors } = get();
        if (status === 'running') return;
        const text = request.trim();
        const active = [...localEditors, ...serverEditors].filter((e) => e.enabled && draft.editorIds.includes(e.id));
        if (!text) {
          set({ error: '请先输入诉求' });
          return;
        }
        if (!active.length) {
          set({ error: '请至少勾选一位已启用的编辑' });
          return;
        }

        set({ status: 'running', error: '', topic: '', turns: [], pendingRemarks: [], cancelled: false });
        const res = await runMeeting(
          {
            request: text,
            editors: active,
            materials: draft.materials,
            rounds: draft.rounds,
            engine: useEditorRoomStore.getState().settings.engine,
          },
          {
            begin: (t) => {
              const id = newId('t');
              set((s) => ({ turns: [...s.turns, { ...t, id, text: '' }] }));
              return id;
            },
            update: (id, patch) =>
              set((s) => ({
                turns: s.turns.map((x) => (x.id === id ? { ...x, ...patch } : x)),
              })),
            setTopic: (topic) => set({ topic }),
            drainRemarks: () => {
              const r = get().pendingRemarks;
              if (r.length) set({ pendingRemarks: [] });
              return r;
            },
            cancelled: () => get().cancelled,
          },
        );
        const stopped = get().cancelled;
        set({
          status: res.ok ? 'done' : stopped ? 'stopped' : 'error',
          error: res.ok || stopped ? '' : res.error || '会议失败',
          pendingRemarks: [],
          cancelled: false,
          routeChat: false,
        });
        if (res.minutes) {
          useEditorRoomStore.getState().appendMessage({
            role: 'agent',
            text: `📝 编辑会议纪要（议题：${get().topic || text}）\n\n${res.minutes.text}`,
            writes: res.minutes.writes.length ? res.minutes.writes : undefined,
          });
        }
      },

      stopMeeting: () => {
        if (get().status !== 'running') return;
        set({ cancelled: true });
        stopGeneration();
      },

      addRemark: (text) => {
        const t = text.trim();
        const { status, turns } = get();
        if (!t || status !== 'running' || turns[turns.length - 1]?.kind === 'minutes') return;
        const round = Math.max(1, turns[turns.length - 1]?.round ?? 1);
        set((s) => ({
          turns: [...s.turns, { id: newId('t'), round, kind: 'user', speakerId: 'user', name: '用户', text: t }],
          pendingRemarks: [...s.pendingRemarks, t],
        }));
      },

      clearMeeting: () => {
        if (get().status === 'running') return;
        set({ turns: [], topic: '', status: 'idle', error: '' });
      },
    }),
    {
      name: 'nc2-editorial-v1',
      version: 1,
      partialize: (s) =>
        ({ mode: s.mode, localEditors: s.localEditors, draft: s.draft, status: s.status, topic: s.topic, turns: s.turns }) as Partial<EditorialState>,
      merge: (persisted, current) => {
        // 旧版把全部编辑存在 editors 字段里，统一视为本地编辑
        const p = (persisted ?? {}) as Partial<EditorialState> & { editors?: Editor[] };
        const localSrc = p.localEditors ?? p.editors ?? current.localEditors;
        const status = p.status === 'running' ? 'stopped' : p.status ?? current.status;
        return {
          ...current,
          mode: p.mode ?? current.mode,
          localEditors: withStorage(localSrc, 'local'),
          draft: p.draft ? { ...p.draft, rounds: Math.min(8, Math.max(2, p.draft.rounds)) } : current.draft,
          status,
          topic: p.topic ?? current.topic,
          turns: p.turns ?? current.turns,
          // v2.21：旧版 responsible（各模块责编）已废弃——责编升格为作品级（studioStore.responsibleId，随作品存档）
        };
      },
    },
  ),
);
