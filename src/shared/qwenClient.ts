/**
 * 文本生成客户端（双模型：🏠 私有模型=自建/租用 GPU，🌐 公共模型=SaaS 中转）——编辑室与设计类动作用：
 * GET  /api/qwen/ping        私有模型连通检查（租用服务器常关机，用前先探）
 * GET  /api/qwen/models      拉上游支持的模型列表（engine=private|public）
 * POST /api/qwen/chat        OpenAI 兼容 chat，SSE 流式透传（服务端按 engine 选上游并翻译协议）
 * 配置存服务器 qwenconfig.json（private/public 双套 base_url/model/api_key），前端经「模型中心」面板读写
 */
import { API_BASE } from './apiBase';
import { GenerationAborted } from './generation';

/** 文本引擎：private=🏠 私有模型 / public=🌐 公共模型 */
export type TextEngine = 'private' | 'public';

/** 推理强度四档：off=直接作答；low/medium/high=请求推理（私有轨仅区分开/关，公共轨按档位下发） */
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** 推理越强，补全预算预留越多（思考 token 计入 max_tokens）。
 *  注意：服务端代理有 600 秒整轮超时，预算不能无脑拉大（27B 私有模型约 25 tok/s，12288 已接近上限）；
 *  超过预算或超时不会让用户重来——qwGenerate 会关闭推理自动重试一次（正文预算完整留给结果）。 */
export const REASONING_EFFORT_MAX_TOKENS: Record<ReasoningEffort, number> = {
  off: 4096,
  low: 6144,
  medium: 8192,
  high: 12288,
};

export const REASONING_EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
};

export interface QwenPingResult {
  ok: boolean;
  models?: string[];
  latencyMs?: number;
  error?: string;
}

export async function qwPing(): Promise<QwenPingResult> {
  const resp = await fetch(API_BASE + '/api/qwen/ping', { signal: AbortSignal.timeout(8000) });
  return resp.json();
}

/** 上游模型信息（llama.cpp /v1/models 的 meta）：n_ctx 为启动参数生效后的真实上下文 */
export interface QwenMeta {
  ok: boolean;
  model?: string;
  n_ctx?: number;
  n_ctx_train?: number;
  ftype?: string;
  error?: string;
}

export async function qwGetMeta(): Promise<QwenMeta> {
  const resp = await fetch(API_BASE + '/api/qwen/meta');
  return resp.json();
}

// ── 服务配置（base_url/model 存服务器 qwenconfig.json；租用实例地址随开关机变动，页面可改） ──

export interface QwenConfig {
  base_url: string;
  model: string;
  /** 🏠 私有模型 key（只存服务器；响应里为打码 key_set，前端不保存明文） */
  api_key?: string;
  key_set?: boolean;
  /** 🌐 公共模型（SaaS 中转，key 只存服务器；前端仅见打码 key_set）。api_key 仅用于保存请求（响应中为打码值，不入前端状态） */
  public?: { base_url: string; model: string; api_key?: string; key_set?: boolean };
}

function mapQwenConfig(d: Partial<QwenConfig>): QwenConfig {
  return {
    base_url: d.base_url ?? '',
    model: d.model ?? '',
    key_set: Boolean(d.key_set),
    public: d.public ? { base_url: d.public.base_url ?? '', model: d.public.model ?? '', key_set: d.public.key_set } : undefined,
  };
}

export async function qwGetConfig(): Promise<QwenConfig> {
  const resp = await fetch(API_BASE + '/api/qwenconfig');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return mapQwenConfig((await resp.json()) as Partial<QwenConfig>);
}

export async function qwSaveConfig(patch: Partial<QwenConfig>): Promise<QwenConfig> {
  const resp = await fetch(API_BASE + '/api/qwenconfig', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return mapQwenConfig((await resp.json()) as Partial<QwenConfig>);
}

/** 拉指定引擎上游支持的模型列表（GET {base}/v1/models；公共带 key，私有不带）。失败抛错（弹窗提示后可手填） */
export async function qwListModels(engine: TextEngine): Promise<string[]> {
  const resp = await fetch(API_BASE + `/api/qwen/models?engine=${engine}`, { signal: AbortSignal.timeout(12000) });
  const d = (await resp.json().catch(() => null)) as { models?: string[]; error?: string } | null;
  if (!resp.ok || !d || d.error) throw new Error(d?.error || `HTTP ${resp.status}`);
  return d.models ?? [];
}

export interface QwenChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface QwenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface QwenStreamOptions {
  /** 单轮提示词（简单生成用；传入 messages 时忽略） */
  plot?: string;
  /** 完整多轮消息数组（system/user/assistant），Agent 对话用 */
  messages?: QwenChatMessage[];
  /** 收到累积净文本时回调（每个 SSE 批次一次） */
  onDelta?: (accumulatedText: string) => void;
  /** 收到累积思考文本时回调（推理开启且上游分离 reasoning_content 时有值） */
  onThinkDelta?: (accumulatedThink: string) => void;
  /** 流结束时回调精确 token 用量（上游 stream_options.include_usage） */
  onUsage?: (usage: QwenUsage) => void;
  /** 推理强度（默认 off=直接答）；off 以外的档位请配合 REASONING_EFFORT_MAX_TOKENS 抬补全预算 */
  reasoningEffort?: ReasoningEffort;
  /** 引擎：private=🏠 私有模型（默认）/ public=🌐 公共模型（手动切换，不自动 failover） */
  engine?: TextEngine;
  /** 实际服务引擎（响应头 X-Qwen-Engine），消息打标用 */
  onEngine?: (engine: TextEngine) => void;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /** 发生「只思考没正文」后自动降级重试时回调（UI 可提示这次是在关闭推理后得到的） */
  onFallback?: (reason: string) => void;
}

/** 思考耗尽补全预算（正文为空）——可自动关推理重试的内部错误 */
class ReasoningExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReasoningExhausted';
  }
}

/** 剥离可能内联进 content 的思考段：<think>…</think> 整段移除；未闭合时丢弃开启点之后全部 */
function stripThinking(text: string): string {
  let out = text;
  for (;;) {
    const open = out.indexOf('<think>');
    if (open === -1) break;
    const close = out.indexOf('</think>', open);
    out = close === -1 ? out.slice(0, open) : out.slice(0, open) + out.slice(close + 8);
  }
  return out.trim();
}

/** 单次流式生成，resolve 最终净文本；中止时 reject GenerationAborted。
 *  思考耗尽（只有 thinking、正文为空）抛 ReasoningExhausted，由 qwGenerate 决定是否降级重试。 */
async function qwGenerateOnce(opts: QwenStreamOptions): Promise<string> {
  const engineLabel = opts.engine === 'public' ? '🌐 公共模型' : '🏠 私有模型';
  const messages = opts.messages ?? [{ role: 'user' as const, content: opts.plot ?? '' }];
  const effort = opts.reasoningEffort ?? 'off';
  const resp = await fetch(API_BASE + '/api/qwen/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      max_tokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature ?? 0.7,
      // 旧字段（布尔）保留给旧版 server.py；新 server.py 以 reasoning_effort 为准
      thinking: effort !== 'off',
      reasoning_effort: effort,
      engine: opts.engine ?? 'private',
    }),
    signal: opts.signal,
  });
  if (!resp.ok) {
    const t = (await resp.json().catch(() => null)) as { error?: string } | null;
    throw new Error(`${engineLabel} ${t?.error || `HTTP ${resp.status}`}`);
  }
  const served = resp.headers.get('X-Qwen-Engine');
  if (served === 'private' || served === 'public') opts.onEngine?.(served);
  if (!resp.body) throw new Error('响应不支持流式读取');

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let think = '';
  let usage: QwenUsage | null = null;
  let streamDone = false;

  const processLine = (line: string) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    if (data === '[DONE]') {
      streamDone = true;
      return;
    }
    try {
      const chunk = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
        usage?: QwenUsage;
      };
      if (chunk.usage && !chunk.choices?.length) usage = chunk.usage; // 流末尾独立 usage 块
      const delta = chunk.choices?.[0]?.delta;
      if (typeof delta?.reasoning_content === 'string') {
        think += delta.reasoning_content;
        opts.onThinkDelta?.(think);
      }
      if (typeof delta?.content === 'string') content += delta.content;
    } catch {
      /* 心跳行或不完整 JSON，忽略 */
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      lines.forEach(processLine);
      opts.onDelta?.(stripThinking(content));
      if (streamDone) break;
    }
    if (buf.trim()) processLine(buf.trim());
  } catch (e) {
    if (opts.signal?.aborted) throw new GenerationAborted();
    throw e;
  }
  // 代理两条引擎路径结尾都发 data: [DONE]；连接提前关闭（没收到）= 回复被掐断，
  // 必须报错而不是把半截文本当成功返回（否则长回复静默缺失尾部，用户无从察觉）。
  // 例外：正文一个字都还没有、却已经思考了很久 → 多半是服务端 600 秒超时把思考掐断，
  // 当作「思考耗尽」交给 qwGenerate 关闭推理重试，而不是让用户白等一场再手动重来。
  if (!streamDone && !opts.signal?.aborted) {
    const hadThinking = !!think.trim() || /<think>/.test(content);
    if (!stripThinking(content) && hadThinking) {
      throw new ReasoningExhausted(
        `${engineLabel}思考超时/被截断（正文为空，思考 token 与正文共用预算）——已自动关闭推理重试`,
      );
    }
    throw new Error(`${engineLabel}连接中断，回复不完整，请重试`);
  }
  if (usage) opts.onUsage?.(usage);
  const final = stripThinking(content);
  if (!final) {
    // 只有思考没有正文：多为思考耗尽 completion 预算（reasoning_content 计入 max_tokens）。
    // 兼容把思考内联进 content 的上游：未闭合的 <think> 也算思考耗尽，而不是「空回复」。
    const hadThinking = !!think.trim() || /<think>/.test(content);
    throw hadThinking
      ? new ReasoningExhausted(
          `${engineLabel}只输出了思考过程（思考耗尽输出预算，正文为空）——可直接重试，或调低/关闭「推理强度」`,
        )
      : new Error(`${engineLabel}返回空内容`);
  }
  return final;
}

/** 对外生成入口：思考耗尽时自动关闭推理重试一次。
 *  架构原因：推理 token 与正文共用 max_tokens，且私有轨只能开关思考、无法限制思考长度——
 *  一旦模型在思考里用尽预算，整轮就只剩 think、正文为空。与其把失败抛给用户重来，
 *  这里在确认「本轮尚无任何正文」后降级重试：预算不变、关闭思考，保证结构化任务（大纲/正文/设定）拿到结果。
 *  用户指定的高推理首次仍然完整执行；只有确实耗尽时才降级，并可通过 onFallback 告知 UI。 */
export async function qwGenerate(opts: QwenStreamOptions): Promise<string> {
  const effort = opts.reasoningEffort ?? 'off';
  try {
    return await qwGenerateOnce(opts);
  } catch (e) {
    if (e instanceof GenerationAborted || !(e instanceof ReasoningExhausted) || effort === 'off') throw e;
    if (opts.signal?.aborted) throw new GenerationAborted();
    opts.onFallback?.('思考已耗尽输出预算，已自动关闭推理重试一次');
    opts.onThinkDelta?.(''); // 清掉上一次的思考流，避免重试时仍显示旧思考
    return await qwGenerateOnce({ ...opts, reasoningEffort: 'off' });
  }
}
