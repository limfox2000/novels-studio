/** 生图 API 服务层（三仓同步副本：novels-studio / novels-imgcanvas / novels-novelsim，改动后各拷一份）：
 *  双轨生图（v2.24）：rail='public'（默认）=中转变体协议；rail='private'=ComfyUI。
 *  rail 缺省 public —— 旧调用零破坏；旧版服务端忽略 rail 字段同样零破坏。
 *  key 全部存服务端 imgconfig.json，前端只经 /api/imgconfig 打码交互。 */
import { API_BASE } from '../shared/apiBase';
import type { ImgConfig, ImgGraphDoc } from '../types/image';

export type ImgRail = 'public' | 'private';

export interface ImgSubmitPayload {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  imageSize?: string; // 清晰度档位；服务端公共轨出站时改名为 image_size（中转要求全小写字段名）
  image?: string[]; // data URL 数组（参考图；private 轨不支持）
  rail?: ImgRail; // 缺省 public（私有轨 = ComfyUI，任务 id 前缀 comfy-）
}

export interface ImgTaskState {
  status?: string; // queued / in_progress / completed / failed
  progress?: number;
  images?: string[]; // 本地落盘 URL（completed 时）
  error?: string;
}

async function jfetch(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, init);
  let j: any = null;
  try {
    j = await r.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

/** 服务器返回的根相对路径（/api/img/file/…）→ 带部署前缀的可访问 URL。
 *  SPA 部署在子路径下时，根相对路径少了前缀会 404。 */
export function withBase(u: string): string {
  return /^https?:\/\//i.test(u) || u.startsWith('data:') || u.startsWith(API_BASE)
    ? u
    : `${API_BASE}${u}`;
}

/** 提交生图任务，返回 task_id */
export async function imgSubmit(p: ImgSubmitPayload): Promise<string> {
  const j = await jfetch(`${API_BASE}/api/img/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  return j.task_id as string;
}

/** 轮询任务状态（图片路径补部署前缀） */
export async function imgTask(taskId: string): Promise<ImgTaskState> {
  const j = await jfetch(`${API_BASE}/api/img/task/${encodeURIComponent(taskId)}`);
  if (j.images) j.images = (j.images as string[]).map(withBase);
  return j;
}

/** 上传参考图（dataURL → 服务器落盘 → 本地 URL） */
export async function imgUpload(dataUrl: string): Promise<string> {
  const j = await jfetch(`${API_BASE}/api/img/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  return withBase(j.url as string);
}

/** 上传参考音频（mp3/wav/ogg/m4a/aac/flac/webm，dataURL → audiofiles/ 落盘）→ 本地 /api/aud/file/… URL */
export async function audUpload(dataUrl: string): Promise<string> {
  const j = await jfetch(`${API_BASE}/api/aud/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  return withBase(j.url as string);
}

/** 抓取远程音频 URL（服务端下载落盘，绕过 CORS）→ 本地 /api/aud/file/… URL */
export async function audFetchRemote(url: string): Promise<string> {
  const j = await jfetch(`${API_BASE}/api/aud/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return withBase(j.url as string);
}

/** 服务端抓取远程图片（网页图片 URL 粘贴用，绕过 CORS）→ 本地 URL */
export async function imgFetchRemote(url: string): Promise<string> {
  const j = await jfetch(`${API_BASE}/api/img/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return withBase(j.url as string);
}

/** 提交视频生成任务（AutoDL 反代），返回 task_id */
export interface VidSubmitPayload {
  prompt: string;
  image: string[]; // dataURL 数组；flf=2 张首尾帧，fast/quality=1-9 张多图参考
  mode?: 'flf' | 'fast' | 'quality';
  duration: number;
  resolution: string;
}

export async function vidSubmit(p: VidSubmitPayload): Promise<string> {
  const j = await jfetch(`${API_BASE}/api/vid/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  return j.task_id as string;
}

export interface VidTaskState {
  status?: string; // running / completed / failed
  stage?: string;  // 排队中 / 生成中
  videos?: string[]; // 本地落盘 URL（completed 时）
  error?: string;
}

/** 轮询视频任务状态（视频路径补部署前缀） */
export async function vidTask(taskId: string): Promise<VidTaskState> {
  const j = await jfetch(`${API_BASE}/api/vid/task/${encodeURIComponent(taskId)}`);
  if (j.videos) j.videos = (j.videos as string[]).map(withBase);
  return j;
}

/** 本地图片 URL → data URL（把上游输出作为下一轮参考图时用） */
export async function urlToDataUrl(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`读取图片失败 HTTP ${r.status}`);
  const b = await r.blob();
  return await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = () => rej(new Error('FileReader 失败'));
    fr.readAsDataURL(b);
  });
}

/** File → dataURL */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = () => rej(new Error('FileReader 失败'));
    fr.readAsDataURL(file);
  });
}

/** 读取图片尺寸 */
export function imageSizeOf(url: string): Promise<{ w: number; h: number }> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => rej(new Error('图片加载失败'));
    im.src = url;
  });
}

// ── 配置 ──
let confCache: { at: number; conf: ImgConfig } | null = null;
const CONF_TTL = 60_000;

/** 配置（60s 缓存）：编辑节点选模型列表用，避免每个节点重复请求 */
export async function imgConfigCached(): Promise<ImgConfig> {
  if (confCache && Date.now() - confCache.at < CONF_TTL) return confCache.conf;
  const conf = await imgLoadConfig();
  confCache = { at: Date.now(), conf };
  return conf;
}

export async function imgLoadConfig(): Promise<ImgConfig> {
  return jfetch(`${API_BASE}/api/imgconfig`);
}

/** 保存配置（api_key 留空或为打码值 = 不修改） */
export async function imgSaveConfig(patch: Partial<ImgConfig>): Promise<ImgConfig> {
  const conf = await jfetch(`${API_BASE}/api/imgconfig`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  confCache = { at: Date.now(), conf };
  return conf;
}

/** 拉生图上游列表：rail=private → ComfyUI 控制面板的工作流 ID 列表；public（默认）→ 中转真实模型 ID（供设置面板刷新） */
export async function imgRelayModels(rail?: ImgRail): Promise<string[]> {
  const q = rail ? `?rail=${rail}` : '';
  const j = await jfetch(`${API_BASE}/api/img/models${q}`);
  return j.models as string[];
}

// ── 画布存档 ──
export async function imgGraphList(): Promise<string[]> {
  const j = await jfetch(`${API_BASE}/api/imagegraphs`);
  return j.graphs as string[];
}

export async function imgGraphLoad(name: string): Promise<ImgGraphDoc> {
  const j = await jfetch(`${API_BASE}/api/imagegraph?name=${encodeURIComponent(name)}`);
  const doc = j.graph as ImgGraphDoc;
  // 存档里的图片路径是根相对路径，补部署前缀
  for (const n of doc.nodes ?? []) {
    const d = n.data as { url?: string } | undefined;
    if (d && typeof d.url === 'string') d.url = withBase(d.url);
  }
  // 旧存档：生图节点 4 个编号入口（in-1..in-4）归一为单一图口 in-img，并按连线顺序重编 图N
  const counters = new Map<string, number>();
  for (const e of doc.edges ?? []) {
    if (e.targetHandle && /^in-[1-9]$/.test(e.targetHandle)) e.targetHandle = 'in-img';
    if (e.targetHandle === 'in-img') {
      const n = (counters.get(e.target) ?? 0) + 1;
      counters.set(e.target, n);
      e.label = `图${n}`;
    }
  }
  return doc;
}

export async function imgGraphSave(name: string, graph: ImgGraphDoc): Promise<string> {
  const j = await jfetch(`${API_BASE}/api/imagegraph?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph }),
  });
  return j.savedAt as string;
}

export async function imgGraphDelete(name: string): Promise<void> {
  await jfetch(`${API_BASE}/api/imagegraph?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ── 文本素材库（提示词片段，存服务器跨画布共用，按名称 upsert） ──
export interface TextSnippet {
  name: string;
  text: string;
  createdAt: number;
}

/** 编辑室服务器编辑与模板共用 /api/snippet，以此前缀区分；模板库列表需过滤掉 */
export const EDITOR_SNIPPET_PREFIX = 'editor:';

export async function snippetList(): Promise<TextSnippet[]> {
  return (await jfetch(`${API_BASE}/api/snippets`)).snippets as TextSnippet[];
}

export async function snippetSave(name: string, text: string): Promise<TextSnippet[]> {
  return (
    await jfetch(`${API_BASE}/api/snippet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text }),
    })
  ).snippets as TextSnippet[];
}

export async function snippetDelete(name: string): Promise<TextSnippet[]> {
  return (
    await jfetch(`${API_BASE}/api/snippet?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
  ).snippets as TextSnippet[];
}

// ── 脚本生成器（DeepSeek 中转，OpenAI chat 协议；key 只存服务端 scriptconfig.json） ──
export interface ScriptConfig {
  base_url: string;
  api_key: string;
  key_set?: boolean;
  model_list: string[];
}

export interface ScriptChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function scriptLoadConfig(): Promise<ScriptConfig> {
  return jfetch(`${API_BASE}/api/scriptconfig`);
}

export async function scriptSaveConfig(patch: Partial<ScriptConfig>): Promise<ScriptConfig> {
  return jfetch(`${API_BASE}/api/scriptconfig`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** 脚本生成 chat（非流式，服务端代理中转）→ { text, model, elapsedMs } */
export async function scriptChat(model: string, messages: ScriptChatMessage[]): Promise<{ text: string; model: string; elapsedMs: number }> {
  return jfetch(`${API_BASE}/api/script/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }),
  });
}

// ── 脚本节点技能库（基础=服务端 skills/ 目录随部署分发；专家=用户添加/安装，存 skills.json） ──
export interface ScriptSkill {
  id: string;
  name: string;
  desc: string;
  kind: 'basic' | 'expert';
  content: string;
  source?: string;
}

export async function skillsList(): Promise<ScriptSkill[]> {
  return (await jfetch(`${API_BASE}/api/skills`)).skills as ScriptSkill[];
}

export async function skillAdd(name: string, content: string, desc?: string): Promise<ScriptSkill[]> {
  return (
    await jfetch(`${API_BASE}/api/skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content, desc }),
    })
  ).skills as ScriptSkill[];
}

export async function skillDelete(id: string): Promise<ScriptSkill[]> {
  return (await jfetch(`${API_BASE}/api/skill?id=${encodeURIComponent(id)}`, { method: 'DELETE' })).skills as ScriptSkill[];
}

/** 从 GitHub 安装技能（仓库链接或 raw SKILL.md URL，服务端抓取） */
export async function skillInstall(url: string): Promise<ScriptSkill[]> {
  return (
    await jfetch(`${API_BASE}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  ).skills as ScriptSkill[];
}

// ── 音频生成（IndexTTS2 语音合成，AutoDL.Art ComfyUI 反代，复用 vidconfig 令牌）──
export interface AudSubmitPayload {
  prompt_text: string;
  ref: string; // 音色参考音频：外链 URL 或 dataURI（本地音频由引擎转 dataURI）
  emo?: Record<string, number>; // 情感滑条 0-1（服务端仅提交非零值；上游不支持 emo_surprised）
  emo_random?: boolean;
  emo_control_method?: string;
}

export async function audSubmit(p: AudSubmitPayload): Promise<string> {
  const j = await jfetch(`${API_BASE}/api/aud/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  return j.task_id as string;
}

/** 轮询音频任务状态（音频路径补部署前缀） */
export async function audTask(taskId: string): Promise<VidTaskState & { audios?: string[] }> {
  const j = await jfetch(`${API_BASE}/api/aud/task/${encodeURIComponent(taskId)}`);
  if (j.audios) j.audios = (j.audios as string[]).map(withBase);
  return j;
}

// ── 媒体文件管理 ──
/** 清理服务器上未被任何存档引用且超过保护窗口（10 分钟）的图片/视频文件 */
export async function mediaGc(): Promise<{ deleted: number }> {
  return jfetch(`${API_BASE}/api/media/gc`, { method: 'POST' });
}

/** 触发浏览器下载（服务器文件同源，download 属性生效；文件留在用户磁盘） */
export function downloadFile(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = url.split('/').pop() || 'download';
  a.rel = 'noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
