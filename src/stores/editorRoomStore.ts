/** 🎭 编辑室会话状态（持久化 nc2-sim-agent-v1）：对话记录 + 压缩摘要 +
 *  对话设置跨关窗/刷新保留。busy/error/usage/meta 不持久化；send 流式更新末条 agent 气泡，
 *  genSimTurn 内含 agentGate 预检/页面互斥。压缩上下文复用 agentShared 的 compactAgentContext。 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { genSimTurn, type SimChatMsg } from '../engines/studioEngine';
import { genEditorTurn, type Editor, type EditorTurnResult } from '../engines/meetingEngine';
import type { ResponsibleEditor } from '../engines/studioEngine';
import { compactAgentContext } from '../shared/agentShared';
import { qwGetMeta, REASONING_EFFORTS, type QwenUsage, type ReasoningEffort } from '../shared/qwenClient';
import { stopGeneration } from '../shared/generation';

export interface EditorRoomMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  /** 思考过程文本（settings.reasoningEffort 非 off 且上游分离 reasoning_content 时有值） */
  think?: string;
  /** 结构块（回复按协议产出的人物/环境/区域规划块，气泡下方「落为节点/落为规划」按钮行） */
  blocks?: import('../engines/studioEngine').SimBlock[];
  /** 写入块（用户明确要求写入某项文本设定时产出，气泡下方「📎 写入」按钮确认后生效） */
  writes?: import('../engines/studioEngine').SimWriteBlock[];
  /** 生成过的图片标记（【生图】块按块序号 i 对应；存的是服务器临时 URL，仅兜底展示——
   *  图片本体在浏览器 IndexedDB（services/localImages.ts，key=chat:<msgId>:<i>），服务器文件 10 分钟后被 GC） */
  images?: Array<{ i: number; url: string }>;
  /** 本条 agent 回复的对话对象（与编辑部某位编辑单独对话时记录；总编辑对话无此字段） */
  editorId?: string;
  editorName?: string;
  /** ✍ 职责改进草稿（编辑按【更新职责】协议产出；用户确认后写回该编辑 persona，确认/忽略后清除） */
  personaDraft?: string;
  /** 🧠 记忆更新条目（v2.21 双通道，v2.25 出现即自动吸收）：target='main'=主记忆 / 模块名=该编辑的对应技能记忆。
   *  吸收全程确定性校验（正向表述→残留过滤→技能条目须有【何时】+【做法】），全剔=不写入；
   *  成功后置 done（气泡「🧠 记忆已更新」chip 按条展示，点开查看；reload 后据此跳过重复吸收）。
   *  check=手动「检验效果」干净生成的状态（skill 条目专属；checking 中断的条目在重水化时剥掉） */
  memUpdates?: Array<{
    target: string;
    text: string;
    count?: number;
    done?: boolean;
    check?: { task: string; status: 'checking' | 'sample' | 'error'; sample?: string; error?: string };
  }>;
  ts: number;
  /** 本轮生成引擎（public=公共模型，气泡打 🌐 标） */
  engine?: 'private' | 'public';
}

export interface EditorRoomSettings {
  /** 推理强度：off=直接答；low/medium/high=请求推理（私有轨仅区分开/关，公共轨按档位下发）；
   *  影响编辑室对话、章节大纲、编辑单独对话（其余工具调用不加推理） */
  reasoningEffort: ReasoningEffort;
  /** 上下文用量超阈值自动压缩（92%） */
  autoCompact: boolean;
  /** 聊天列宽（像素上限；full=跟随面板） */
  chatWidth: 'narrow' | 'medium' | 'wide' | 'full';
  /** 生成引擎：private=🏠 私有模型（自建/租用 GPU，默认）/ public=🌐 公共模型（SaaS 中转，手动切换） */
  engine: 'private' | 'public';
  /** 正文管理器的写手引擎（二选一）：private=🏠 私有模型（默认）/ public=🌐 公共模型 */
  contentEngine: 'private' | 'public';
  /** 📜 附带规则与目标（v2.19，默认关）：编辑室是功能与创意环境，默认不被规则/目标约束（buildSimSystem 不注入）；
   *  开启后才以【项目资料（按需参考）】块提供 全文目标/全文规则/章节大纲规则/人物生成规则——用户提到或需要统一方向时 AI 能读到 */
  carryRules: boolean;
  /** ✍ 编辑输出不设上限（默认开）：编辑单独对话补全预算 16384（实际写完为止，对话不可能触到）；关=8192 */
  editorUnlimited: boolean;
}

export interface EditorRoomUsage {
  promptTokens: number;
  completionTokens: number;
  /** 读取模型时拿到的生效上下文（llama.cpp n_ctx）；拿不到为 0 → 用量条不显示 */
  nCtx: number;
  at: number;
}

const MAX_MESSAGES = 60; // 持久化上限（超过裁最旧）
const COMPACT_KEEP = 6; // 压缩后保留最近消息条数
const AUTO_COMPACT_RATIO = 0.92;

interface EditorRoomState {
  messages: EditorRoomMessage[];
  /** 更早对话的压缩摘要（注入 system prompt，随 persist 保存） */
  summary: string;
  /** 非活动对话驻留区（key=editor.id 或 'chief'；切换对话对象时与 messages/summary 整体互换，随 persist 保存） */
  savedConvs: Record<string, { messages: EditorRoomMessage[]; summary: string }>;
  settings: EditorRoomSettings;
  /** 当前活动对话的归属键（'chief' 或编辑 id；随 messages/summary 一起持久化）。
   *  chatEditor 对象本身不持久化（职责/技能记忆以 editorialStore 为准，避免旧副本），
   *  刷新后靠 activeConvKey + 编辑名单恢复对话对象，否则会话会被误显示成总编辑的。 */
  activeConvKey: string;
  /** 对话对象（v2.19b）：null=总编辑（默认）；设置为编辑部某位编辑=与其单独对话（不持久化） */
  chatEditor: Editor | null;
  /** 🏛 作品责编技能记忆表（v2.21，纯数据不持久化）：key=生成能力模块，memory=该编辑在该模块的技能记忆；
   *  总编辑对话时按本轮话题命中注入（mentorBlocks）。由面板从 studioStore.responsibleId + editorialStore 解析后写入（store 间避免循环依赖） */
  mentorByModule: Partial<Record<string, ResponsibleEditor>>;
  busy: boolean;
  compactBusy: boolean;
  error: string;
  /** 最近一轮精确用量（不持久化） */
  usage: EditorRoomUsage | null;
  /** 模型信息（/api/qwen/meta，不持久化；null=未读到） */
  meta: { model: string; nCtx: number; nCtxTrain: number } | null;
  metaError: string;
  send: (userText: string) => Promise<void>;
  stop: () => void;
  /** 重生成最后一条 agent 回复（连同其前的用户消息一起重发） */
  regenerate: () => Promise<void>;
  clearChat: () => void;
  /** 追加一条非模型生成的消息（如会议纪要、会中插话回显） */
  appendMessage: (m: Pick<EditorRoomMessage, 'role' | 'text' | 'writes'>) => void;
  /** 切换对话对象（总编辑 / 编辑部某位编辑；传 null 回总编辑） */
  setChatEditor: (e: Editor | null) => void;
  /** 刷新后恢复：把持久化的活动会话重新绑回该编辑（不交换 messages/summary——它们本就是这份会话） */
  restoreChatEditor: (e: Editor) => void;
  /** 活动会话所属编辑已删除/停用：消息原样归档到该编辑键下，载入总编辑的上下文 */
  dropOrphanConv: () => void;
  /** 记录【生图】块的生成结果（按块序号 i；同块重生成覆盖） */
  attachImage: (msgId: string, i: number, url: string) => void;
  setSettings: (patch: Partial<EditorRoomSettings>) => void;
  deleteMessage: (id: string) => void;
  /** 读取上游模型信息（面板打开时调用一次；离线静默置 metaError） */
  loadMeta: () => Promise<void>;
  /** 压缩上下文：Qwen 生成摘要替换旧历史（保留最近 COMPACT_KEEP 条） */
  compact: () => Promise<boolean>;
  clearSummary: () => void;
}

export const useEditorRoomStore = create<EditorRoomState>()(
  persist(
    (set, get) => {
      /** 单轮流式：pushUser 传新用户消息对象（null=重生成时复用历史里的） */
      const streamTurn = async (history: EditorRoomMessage[], userText: string, pushUser: EditorRoomMessage | null) => {
        const aid = `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        set((s) => ({
          messages: [
            ...s.messages,
            ...(pushUser ? [pushUser] : []),
            { id: aid, role: 'agent' as const, text: '', ts: Date.now() },
          ].slice(-MAX_MESSAGES),
          busy: true,
          error: '',
        }));
        let lastFlush = 0;
        let lastThinkFlush = 0;
        const historyMsgs: SimChatMsg[] = history.map((m) => ({ role: m.role, text: m.text }));
        const ed = get().chatEditor; // 对话对象发起前定格（切换按钮 busy 时禁用）
        const common = {
          history: historyMsgs,
          userMsg: userText,
          reasoningEffort: get().settings.reasoningEffort,
          engine: get().settings.engine,
          onDelta: (acc: string) => {
            const now = Date.now();
            if (now - lastFlush > 400) {
              lastFlush = now;
              useEditorRoomStore.setState((s) => ({
                messages: s.messages.map((m) => (m.id === aid ? { ...m, text: acc } : m)),
              }));
            }
          },
          onThink: (acc: string) => {
            const now = Date.now();
            if (now - lastThinkFlush > 400) {
              lastThinkFlush = now;
              useEditorRoomStore.setState((s) => ({
                messages: s.messages.map((m) => (m.id === aid ? { ...m, think: acc } : m)),
              }));
            }
          },
          onUsage: (u: QwenUsage) => {
            useEditorRoomStore.setState({
              usage: { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, nCtx: get().meta?.nCtx ?? 0, at: Date.now() },
            });
          },
        };
        // 对话对象：编辑部编辑=职责系统+【更新职责】协议；总编辑=原 genSimTurn（含摘要/画布写入协议+🏛 全文协作责编）
        const r = ed
          ? await genEditorTurn({ ...common, editor: ed })
          : await genSimTurn({ ...common, summary: get().summary, mentors: get().mentorByModule });
        if (r.ok && r.chat !== undefined) {
          // 编辑单独对话与总编辑轮次的返回形状不同：blocks/writes 两形状均可选携带，personaDraft/memUpdates 仅编辑轮次有
          const uni = r as Partial<EditorTurnResult>;
          const blocks = uni.blocks;
          const writes = uni.writes;
          const personaDraft = uni.personaDraft;
          const memUpdates = uni.memUpdates;
          useEditorRoomStore.setState((s) => ({
            messages: s.messages.map((m) =>
              m.id === aid
                ? {
                    ...m,
                    text: r.chat!,
                    ts: Date.now(),
                    engine: r.engine,
                    ...(ed ? { editorId: ed.id, editorName: ed.name } : {}),
                    ...(blocks?.length ? { blocks } : { blocks: undefined }),
                    ...(writes?.length ? { writes } : { writes: undefined }),
                    ...(personaDraft ? { personaDraft } : { personaDraft: undefined }),
                    ...(memUpdates?.length ? { memUpdates } : { memUpdates: undefined }),
                  }
                : m,
            ),
            error: '',
            busy: false,
          }));
          // 自动压缩：本轮用量超阈值（nCtx 已知才判）
          const s = get();
          if (
            s.settings.autoCompact &&
            !s.compactBusy &&
            s.usage &&
            s.usage.nCtx > 0 &&
            (s.usage.promptTokens + s.usage.completionTokens) / s.usage.nCtx > AUTO_COMPACT_RATIO
          ) {
            void get().compact();
          }
        } else {
          // 中止/失败：已有部分文本则保留并标注，空泡删除
          useEditorRoomStore.setState((s) => {
            const cur = s.messages.find((m) => m.id === aid);
            return cur && cur.text.trim()
              ? {
                  messages: s.messages.map((m) => (m.id === aid ? { ...m, text: `${m.text}\n（已停止）` } : m)),
                  busy: false,
                  error: r.error || '生成失败',
                }
              : { messages: s.messages.filter((m) => m.id !== aid), busy: false, error: r.error || '生成失败' };
          });
        }
      };

      return {
        messages: [],
        summary: '',
        savedConvs: {},
        settings: { reasoningEffort: 'off', autoCompact: true, chatWidth: 'medium', engine: 'private', contentEngine: 'private', carryRules: false, editorUnlimited: true },
        activeConvKey: 'chief',
        chatEditor: null,
        mentorByModule: {},
        busy: false,
        compactBusy: false,
        error: '',
        usage: null,
        meta: null,
        metaError: '',

        send: async (userText) => {
          const text = userText.trim();
          const { busy, messages, chatEditor, activeConvKey } = get();
          // 刷新后编辑会话尚在恢复（编辑名单未就绪）：先别发，避免这条消息错发到总编辑上下文
          if (activeConvKey !== 'chief' && !chatEditor) return;
          if (!text || busy) return;
          await streamTurn(messages, text, { id: `u-${Date.now()}`, role: 'user', text, ts: Date.now() });
        },

        stop: () => stopGeneration(),

        regenerate: async () => {
          const { messages, busy, chatEditor, activeConvKey } = get();
          if (activeConvKey !== 'chief' && !chatEditor) return; // 同 send：会话尚在恢复时不重发
          if (busy) return;
          const last = messages[messages.length - 1];
          if (!last || last.role !== 'agent') return;
          let userIdx = -1;
          for (let i = messages.length - 2; i >= 0; i--) {
            if (messages[i].role === 'user') {
              userIdx = i;
              break;
            }
          }
          if (userIdx === -1) return;
          const userMsg = messages[userIdx];
          const history = messages.slice(0, userIdx);
          set({ messages: history });
          await streamTurn(history, userMsg.text, userMsg);
        },

        clearChat: () => set({ messages: [], error: '' }),

        /** 追加一条非模型生成的消息（会议纪要等）：永落总编辑对话（会议由总编辑组织，不落进编辑单独对话） */
        appendMessage: (m) =>
          set((s) => {
            const msg = { ...m, id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: Date.now() };
            if ((s.activeConvKey || s.chatEditor?.id || 'chief') === 'chief')
              return { messages: [...s.messages, msg].slice(-MAX_MESSAGES) };
            const parked = s.savedConvs.chief ?? { messages: [], summary: '' };
            return { savedConvs: { ...s.savedConvs, chief: { ...parked, messages: [...parked.messages, msg].slice(-MAX_MESSAGES) } } };
          }),

        attachImage: (msgId, i, url) =>
          set((s) => ({
            messages: s.messages.map((m) => {
              if (m.id !== msgId) return m;
              const images = (m.images ?? []).filter((x) => x.i !== i).concat({ i, url });
              return { ...m, images };
            }),
          })),

        setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

        /** 切换对话对象：现活动对话整体驻留，装载目标对象的独立上下文（各自的消息历史与摘要互不可见） */
        setChatEditor: (e) =>
          set((s) => {
            if (s.busy) return {}; // 生成中不切换（面板 select 已禁用，双保险）
            // ⚠ 用 activeConvKey：刷新后 chatEditor 尚未恢复时，不能把它误判成总编辑
            const prevKey = s.activeConvKey || s.chatEditor?.id || 'chief';
            const nextKey = e?.id ?? 'chief';
            if (prevKey === nextKey) return { chatEditor: e };
            const saved = { ...s.savedConvs, [prevKey]: { messages: s.messages, summary: s.summary } };
            const next = saved[nextKey] ?? { messages: [], summary: '' };
            delete saved[nextKey];
            return { chatEditor: e, activeConvKey: nextKey, savedConvs: saved, messages: next.messages, summary: next.summary, error: '', usage: null };
          }),

        /** 刷新恢复：只重新绑定对象，不换上下文（messages/summary 已由 persist 按 activeConvKey 载入） */
        restoreChatEditor: (e) =>
          set((s) => {
            if (s.chatEditor?.id === e.id) return { chatEditor: e };
            if (s.activeConvKey !== e.id) return {};
            return { chatEditor: e };
          }),

        /** 活动会话的编辑已被删除/停用：消息按原键归档，回到总编辑上下文（会话不丢，重新启用后可切回） */
        dropOrphanConv: () =>
          set((s) => {
            const key = s.activeConvKey;
            if (!key || key === 'chief') return {};
            const saved = { ...s.savedConvs, [key]: { messages: s.messages, summary: s.summary } };
            const chief = saved.chief ?? { messages: [], summary: '' };
            delete saved.chief;
            return { savedConvs: saved, activeConvKey: 'chief', chatEditor: null, messages: chief.messages, summary: chief.summary, error: '', usage: null };
          }),

        deleteMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),

        loadMeta: async () => {
          if (get().meta) return; // 已读到就不再请求
          set({ metaError: '' });
          try {
            const m = await qwGetMeta();
            if (m.ok && m.model) {
              // 模型路径只取文件名展示
              const short = m.model.split(/[\\/]/).pop() || m.model;
              set({ meta: { model: short.replace(/\.gguf$/i, ''), nCtx: m.n_ctx ?? 0, nCtxTrain: m.n_ctx_train ?? 0 } });
            } else {
              set({ metaError: m.error || '未能读取模型信息' });
            }
          } catch (e) {
            set({ metaError: (e as Error).message });
          }
        },

        compact: async () => {
          const { busy, compactBusy, messages, summary } = get();
          if (busy || compactBusy || messages.length < 4) return false;
          set({ compactBusy: true, error: '' });
          const r = await compactAgentContext({
            history: messages.map((m) => ({ role: m.role, text: m.text })),
            prevSummary: summary,
            engine: get().settings.engine,
          });
          if (r.ok && r.summary) {
            set((s) => ({ summary: r.summary!, messages: s.messages.slice(-COMPACT_KEEP), compactBusy: false }));
            return true;
          }
          set({ compactBusy: false, error: r.error || '压缩失败' });
          return false;
        },

        clearSummary: () => set({ summary: '' }),
      };
    },
    {
      name: 'nc2-sim-agent-v1',
      version: 1,
      partialize: (s) =>
        ({ messages: s.messages, summary: s.summary, savedConvs: s.savedConvs, settings: s.settings, activeConvKey: s.activeConvKey }) as Partial<EditorRoomState>,
      // settings 深合并：旧存档缺新字段时补默认值，而不是整对象覆盖
      merge: (persisted, current) => {
        const p = persisted as Partial<EditorRoomState>;
        // v2.21 迁移：旧单块 memoryDraft/memoryDone/memoryCount → memUpdates[{target:'main'}]，
        // 并剥掉旧键（persist 会把 merge 结果写回，残留键将永久留在存档里）
        // 旧档 messages/summary 为全屋共享历史：载入即总编辑的活动对话；savedConvs 旧档无此键，由 ...current 兜底 {}
        const messages = (p.messages ?? []).map((m) => {
          const { memoryDraft, memoryDone, memoryCount, ...rest } = m as EditorRoomMessage & {
            memoryDraft?: string;
            memoryDone?: boolean;
            memoryCount?: number;
          };
          if (memoryDraft)
            return { ...rest, memUpdates: [...(rest.memUpdates ?? []), { target: 'main', text: memoryDraft, count: memoryCount, done: memoryDone }] };
          return rest;
        });
        const settings = { ...current.settings, ...(p.settings ?? {}) };
        // 引擎命名迁移（v2.23：primary/qwen→private、fallback→public；旧 S-AI('sa') 已死归 private）——
        // persist 会把 merge 结果写回，残留旧值不会永久留在存档里
        const eng = settings.engine as string;
        if (eng === 'primary' || eng === 'qwen') settings.engine = 'private';
        else if (eng === 'fallback') settings.engine = 'public';
        const ceng = settings.contentEngine as string;
        if (ceng === 'qwen' || ceng === 'sa') settings.contentEngine = 'private';
        else if (ceng === 'fallback') settings.contentEngine = 'public';
        // 推理迁移（v2.27：布尔 thinking → 四档 reasoningEffort；旧键必须剥掉，否则永久留在存档里）。
        // 注意看「旧档里有没有」而不是合并后的值——合并会先补上默认 'off'，会被误判成用户已选关闭
        const legacy = settings as EditorRoomSettings & { thinking?: boolean };
        const oldEffort = (p.settings as Partial<EditorRoomSettings> | undefined)?.reasoningEffort;
        if (typeof legacy.thinking === 'boolean') {
          if (!REASONING_EFFORTS.includes(oldEffort as ReasoningEffort)) {
            settings.reasoningEffort = legacy.thinking ? 'medium' : 'off';
          }
          delete legacy.thinking;
        }
        if (!REASONING_EFFORTS.includes(settings.reasoningEffort)) settings.reasoningEffort = 'off';
        // 活动会话归属：新档直接读 activeConvKey；旧档（该键不存在）从消息里的 editorId 推断——
        // 修复「单独对话刷新后被当成总编辑」的旧存档：messages 是那位编辑的会话，savedConvs.chief 才是总编辑的
        const inferredConvKey =
          (typeof p.activeConvKey === 'string' && p.activeConvKey) ||
          [...messages].reverse().find((m) => m.role === 'agent' && m.editorId)?.editorId ||
          'chief';
        // 旧版刷新 bug 的残留：单独对话曾被误存进 chief 槽（总编辑的消息绝不会带 editorId）。
        // 按其中最后一条带 editorId 的 agent 消息认回原编辑；同键已有旧会话时保留时间更新的那份。
        const savedConvs = { ...(p.savedConvs ?? {}) };
        const misParked = savedConvs.chief;
        const misOwner = misParked
          ? [...misParked.messages].reverse().find((m) => m.role === 'agent' && m.editorId)?.editorId
          : undefined;
        if (misOwner && misOwner !== 'chief') {
          const latest = (ms: EditorRoomMessage[]) => ms.reduce((t, m) => Math.max(t, m.ts || 0), 0);
          const existing = savedConvs[misOwner];
          if (!existing || latest(misParked!.messages) >= latest(existing.messages)) savedConvs[misOwner] = misParked!;
          delete savedConvs.chief;
        }
        return {
          ...current,
          ...p,
          activeConvKey: inferredConvKey,
          savedConvs,
          messages: messages.map((m) =>
            (m.engine as string) === 'primary'
              ? { ...m, engine: 'private' as const }
              : (m.engine as string) === 'fallback'
                ? { ...m, engine: 'public' as const }
                : m,
          ).map((m) =>
            // v2.25 迁移：中断的「检验效果」（checking 转圈）不该在 reload 后残留——剥掉其 check
            m.memUpdates?.some((u) => u.check?.status === 'checking')
              ? { ...m, memUpdates: m.memUpdates.map((u) => (u.check?.status === 'checking' ? { ...u, check: undefined } : u)) }
              : m,
          ),
          settings,
        };
      },
    },
  ),
);
