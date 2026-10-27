/** 设计引擎共用守卫与上下文压缩（Qwen 预检 / 提示词预算 / 对话摘要），供创作台与编辑室共用。 */
import { useQwenStore } from './qwenStore';
import { qwGenerate } from './qwenClient';

export const QWEN_SAFE_LIMIT = 12000; // Qwen 本地 27B 上下文宽裕，仅作失控保险

/** 动态提示词预算（字符）：模型 nCtx 已知时预留补全空间再折算字符（中文 1 字≈1.25 token，取 0.8 保守系数）——
 *  聊久后提示词不再挤占补全空间，避免输出被服务端提前截断/卡住；nCtx 未知回退 QWEN_SAFE_LIMIT，下限 3000。 */
export function promptCharBudget(nCtx: number, maxTokens: number): number {
  if (!nCtx) return QWEN_SAFE_LIMIT;
  return Math.max(3000, Math.min(QWEN_SAFE_LIMIT, Math.floor((nCtx - maxTokens) * 0.8)));
}

/** 对话中的一条消息（发上游时 agent → assistant） */
export interface AgentChatMsg {
  role: 'user' | 'agent';
  text: string;
}

/** 随消息附带的画布人物形象图（仅私有视觉模型） */
export interface CharacterVisionRef {
  /** 人物名 */
  name: string;
  /** 形象所属状态标签 */
  state: string;
  /** data URL */
  url: string;
}

/** 批量读图的分批信息（1 起）：一次请求只带一批人物形象，多批由 store 顺序发送并汇总。 */
export interface CharacterImageBatch {
  index: number;
  total: number;
}

/** 本轮带图时注入的系统提示：直接观察图片，并把可见细节用于人物/环境设计。
 *  characterCount=其中来自画布人物属性、由系统自动附上的形象图数量（排在用户附图之后）。 */
export function imageInputHint(count: number, characterCount = 0): string {
  if (!count && !characterCount) return '';
  const origin = !characterCount
    ? `本轮用户附带了 ${count} 张图片`
    : characterCount === count
      ? `本轮附带了 ${count} 张画布人物形象图`
      : `本轮附带了 ${count} 张图片（末尾 ${characterCount} 张为画布人物形象图，其余为用户附图）`;
  return `\n\n【图片输入】${origin}，已作为图像内容提供。请直接观察图片回答，不要声称无法查看图片；分析人物时可提取长相、发型、穿搭、配饰、材质、配色与气质，分析环境时可提取空间结构、光线、色调、物件与氛围。只写图片中可见或可合理推断的信息，不凭空补充；用户要求用于人物/环境设计时，按既有协议输出可落地设定块。`;
}

/** 画布人物形象图的来源说明：让模型知道这些图对应哪个人物/状态、不是用户新上传的参考图，
 *  以及主要用途是「对照文字设定、统一人物设计」。 */
export function characterImageHint(refs: ReadonlyArray<Pick<CharacterVisionRef, 'name' | 'state'>>): string {
  if (!refs.length) return '';
  const list = refs
    .map((r, i) => `${i + 1}.「${r.name}」${r.state ? `（形象状态：${r.state}）` : ''}`)
    .join('；');
  return `\n\n【画布人物形象图】用户本轮明确要求读取人物形象，系统已从其人物属性中读取 ${refs.length} 张形象大图并附在本条消息末尾，顺序：${list}。这些图不是用户新上传的参考图，主要用于**统一人物设计**：把图中可见的长相、身材、穿搭、配饰、气质与该人物的文字设定逐项对照，指出不一致处并给出可落地的统一建议（改文字或改形象由用户决定）。只写图中可见或可合理推断的信息，看不清或图里没有的内容不要编造；除非用户明确要求写入，不要自行修改设定。`;
}

/** 多批读图时的系统提示：让模型只处理本批人物，避免它声称看不到其它批次或给没附图的人编造形象。 */
export function characterImageBatchHint(batch: CharacterImageBatch | undefined): string {
  if (!batch || batch.total <= 1) return '';
  return `\n\n【分批读取形象图】本轮人物形象图较多，系统按每批最多 3 张分 ${batch.total} 批发送，当前是第 ${batch.index}/${batch.total} 批。只分析和处理本批附图人物；用户原话里的「这些人/他们/全部/所有人」在本批中仅指本批人物。不要声称看不到其它批次的人物，不要编造未附图人物的长相，也不要输出不在本批名单中的人物设定；其它批次会另行发送，最后由系统汇总。`;
}

/** Qwen 动作预检：不在线时返回指引文案（不进入页面互斥、快速失败）；在线返回 null */
async function qwenGate(): Promise<string | null> {
  const online = await useQwenStore.getState().ensureOnline();
  if (online) return null;
  const { status, msg } = useQwenStore.getState();
  return `🏠 私有模型不在线（${status === 'down' ? msg : '未检测'}）。请先开机租用 GPU 实例，再点顶栏「⚡」检测连通；服务地址/模型可在 ⚡ 弹窗修改`;
}

/** Agent 引擎预检：private 走私有模型预检（不在线给指引文案）；public 走公共中转（常在线，不预检，仅后台刷新 ⚡ 徽章） */
export async function agentGate(engine: 'private' | 'public'): Promise<string | null> {
  if (engine === 'public') {
    void useQwenStore.getState().ensureOnline();
    return null;
  }
  return qwenGate();
}

/** 压缩历史为结构化摘要；失败返回 ok:false + error */
export async function compactAgentContext(opts: {
  history: AgentChatMsg[];
  prevSummary: string;
  engine?: 'private' | 'public';
}): Promise<{ ok: boolean; summary?: string; error?: string }> {
  const engine = opts.engine ?? 'private';
  const gate = await agentGate(engine);
  if (gate) return { ok: false, error: gate };
  const transcript = opts.history.map((m) => `${m.role === 'agent' ? '助手' : '用户'}：${m.text}`).join('\n');
  const sys = '你是对话摘要器。把小说创作对话历史压缩成 300 字以内的结构化要点备忘，供后续对话作为长期记忆。只输出摘要本身，不要客套或解释。必须保留：已确定的设定（世界观/人物/文风/大纲要点）、用户明确的偏好与否决、未决问题。';
  const user = [
    opts.prevSummary.trim() ? `【已有摘要】\n${opts.prevSummary.trim()}` : '',
    `【对话历史】\n${transcript}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const summary = await qwGenerate({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens: 1024, temperature: 0.3, engine });
    if (!summary.trim()) return { ok: false, error: 'Qwen 返回空内容' };
    return { ok: true, summary: summary.trim() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
