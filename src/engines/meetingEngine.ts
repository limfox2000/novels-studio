/** 🪑 编辑会议引擎：总编辑确定议题并指定参会编辑 → 被指定的编辑表态 → 总编辑整合 → 仅有意见的编辑进入下一轮，
 *  直到无人有意见或达到最多轮数 → 总编辑产出会议纪要（可含可直接写入的【写入】草稿，点击确认后才生效）。
 *  共用全局生成互斥（uiStore.generating）与 Qwen 预检；每次发言单独 startGeneration，
 *  停止时由调用方置 cancelled 并中止当前请求。纪要不自动写入项目。 */
import { qwGenerate, REASONING_EFFORT_MAX_TOKENS, type QwenChatMessage, type QwenUsage, type ReasoningEffort } from '../shared/qwenClient';
import { GenerationAborted } from '../shared/generation';
import { agentGate, promptCharBudget } from '../shared/agentShared';
import { buildMaterialBlock, buildReadBlock, parseSimOutput, chaptersBlock, EDITOR_MODULE_CAPS, WRITE_TARGETS, matchMentorModules, type MaterialKey, type SimChatMsg, type SimBlock, type SimWriteBlock, type WriteField } from './studioEngine';
import { sanitizeMemoryEntries, TEMPLATE_CRAFT_SECTIONS } from './memoryTemplates';
import { useUiStore } from '../stores/uiStore';
import { useEditorRoomStore } from '../stores/editorRoomStore';
import { startGeneration } from '../shared/generation';

// 🧠 记忆条目行级清洗原语收拢在 memoryTemplates（模板副本模式的底层），此处转发保持既有导入路径
export { sanitizeMemoryEntries, filterChatResidue } from './memoryTemplates';

/** local 存浏览器 localStorage；server 存服务器 meeting_editors.json（跨设备） */
export type EditorStorage = 'local' | 'server';

/** 🏛 生成能力模块（v2.20）：与系统真实生成功能一一对应。v2.21 起每位编辑都是「作家编辑」——
 *  拥有全部模块的执行/写入通道（与总编辑同）；模块名现用于技能记忆分槽与责编注入，不再限定编辑的专业。 */
export const EDITOR_MODULES = ['全文目标', '全文规则', '人物生成', '环境生成', '章节大纲规则', '章节需求', '卷生成', '正文生成'] as const;
export type EditorModule = (typeof EDITOR_MODULES)[number];
export const EDITOR_MODULE_DESC: Record<EditorModule, string> = {
  全文目标: '整部小说的统一方向（写入全文目标）',
  全文规则: '世界法则与写作文风（写入全文规则）',
  人物生成: '随机/批量生成人物（人物设定块），维护人物生成规则',
  环境生成: '环境/建筑节点设计（环境设定块落画布）',
  章节大纲规则: '大纲结构与写法；直接改写某章大纲',
  章节需求: '逐章需求：本章要发生什么（驱动大纲生成）',
  卷生成: '分卷与卷介绍（卷设定块，统一整卷方向）',
  正文生成: '按大纲展开正文（作为责编执笔正文写手）',
};

export interface Editor {
  id: string;
  name: string;
  /** 擅长题材（v2.22 描述式文本，如「善于科幻题材」「善于描写爱情故事」；''=不限题材。
   *  只标注该编辑擅长的内容领域，不限定可执行范围——v2.21 起全模块可写） */
  specialty: string;
  /** 职责与风格（简短要求，必须遵守） */
  persona: string;
  /** 🧠 主记忆（v2.21 轻量化）：协作方式与通用偏好（每条一行，随对话沉淀；常驻注入，上限 MAIN_MEMORY_CAP 字） */
  memory?: string;
  /** 🧠 技能记忆（模板副本模式）：每个生成能力一份记忆文件副本——编辑创建时从 skills/editor-memory/
   *  模板整套复制（固定契约 + 出厂基线，未调教即可独立产出），调教经验按小节归类追加在基线之下；
   *  编辑执行某能力任务时整份注入（上限 SKILL_MEMORY_CAP 字/项，保骨架截断） */
  skills?: Partial<Record<EditorModule, string>>;
  enabled: boolean;
  storage: EditorStorage;
}

/** 记忆双层上限：主记忆常驻注入要轻，技能记忆按需注入可厚。超 OPTIMIZE_AT 触发 AI 优化（合并精简回 TARGET）；
 *  TARGET 低于 AT 留出余量——避免优化完立刻又超阈值、每次吸收都触发重写。
 *  技能记忆是模板副本（骨架约 700-900 字不可压缩），三项都要在骨架之上留出调教沉淀空间。 */
export const MAIN_MEMORY_CAP = 1200;
export const MAIN_MEMORY_OPTIMIZE_AT = 1000;
export const MAIN_MEMORY_OPTIMIZE_TARGET = 700;
export const SKILL_MEMORY_CAP = 3000;
export const SKILL_MEMORY_OPTIMIZE_AT = 2600;
export const SKILL_MEMORY_OPTIMIZE_TARGET = 2000;

/** 🧠 记忆更新总规则（记忆更新器专用，integrate/optimize 共用这一份）：记忆模板文件里不写规则——
 *  记忆文件只留骨架与用途说明，保持干净；模板副本模式的归类/骨架约束由 memoryTemplates 的确定性校验兜底。 */
export const MEMORY_UPDATE_RULES = `【总规则】
- 细节（数字、示例、限制条件）保留原样，不抽象化；
- 【正向表述】每条一律直接写「怎么做」，不以「不/不要/禁止/避免」等否定词开头——否定式开头的条目先改写成正向做法（改写后保留），改不成的直接删除；
- 【脱离对话】条目必须脱离对话可读：不出现「刚才/上一条/前面提到」等对话指称，不写客套话，不写只对某次对话成立的一次性参数；
- 拿不准归属或提炼不到可执行粒度的条目宁可不记。`;

/** 对话记忆协议用的小节速查：各模块可归类的小节（模板即真相，模板改了这里自动跟） */
const MEMORY_SECTION_GUIDE = EDITOR_MODULES.map((m) => `${m}：${TEMPLATE_CRAFT_SECTIONS[m].join(' / ')}`).join('\n');

/** 🧪 技能记忆标准检验任务（手动「检验效果」无明确指令时的兜底）：每模块一个可直接考核的样例任务，
 *  任务口径对齐各模块记忆模板的产出结构，让检验真正考核「骨架+基线+调教」的整体效果 */
export const SKILL_PROBE_TASKS: Record<EditorModule, string> = {
  全文目标: '为本项目拟一份全文目标：题材、主线、爽点预期三部分，各一小段。',
  全文规则: '为本项目拟全文规则：世界观规则与写作文风两部分，每条一行、写成可检验的陈述。',
  人物生成: '生成一个配角人物：基础属性（人名/性别/年龄）、基础信息（长相/身材/习惯穿搭/性格）、身份信息（职业/身份/与故事相关的特殊设计），样子与身份都要立体，人物与主线有勾连。',
  环境生成: '写一处环境设定：名字、类型，描述按外观、功能、氛围落笔，要能承载一场冲突戏。',
  章节大纲规则: '为一章「主角初次尝试失败」拟章节大纲：一句话概要、情境、事件链、结束状态、钩子。',
  章节需求: '为下一章拟章节需求：主线推进、核心事件与人物、期待感各点到为止，120 字以内。',
  卷生成: '为本项目拟第二卷的卷设定：卷名与一段卷介绍（主线推进、核心事件与人物、期待感各点到为止）。',
  正文生成: '写一段 300 字正文：雨夜，主角第一次推开宗门大门；细节落到感官。',
};

export interface MeetingTurn {
  id: string;
  round: number;
  kind: 'intake' | 'editor' | 'host' | 'user' | 'minutes';
  speakerId: string;
  name: string;
  text: string;
  /** 编辑表态为无意见时为 true */
  noOpinion?: boolean;
  /** 纪要中的写入草稿（点击确认后才写入项目） */
  writes?: SimWriteBlock[];
}

export interface MeetingSetup {
  /** 用户原始诉求，由总编辑理解后确定议题 */
  request: string;
  /** 已启用且被勾选的编辑，按发言顺序 */
  editors: Editor[];
  materials: MaterialKey[];
  /** 最多轮数（含第一轮） */
  rounds: number;
  engine: 'private' | 'public';
}

export interface MeetingIO {
  begin: (t: Omit<MeetingTurn, 'id' | 'text'>) => string;
  update: (id: string, patch: Partial<Pick<MeetingTurn, 'text' | 'noOpinion' | 'writes'>>) => void;
  setTopic: (topic: string) => void;
  /** 取出自上次以来用户插话的文本（每位编辑发言前、纪要前调用） */
  drainRemarks: () => string[];
  cancelled: () => boolean;
}

export interface MeetingResult {
  ok: boolean;
  error?: string;
  minutes?: { text: string; writes: SimWriteBlock[] };
}

const CHIEF = '总编辑';
const MATERIAL_CAP = 4000;
const TRANSCRIPT_CAP = 6000;
const UPDATE_MS = 300;

const EDITOR_RULES = `【输出规则】
- 第一行必须是「■ 意见：有」或「■ 意见：无」
- 自行判断：你对这个议题是否有自己角度的具体观点或补充？没有就第一行写「■ 意见：无」，之后不再输出任何内容
- 不要为了显得参与而表态；泛泛附和、重复他人观点、只换个说法，都算无意见
- 若有意见，第一行写「■ 意见：有」，然后只从你的专业角度发言：指出具体问题，并给出可执行的改进建议；不超过 300 字
- 回应前面的发言时点名对方（如「同意总编辑的…」「对前面某位编辑的观点，我认为…」）
- 不要替其他编辑代言，不要输出【】协议块，不要改写成正文
- 直接输出，不要寒暄`;

const INTAKE_SYSTEM = `你是小说创作团队的总编辑，负责主持编辑会议。用户向编辑部提出了一个诉求（可能比较笼统）。请先理解诉求，确定本次会议议题，并给出你的初始意见。
输出格式（严格段名一字不差，按此顺序）：
■ 议题：一句话概括本次会议要讨论的核心问题，并说明讨论范围
■ 理解：用 2-4 句说明你如何理解这个诉求
■ 初始意见：你对议题的初步判断，以及希望各位编辑重点审视的问题（不超过 200 字）
不要寒暄。参会编辑都会自行判断是否有自己角度的观点：没有观点的会主动退出后续讨论，你无需指派谁发言。`;

const HOST_SYSTEM = `你是总编辑，主持本次编辑会议。每轮结束后整合本轮各编辑的意见，给出本轮结果：指出共识、分歧与仍待解决的问题；说明哪些编辑已无意见、退出后续讨论。不替编辑发表专业意见，语言简洁，不超过 300 字。
输出格式：
## 本轮结果
- 共识：
- 分歧：
- 待解决：`;

const MINUTES_SYSTEM = `你是总编辑，负责根据完整会议记录输出会议纪要。严格使用以下段名（一字不差）：
■ 议题
■ 共识
■ 分歧
■ 建议的架构调整：每条写明改动的对象与具体内容（改哪个字段、改成什么、为什么），按优先级排列
■ 待用户决定
不超过 800 字。

如果会议已形成可直接成文的结论（全文目标、全文规则、章节大纲规则、人物生成规则之一），在纪要最末为每项输出一个写入块（段名一字不差）：
【写入】
目标：（全文目标 / 全文规则 / 章节大纲规则 / 人物生成规则 四选一，一字不差）
内容：
（写入后该字段的完整正文；若该字段已有内容，须在其基础上吸收会议结论、保留仍然有效的部分。超上限请精简：全文目标≤500字、全文规则≤3000字、章节大纲规则≤2000字、人物生成规则≤1000字）
没有可成文的结论则不输出写入块。纪要与写入草稿都不会自动生效，需用户点击确认。`;

function editorSystem(e: Editor, topic: string): string {
  const mem = (e.memory ?? '').trim();
  // 议题命中模块 → 只带该模块的技能记忆（会议发言轻量，截 1500 防膨胀）
  const focus = matchMentorModules(topic, 1)[0];
  const skillMem = focus ? ((e.skills ?? {})[focus as EditorModule] ?? '').trim().slice(0, 1500) : '';
  return `你是小说创作团队的编辑「${e.name}」（擅长题材：${e.specialty || '不限'}），正在参加一场编辑会议，总编辑主持。
【你的审视维度与风格】
${e.persona.trim() || '（未设置，就议题从自己角度发言）'}${mem ? `\n【你的主记忆】（协作方式与通用偏好，发言时遵循）\n${mem.slice(0, MAIN_MEMORY_CAP)}` : ''}${skillMem ? `\n【你的技能记忆：${focus}】（该能力的技法，与议题相关时遵循）\n${skillMem}` : ''}

${EDITOR_RULES}`;
}

interface Line {
  name: string;
  text: string;
}

const OPINION_RE = /■\s*意见[：:]\s*(有|无)/;

/** 解析编辑表态：返回去掉表态行后的正文，以及是否无意见（未写表态行按有意见处理） */
function parseOpinion(raw: string): { body: string; noOpinion: boolean } {
  const m = raw.match(OPINION_RE);
  if (!m) return { body: raw.trim(), noOpinion: false };
  return { body: raw.replace(m[0], '').trim(), noOpinion: m[1] === '无' };
}

/** 超长时保留尾部：最近的发言最重要 */
function tail(s: string, max: number): string {
  return s.length > max ? `…${s.slice(s.length - max)}` : s;
}

function meetingContext(setup: MeetingSetup, topic: string, lines: Line[]): string {
  const materials = setup.materials.length ? buildMaterialBlock(setup.materials).slice(0, MATERIAL_CAP) : '';
  const record = lines.length ? tail(lines.map((l) => `【${l.name}】${l.text}`).join('\n'), TRANSCRIPT_CAP) : '（会议刚开始）';
  return [
    `【用户诉求】${setup.request}`,
    `【议题】${topic}`,
    materials ? `【项目资料】（会议参考，分析时对照）\n${materials}` : '',
    `【会议记录】\n${record}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function parseIntake(reply: string, fallbackTopic: string): { topic: string; opinion: string } {
  const m = reply.match(/■\s*议题[：:]?\s*\n?\s*([^\n]+)/);
  const topic = (m ? m[1].replace(/^[\s\-*]+|[\s*]+$/g, '').trim() : '') || fallbackTopic;
  const opinion = reply.split(/■\s*初始意见[：:]?/)[1]?.trim() || reply.trim();
  return { topic, opinion };
}

export async function runMeeting(setup: MeetingSetup, io: MeetingIO): Promise<MeetingResult> {
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  ui.setGenerating(true);
  try {
    const gate = await agentGate(setup.engine);
    if (gate) return { ok: false, error: gate };

    const lines: Line[] = [];
    const call = async (id: string, system: string, user: string): Promise<string> => {
      if (io.cancelled()) throw new GenerationAborted();
      const signal = startGeneration();
      let last = 0;
      const msgs: QwenChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      const text = await qwGenerate({
        messages: msgs,
        maxTokens: 2048,
        temperature: 0.7,
        engine: setup.engine,
        signal,
        onDelta: (acc) => {
          const now = Date.now();
          if (now - last > UPDATE_MS) {
            last = now;
            io.update(id, { text: parseOpinion(acc).body });
          }
        },
      });
      return text.trim();
    };
    const takeRemarks = () => {
      for (const t of io.drainRemarks()) lines.push({ name: '用户', text: t });
    };

    const intakeId = io.begin({ round: 0, kind: 'intake', speakerId: 'chief', name: CHIEF });
    const roster = setup.editors.map((e) => `${e.name}（擅长：${e.specialty || '不限'}）`).join('、');
    const intakeReply = await call(
      intakeId,
      INTAKE_SYSTEM,
      `${meetingContext(setup, '（待总编辑确定）', [])}\n【参会编辑】${roster}\n\n请确定本次会议议题并给出初始意见。`,
    );
    const { topic, opinion } = parseIntake(intakeReply, setup.request);
    io.update(intakeId, { text: intakeReply });
    io.setTopic(topic);
    lines.push({ name: CHIEF, text: `初始意见：${opinion}` });

    // v2.21：全员参与，各编辑自行判断是否有自己角度的观点（无则「■ 意见：无」退出后续轮次）
    let active = setup.editors;
    for (let r = 1; r <= setup.rounds && active.length; r++) {
      const said: Editor[] = [];
      const silent: Editor[] = [];
      for (const e of active) {
        takeRemarks();
        const id = io.begin({ round: r, kind: 'editor', speakerId: e.id, name: e.name });
        const raw = await call(id, editorSystem(e, topic), `${meetingContext(setup, topic, lines)}\n\n轮到你（第 ${r} 轮）表态并发言。`);
        const { body, noOpinion } = parseOpinion(raw);
        const shown = noOpinion ? body || '无意见' : body || '（未输出内容）';
        io.update(id, { text: shown, noOpinion });
        lines.push({ name: e.name, text: noOpinion ? '（无意见）' : shown });
        (noOpinion ? silent : said).push(e);
      }

      const hid = io.begin({ round: r, kind: 'host', speakerId: 'chief', name: CHIEF });
      const names = (list: Editor[]) => list.map((e) => e.name).join('、') || '无';
      const summary = await call(
        hid,
        HOST_SYSTEM,
        `${meetingContext(setup, topic, lines)}\n\n【本轮有意见】${names(said)}\n【本轮无意见（退出后续讨论）】${names(silent)}\n\n请整合第 ${r} 轮意见，给出本轮结果。`,
      );
      io.update(hid, { text: summary });
      lines.push({ name: CHIEF, text: summary });
      active = said;
    }

    takeRemarks();
    const ending = active.length ? '已达到最多轮数' : '所有编辑均无新意见';
    const mid = io.begin({ round: setup.rounds, kind: 'minutes', speakerId: 'minutes', name: '会议纪要' });
    const raw = await call(mid, MINUTES_SYSTEM, `${meetingContext(setup, topic, lines)}\n\n会议结束原因：${ending}。请输出会议纪要。`);
    const parsed = parseSimOutput(raw);
    io.update(mid, { text: parsed.chat, writes: parsed.writes });
    return { ok: true, minutes: { text: parsed.chat, writes: parsed.writes } };
  } catch (e) {
    if (e instanceof GenerationAborted) return { ok: false, error: '已停止' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    useUiStore.getState().setGenerating(false);
  }
}

// ── 🧑‍💼 编辑单独对话（v2.19b）：与某位编辑一对一交流（非会议），按其职责提供专业帮助；
//  对话中可按【更新职责】协议产出职责改进草稿（用户确认后写回 persona）；
//  【更新记忆】由 editorialStore.absorbMemoryDraft 自动吸收（气泡显示「🧠 记忆已更新」条数，点开可查看）──

const CHAT_MATERIAL_CAP = 4000;

/** 🏛 执行协议（v2.21 作家编辑）：所有编辑都拥有全部模块的执行通道（与总编辑同），按用户要求输出对应协议块，
 *  用户点击确认后才落地生效。正文生成无聊天通道（其职责与技能记忆在正文生成时作为责编注入）。 */
function editorExecProtocol(): string {
  const writeFields = [...new Set(Object.values(EDITOR_MODULE_CAPS).flatMap((c) => c.writeFields))] as WriteField[];
  const chaptered = writeFields.filter((f) => f === 'chapterRequirement' || f === 'chapterOutline');
  const chLabel = chaptered.map((f) => WRITE_TARGETS[f].label).join('/');
  const lines: string[] = [
    `用户要求生成/设计人物时，输出【人物设定】块（段名一字不差；要几个就输出几个）：
【人物设定】
名字：（人名，12 字以内）
性别：（男/女 二选一）
年龄：（必填，数字年龄，不可省略）
基础信息：（长相/身材/习惯穿搭/性格，一段话）
身份信息：（职业/身份/与故事相关的特殊设计，一段话）
- 不要输出关系信息段；用户点「📎 落为人物」落到画布`,
    `用户要求生成/设计环境、建筑、房间时，输出【环境设定】块（段名一字不差；要几个就输出几个）：
【环境设定】
名字：（环境名，16 字以内）
类型：（房间/建筑/社区/城镇/区域/床/物品 七选一；床=容纳人物休息睡觉的容器，物品=非容器的物件标记）
描述：（外观/功能/氛围，一段话）
- 用户点「📎 落为环境」落到画布；镇＞建筑＞房间的嵌套由用户在画布拖拽完成，需要时在块外用一句话建议「谁放进谁里面」`,
    `用户要求分卷/创建卷时，每一卷输出一个段名【卷设定】块（一字不差；要几卷就在同一次回复全部输出，按卷序排列）：
【卷设定】
名字：（卷名，20 字以内，如「第一卷 初入宗门」）
介绍：（这一卷讲什么、主线推进到哪里、要达成的阶段目标，一段话 300 字以内）
- 卷是多章节的大方向，不是单章大纲：只写整卷的方向与目标；用户点「📎 落为卷」新建该卷`,
    `用户要求制定/修改以下内容时，输出【写入】块（段名一字不差${chaptered.length ? `；${chLabel} 每章一个块` : ''}）：
【写入】
目标：（${writeFields.map((f) => WRITE_TARGETS[f].label).join(' / ')}，一字不差）${chaptered.length ? `\n章节：（目标为 ${chLabel} 时必填：《章节名》，与【章节】列表一字不差）` : ''}
内容：
（写入后该字段的完整正文；已有内容须在其基础上吸收、保留仍有效的部分；${writeFields.map((f) => `${WRITE_TARGETS[f].label}≤${WRITE_TARGETS[f].cap}字`).join('、')}）`,
  ];
  return `【执行协议】你是作家编辑：所有生成能力都可执行（输出协议块，用户点击按钮确认后才落地生效）：
${lines.join('\n\n')}
- 正文生成：聊天里不直接产出正文——你的职责与技能记忆会在 📝 正文管理器生成时作为责编注入把关；对话中提供专业分析、示范与修改建议即可`;
}

function editorChatSystem(e: Editor, userMsg: string): string {
  // 画布舞台常驻（编辑分析的工作对象）；全文目标/全文规则等资料不默认注入——
  // 仅本轮消息提到时按需附上（buildReadBlock，与总编辑对话同一套触发词）；用户没要求读就不给
  const materials = buildMaterialBlock(['canvas']).slice(0, CHAT_MATERIAL_CAP);
  const readBlock = buildReadBlock(userMsg);
  const mem = (e.memory ?? '').trim();
  // 🧠 话题锚定：命中模块 → 标注本轮聚焦能力 + 只加载该模块的技能记忆（执行哪个能力带哪份记忆）
  const focus = matchMentorModules(userMsg, 1)[0];
  const skillMem = focus ? ((e.skills ?? {})[focus as EditorModule] ?? '').trim() : '';
  const focusLine = focus ? `\n【本轮聚焦能力】${focus}（与该能力做法直接相关的调教按它归属；其它模块的任务也照常执行）` : '';
  const skillBlock = skillMem ? `\n\n【你的技能记忆：${focus}】（该能力的工作技法与调教经验，执行时逐条遵循）\n${skillMem}` : '';
  // 话题命中章节类能力时附上章节列表（标题一字不差才写得到章）
  const chapters = focus === '章节大纲规则' || focus === '章节需求' ? `\n【章节】（写 章节需求 / 本章大纲 时，章节名从这里取，一字不差）\n${chaptersBlock().slice(0, 2500)}` : '';
  return `你是小说创作团队的编辑「${e.name}」（擅长题材：${e.specialty || '不限'}），现在与创作者（用户）单独交流，不在会议里。
按你的职责与审视维度提供专业帮助：分析、给建议、按用户要求示范或改写；发言只从你的专业角度出发，其他领域点到即止。
【你的职责】（简短要求，必须遵守）
${e.persona.trim() || '（未设置，按擅长题材交流）'}

【你的主记忆】（协作方式与通用偏好，常驻遵循；与职责冲突时以职责为准）
${mem || '（暂无主记忆——用户认可的做法与要求会随对话积累到这里）'}${skillBlock}

【项目资料】（画布舞台常驻；全文目标/规则等仅在你说到时随本轮附上，按需参考，不要整段复读）
${materials}${readBlock}${chapters}${focusLine}

【职责改进协议】当用户对「你的职责/审视维度/工作方式」提出调整意见，或讨论中形成了对你职责的改进共识时，在回复最末输出（块前不要写「现在补上：」之类的引入语，正文说完直接输出块）：
【更新职责】
（更新后的完整职责文本：把改进点融入原职责，保留仍有效的部分，一段话 300 字以内）
- 只在职责确实要更新时输出；普通的示范/分析/讨论不要输出
- 草稿须经用户确认才生效，确认前你的职责不变

【记忆协议】当用户表达了对工作方式或某个能力的调教要求、经验教训（如「描写要落到感官细节」「示范要短」），或你们形成了值得长期记住的有效做法，在回复最末按归属输出（可多块；块前不要写「现在补上：」等引入语，正文说完直接输出块）：
【更新记忆】
（主记忆：协作方式与通用偏好——汇报格式、示范长短、称呼习惯这类；拿不准归属的条目也写这里）
【更新记忆：（模块名）】
（技能记忆：与该模块做法直接相关的调教经验；模块名从 全文目标/全文规则/人物生成/环境生成/章节大纲规则/章节需求/卷生成/正文生成 中选一，主题不符的不要硬塞）
- 技能条目按该模块记忆模板的小节归类，不写小节或归错小节会被系统拒收：先一行「## 小节名」，其下每条一行「- 」列条目，可连续写多个小节。小节名只能用下列（固定契约小节不收条目）：
${MEMORY_SECTION_GUIDE}
例：
【更新记忆：人物生成】
## 基础信息
- 在这个科幻世界里，18 岁的女性皮肤呈蓝色、50 岁的男性会长出犄角
- 每条一行以「- 」开头，写具体可执行的做法，不写空话；一次最多 5 条、单块总长不超过 600 字
- 条目必须脱离对话可读：不出现「刚才/上一条/前面提到」等对话指称，不写客套话，不写只对本次对话成立的一次性参数（如「这次写 3000 字」）
- 已有记忆由系统自动合并去重，不要重复抄写旧条目、不要输出全部记忆
- 每条必须正向表述：直接写「怎么做」（以动词或做法开头）；不允许以「不」「不要」「禁止」「避免」等否定词开头——否定式开头说明这条经验还没提炼到可操作的粒度，宁可先不写入
- 只在确有新东西要记时输出；普通讨论/示范不要输出
- 记忆由系统自动记录，不展示给用户；不要在正文里提及记忆或【更新记忆】

${editorExecProtocol()}

【输出规则】直接输出不寒暄。`;
}

export interface EditorTurnResult {
  ok: boolean;
  error?: string;
  chat?: string;
  engine?: 'private' | 'public';
  /** 🏛 作家编辑可执行的设定块（人物/环境/卷，全模块放行；用户点击后才落地） */
  blocks?: SimBlock[];
  /** 🏛 作家编辑可执行的写入块（全模块放行；用户点击确认后才写入） */
  writes?: SimWriteBlock[];
  /** 【更新职责】草稿（用户确认后写回编辑 persona；未输出为 undefined） */
  personaDraft?: string;
  /** 🧠 记忆更新（按归属分组）：target='main'=主记忆，其余=技能记忆模块名；absorbMemoryDraft 按目标吸收 */
  memUpdates?: Array<{ target: string; text: string }>;
}

/** 与单个编辑流式对话一轮：互斥/预检/停止/失控保险与 genSimTurn 一致；
 *  不注入总编辑的对话摘要（各编辑对话共用时间线，超长时从最旧历史开始丢）。 */
export async function genEditorTurn(opts: {
  editor: Editor;
  history: SimChatMsg[];
  userMsg: string;
  /** 推理强度（off=直接答；越高补全预算越大） */
  reasoningEffort?: ReasoningEffort;
  engine?: 'private' | 'public';
  onDelta?: (acc: string) => void;
  onThink?: (acc: string) => void;
  onUsage?: (u: QwenUsage) => void;
}): Promise<EditorTurnResult> {
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  const engine = opts.engine ?? 'private';
  const gate = await agentGate(engine);
  if (gate) return { ok: false, error: gate };
  const msgs: QwenChatMessage[] = [
    { role: 'system', content: editorChatSystem(opts.editor, opts.userMsg) },
    ...opts.history.map((m) => ({ role: m.role === 'agent' ? ('assistant' as const) : ('user' as const), content: m.text })),
    { role: 'user', content: opts.userMsg },
  ];
  // 失控保险：总长超预算从最旧历史开始丢（保留 system 与本轮消息）；预算按模型 nCtx 动态预留补全空间。
  // 补全预算：⚙「✍ 编辑输出不设上限」开（默认）=16384（实际写完为止，对话不可能触到）；关=8192。
  // 用户让「整理记忆」时模型可能重抄全部记忆（协议只约束新增也拦不住），8192 以下会中途截断。
  // 推理档位不压低该预算：思考 token 计入 max_tokens，取两者较大值
  const unlimited = useEditorRoomStore.getState().settings.editorUnlimited;
  const maxTokens = Math.max(
    unlimited ? 16384 : 8192,
    REASONING_EFFORT_MAX_TOKENS[opts.reasoningEffort ?? 'off'],
  );
  const budget = promptCharBudget(useEditorRoomStore.getState().meta?.nCtx ?? 0, maxTokens);
  let total = msgs.reduce((a, m) => a + m.content.length, 0);
  while (total > budget && msgs.length > 2) {
    total -= msgs[1].content.length;
    msgs.splice(1, 1);
  }
  ui.setGenerating(true);
  const signal = startGeneration();
  try {
    const text = await qwGenerate({
      messages: msgs,
      maxTokens,
      temperature: 0.8,
      reasoningEffort: opts.reasoningEffort,
      engine,
      signal,
      onDelta: opts.onDelta,
      onThinkDelta: opts.onThink,
      onUsage: opts.onUsage,
    });
    const parsed = parseSimOutput(text);
    let chat = parsed.chat;
    const dutyM = chat.match(/【更新职责】\n?([\s\S]*?)(?=\n【|$)/);
    // 🧠 技能分流：【更新记忆：模块名】= 技能记忆（可多块）；【更新记忆】= 主记忆（协作方式/拿不准的）。
    // 模块名不在八项之内的按主记忆收（宁可进主记忆也不丢调教）
    const memUpdates: Array<{ target: string; text: string }> = [];
    for (const m of [...chat.matchAll(/【更新记忆[：:]\s*([^】\n]+)】\n?([\s\S]*?)(?=\n【|$)/g)]) {
      const body = m[2].trim();
      if (!body) continue;
      const name = m[1].trim();
      memUpdates.push({ target: (EDITOR_MODULES as readonly string[]).includes(name) ? name : 'main', text: body });
      chat = chat.replace(m[0], '');
    }
    const mainM = chat.match(/【更新记忆】\n?([\s\S]*?)(?=\n【|$)/);
    if (mainM) {
      if (mainM[1].trim()) memUpdates.push({ target: 'main', text: mainM[1].trim() });
      chat = chat.replace(mainM[0], '');
    }
    const duty = dutyM?.[1].trim();
    if (dutyM) chat = chat.replace(dutyM[0], '');
    // 剥块后清掉悬空的引入语尾行（模型偶尔在块前写「现在补上：」等短行，块剥掉后它挂在结尾像回复被掐断）：
    // 只清「短、无内嵌冒号、以冒号结尾」的尾行，且清完必须还有正文才生效
    const trimmed = chat.replace(/\n[^\n：:]{0,24}[：:]\s*$/, '').trim();
    if (trimmed) chat = trimmed;
    // 剥完协议块正文为空（模型只输出了记忆/职责块，没有任何说明文字）：占位一句，避免空泡
    if (!chat && (duty || memUpdates.length)) chat = '（本条无正文：已按协议整理记忆与职责，见下方卡片。）';
    return {
      ok: true,
      engine,
      chat: chat.trim(),
      ...(parsed.blocks.length ? { blocks: parsed.blocks } : {}),
      ...(parsed.writes.length ? { writes: parsed.writes } : {}),
      ...(duty ? { personaDraft: duty } : {}),
      ...(memUpdates.length ? { memUpdates } : {}),
    };
  } catch (e) {
    if (e instanceof GenerationAborted) return { ok: false, error: '已停止' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    useUiStore.getState().setGenerating(false);
  }
}

/** 🧠 记忆整合（v2.24 吸收升级，v2.26 模板副本模式）：新增条目不是单纯追加——与现有记忆整体对照整合：
 *  语义重复/接近的条目合并为一条；相互矛盾处以新增条目为准（新增是用户最新的要求与偏好）；无关条目原样保留。
 *  module 传入时为技能记忆模式：输入输出都是整份记忆文件副本（骨架=小节名/说明行/基线，一律原样保留），
 *  输出由调用方 revalidateSkillCopy 做确定性复验，本函数不再做行级清洗。占文本生成互斥；失败返回 error，
 *  调用方回退为确定性追加（主记忆=行级去重后追加；技能=appendToSkillCopy 按小节插入）。 */
export async function integrateEditorMemory(opts: {
  oldMemory: string;
  additions: string;
  engine: 'private' | 'public';
  /** 整合后总长目标（主记忆 MAIN_MEMORY_CAP / 技能记忆 SKILL_MEMORY_CAP） */
  targetLen?: number;
  /** 技能记忆：传模块名——输出为整份记忆文件副本，骨架原样保留 */
  module?: EditorModule;
}): Promise<{ ok: boolean; memory?: string; error?: string }> {
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  const gate = await agentGate(opts.engine);
  if (gate) return { ok: false, error: gate };
  ui.setGenerating(true);
  const signal = startGeneration();
  try {
    const system = opts.module
      ? `你是编辑的记忆管理员。下面是编辑「${opts.module}」技能记忆的副本——一份带固定小节结构的记忆文件（「## 小节名」、斜体说明行与基线条目构成骨架）。把「新增条目」整合进这份副本，输出整合后的完整记忆文件：
1. 新增条目已按小节归类：插进对应小节，写在基线条目之下；
2. 同一小节内语义重复或接近的条目合并为一条（保留更具体、更可执行的表达）；
3. 同一小节内相互矛盾的地方以新增条目为准（新增是用户最新的要求与偏好），删除或改写过时的旧条目；
4. 骨架一律原样保留：所有「## 小节名」的名称与顺序、斜体说明行、基线条目，不改写、不删除、不挪动。
${MEMORY_UPDATE_RULES}
总长控制在 ${opts.targetLen ?? SKILL_MEMORY_CAP} 字以内。只输出记忆文件正文，不要任何解释。`
      : `你是编辑的记忆管理员。把「新增条目」整合进「现有记忆」，输出整合后的完整记忆：
1. 逐条对照新增与现有：语义重复或接近的条目合并为一条（保留更具体、更可执行的表达）；
2. 相互矛盾的地方以新增条目为准（新增是用户最新的要求与偏好），删除或改写过时的旧条目；
3. 与新增无关的现有条目原样保留，不要改写、不要遗漏。
${MEMORY_UPDATE_RULES}
每条一行以「- 」开头，总长控制在 ${opts.targetLen ?? MAIN_MEMORY_CAP} 字以内。只输出记忆正文，不要任何解释或标题。`;
    const text = await qwGenerate({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `【现有记忆】\n${opts.oldMemory || '（空）'}\n\n【新增条目】\n${opts.additions}` },
      ],
      maxTokens: 4096,
      temperature: 0.3,
      engine: opts.engine,
      signal,
    });
    if (opts.module) {
      const memory = text.trim();
      return memory ? { ok: true, memory } : { ok: false, error: '整合结果为空' };
    }
    const memory = sanitizeMemoryEntries(text.trim());
    return memory ? { ok: true, memory } : { ok: false, error: '整合结果无有效条目' };
  } catch (e) {
    if (e instanceof GenerationAborted) return { ok: false, error: '已停止' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    useUiStore.getState().setGenerating(false);
  }
}

/** 🧠 记忆优化（v2.19c，v2.21 主/技能记忆共用）：记忆超过 OPTIMIZE_AT 阈值时自动触发——
 *  合并重复与近义条目、剔除空话与过时内容，压回 targetLen 内；细节（数字/示例/限制条件）不抽象化。
 *  module 传入时为技能记忆模式：只压缩各小节下追加的调教条目，骨架（小节名/说明行/基线）原样保留，
 *  输出由调用方 revalidateSkillCopy 复验。占文本生成互斥（与其它生成互斥，短暂几秒）；失败返回 error，
 *  调用方回退（主记忆直接截断写入；技能 trimSkillCopy 保骨架截断）。 */
export async function optimizeEditorMemory(opts: {
  memory: string;
  engine: 'private' | 'public';
  /** 优化目标长度（主记忆 MAIN_MEMORY_OPTIMIZE_TARGET / 技能记忆 SKILL_MEMORY_OPTIMIZE_TARGET） */
  targetLen?: number;
  /** 技能记忆：传模块名——输出为整份记忆文件副本，骨架原样保留 */
  module?: EditorModule;
}): Promise<{ ok: boolean; memory?: string; error?: string }> {
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  const gate = await agentGate(opts.engine);
  if (gate) return { ok: false, error: gate };
  ui.setGenerating(true);
  const signal = startGeneration();
  try {
    const system = opts.module
      ? `你是编辑的记忆管理员。下面这份编辑「${opts.module}」技能记忆是一份带固定小节结构的记忆文件，超过长度阈值，需要整理优化：压缩各小节里追加的调教条目（合并重复与近义、剔除空话与过时内容），压回目标长度。
骨架一律原样保留：所有「## 小节名」的名称与顺序、斜体说明行、基线条目，不改写、不删除、不挪动。
${MEMORY_UPDATE_RULES}
总长控制在 ${opts.targetLen ?? SKILL_MEMORY_OPTIMIZE_TARGET} 字以内；只输出记忆文件正文，不要任何解释。`
      : `你是编辑的记忆管理员。把下面这份「编辑记忆」整理优化：合并重复与近义条目，剔除空话、口号与过时内容，保留具体可执行的做法与用户偏好。
${MEMORY_UPDATE_RULES}
输出优化后的完整记忆：每条一行以「- 」开头，总长控制在 ${opts.targetLen ?? MAIN_MEMORY_OPTIMIZE_TARGET} 字以内。只输出记忆正文，不要任何解释或标题。`;
    const text = await qwGenerate({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: opts.memory },
      ],
      maxTokens: 4096,
      temperature: 0.3,
      engine: opts.engine,
      signal,
    });
    if (opts.module) {
      const memory = text.trim();
      return memory ? { ok: true, memory } : { ok: false, error: '优化结果为空' };
    }
    const memory = sanitizeMemoryEntries(text.trim());
    return memory ? { ok: true, memory } : { ok: false, error: '优化结果无有效条目' };
  } catch (e) {
    if (e instanceof GenerationAborted) return { ok: false, error: '已停止' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    useUiStore.getState().setGenerating(false);
  }
}

/** 🧪 手动检验样例（干净子 agent，2026-10-22）：不带任何对话历史/摘要/上一轮回复——
 *  只有编辑职责 + 当前技能记忆 + 一条任务，独立生成一次成品，供用户对照调教效果。
 *  与 absorbMemoryDraft 的写入路径完全无关：样例只展示，不影响已写入的记忆。
 *  占文本生成互斥（与其它生成互斥）；结果剥掉一切协议块（独立环境不该产出，剥掉兜底）。 */
function skillCheckSystem(e: Editor, module: EditorModule, memory: string): string {
  const materials = buildMaterialBlock(['canvas']).slice(0, CHAT_MATERIAL_CAP);
  return `你是小说创作团队的编辑「${e.name}」（擅长题材：${e.specialty || '不限'}）。本次是技能记忆的独立检验：你的对话历史为空，手头只有职责、技能记忆与一条任务。
【你的职责】
${e.persona.trim() || '（未设置，按擅长题材交流）'}

【你的技能记忆：${module}】（该能力的工作技法与调教经验，执行时逐条遵循）
${memory || '（暂无——直接按你的职责完成下述任务）'}

【项目资料】（画布舞台常驻，按需参考，不要整段复读）
${materials}

独立完成下面的任务，直接产出成品；不要提及技能记忆或本次检验，不要输出任何【更新记忆】【更新职责】等协议块。`;
}

export async function genSkillCheckSample(opts: {
  editor: Editor;
  module: EditorModule;
  /** 该模块当前技能记忆全文（检验对象） */
  memory: string;
  /** 检验任务（面板传该条记忆前最近的用户指令，截 500 字；空则用 SKILL_PROBE_TASKS） */
  task: string;
  engine: 'private' | 'public';
}): Promise<{ ok: boolean; sample?: string; error?: string }> {
  const ui = useUiStore.getState();
  if (ui.generating) return { ok: false, error: '已有生成任务进行中' };
  const gate = await agentGate(opts.engine);
  if (gate) return { ok: false, error: gate };
  ui.setGenerating(true);
  const signal = startGeneration();
  try {
    const text = await qwGenerate({
      messages: [
        { role: 'system', content: skillCheckSystem(opts.editor, opts.module, opts.memory) },
        { role: 'user', content: opts.task },
      ],
      maxTokens: 4096,
      temperature: 0.8,
      engine: opts.engine,
      signal,
    });
    const sample = text
      .replace(/【更新记忆[：:][^】\n]*】\n?[\s\S]*?(?=\n【|$)/g, '')
      .replace(/【更新记忆】\n?[\s\S]*?(?=\n【|$)/g, '')
      .replace(/【更新职责】\n?[\s\S]*?(?=\n【|$)/g, '')
      .trim();
    return sample ? { ok: true, sample } : { ok: false, error: '样例为空' };
  } catch (e) {
    if (e instanceof GenerationAborted) return { ok: false, error: '已停止' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    useUiStore.getState().setGenerating(false);
  }
}
