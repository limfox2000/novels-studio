import type { Node, Edge } from '@xyflow/react';

/** 生图画布节点：参考图 / 文本（角色圣经·场景描述）/ 编辑（生成任务）/ 输出 / 视频（生成任务）/ 视频输出 / 首尾帧提取 / 手绘 / 脚本生成器 / 音频素材 / 音频生成 / 音频产物 */
export type ImgNodeKind = 'ref' | 'text' | 'edit' | 'out' | 'vid' | 'vidout' | 'frames' | 'draw' | 'script' | 'aud' | 'audref' | 'audout';
export interface ImgRefData extends Record<string, unknown> {
  kind: 'ref';
  url: string;         // 本地 /api/img/file/… URL（已落盘）
  w: number;
  h: number;
  name: string;
  loading?: boolean;   // 粘贴/拖入后上传中（节点先显示占位，完成后回填 url）
  error?: string;      // 导入失败信息（在节点上显示）
  annotate?: boolean;            // 标注模式开关（点击图片添加标记）
  annotations?: ImgAnnotation[]; // 图上标注（标记随图像本身存储）
}

export interface ImgTextData extends Record<string, unknown> {
  kind: 'text';
  text: string;        // 角色圣经 / 场景描述（Markdown 纯文本）
}

/** 生成节点的图上标注：x/y 为 0~1 相对坐标，text 描述该处如何修改 */
export interface ImgAnnotation {
  id: string;
  x: number;
  y: number;
  text: string;
}

export interface ImgEditData extends Record<string, unknown> {
  kind: 'edit';
  prompt?: string;     // 补充提示词（属性栏输入；与上游文字节点内容合并，文字节点在前）
  model: string;       // 中转的真实模型 ID（默认 gpt-image-2.5，不做别名映射）
  size: string;        // 1:1 / 16:9 / 9:16 / 4:3
  imageSize: string;   // 1K / 2K / 4K（空 = 不传）
  n: number;           // 生成数量
  status: 'idle' | 'generating' | 'done' | 'failed';
  taskId?: string;
  progress?: number;
  error?: string;
  startedAt?: number;
  elapsedMs?: number;
}

export interface ImgOutData extends Record<string, unknown> {
  kind: 'out';
  url: string;         // 本地落盘 URL
  model?: string;
  elapsedMs?: number;
  createdAt: number;
  annotate?: boolean;            // 标注模式开关（点击图片添加标记）
  annotations?: ImgAnnotation[]; // 图上标注（标记随图像本身存储）
}

export type ImgNodeData = ImgRefData | ImgTextData | ImgEditData | ImgOutData | VidNodeData | VidOutData | FramesData | DrawData | ImgScriptData | AudNodeData | AudRefData | AudOutData;
export type ImgNode = Node<ImgNodeData>;
export type ImgEdge = Edge;

/** 🎬 视频生成节点数据（操作逻辑同生图节点：参数/提示词在选中后弹出的属性栏，图上仅显示状态）
 *  图输入口 in-img 允许多条连线（连线标 图1、图2…）。生成模式 mode：
 *  flf=首尾帧（图1=首帧，图2=尾帧）；fast=快速多图参考（1-9 张）；quality=质量多图参考（1-9 张） */
export interface VidNodeData extends Record<string, unknown> {
  kind: 'vid';
  prompt?: string;     // 补充提示词（属性栏输入；与上游文字节点内容合并，文字节点在前）
  mode?: 'flf' | 'fast' | 'quality';
  duration: number;    // 秒数
  resolution: string;  // 768p横 等
  status: 'idle' | 'generating' | 'done' | 'failed';
  taskId?: string;
  stage?: string;      // 排队中 / 生成中（视频接口无百分比进度）
  error?: string;
  startedAt?: number;
  elapsedMs?: number;
}

export interface VidOutData extends Record<string, unknown> {
  kind: 'vidout';
  url: string;         // 本地 /api/vid/file/… mp4（取到结果立即落盘，防上游 URL 过期）
  duration?: number;
  resolution?: string;
  elapsedMs?: number;
  createdAt: number;
}

/** 🎞→🖼 首尾帧提取节点：连到视频输出节点，点击按钮把首帧/尾帧提取成两个图片（ref）节点 */
export interface FramesData extends Record<string, unknown> {
  kind: 'frames';
  status: 'idle' | 'working' | 'done' | 'failed';
  error?: string;
}

/** 🎨 手绘节点：弹出独立 Excalidraw 窗口绘制（支持手绘屏），完成后导出 PNG 落盘服务器。
 *  url = 整合输出（底图+手绘所有图层，白底）；layerUrl = 手绘层输出（排除底图，透明底 PNG）。
 *  base = 接入的底图 URL（连线传入或上次保留）；url 为空表示还没画过。
 *  绘制结果作为参考图喂给生图/视频节点（图口 in-img）。 */
export interface DrawData extends Record<string, unknown> {
  kind: 'draw';
  url: string;
  layerUrl?: string;
  w: number;
  h: number;
  base?: string;
}

/** 📜 脚本生成器节点：接入 DeepSeek API（+skill）读入上游故事文本，产出故事的分镜设计——
 *  人物设计提示词、环境设计提示词、镜头设计提示词，产物为 1..N 个 📝 文本节点（自动创建并连线）。
 *  操作逻辑同生图节点：要求在选中后弹出的属性栏填写，图上仅显示状态/进度。 */
export interface ImgScriptData extends Record<string, unknown> {
  kind: 'script';
  prompt?: string;     // 补充要求（属性栏输入；与上游文字节点内容合并，文字节点在前）
  model?: string;      // DeepSeek 中转模型 ID（默认取 scriptconfig model_list 第一项）
  skillId?: string;    // 手动指定技能 ID（非空=跳过规划器整篇加载该技能；空=agent 按需自动挑选技能章节）
  status: 'idle' | 'generating' | 'done' | 'failed';
  stage?: string;      // 进度阶段描述（分析需求 / 构思分镜中 / 解析产物中）
  progress?: number;   // 0-100（可选）
  error?: string;
  startedAt?: number;
  elapsedMs?: number;
  plan?: string;       // 规划器产出的本次生成计划（一句话）
  usedSkills?: string[]; // 本次实际加载的技能名（基础·xxx 等；空=规划判定无需技能）
  styleExclude?: boolean; // 画面风格排除（默认开）：提示词只写内容不提风格，风格由用户外部统一指定；false=允许写风格
}

/** 🎵 音频生成节点：IndexTTS2 语音合成（AutoDL.Art ComfyUI 反代，复用 vidconfig 令牌）。
 *  只负责生成：「参」口接 🎧 音频素材 / 🔊 音频产物节点的音色，要念的文本在属性栏填写；
 *  产物生成到右侧自动创建的 🔊 音频产物节点（逻辑同生图→输出节点）。
 *  情感滑条（emo）仅非零值提交；上游 schema 不支持 emo_surprised，不提供该滑条。
 *  refUrl 为旧版遗留字段（现为空，兼容旧存档显示）。 */
export interface AudNodeData extends Record<string, unknown> {
  kind: 'aud';
  prompt?: string;              // 要念的文本
  refUrl?: string;              // （已废弃）旧版手填参考 URL，仅旧存档兼容
  emo?: Record<string, number>; // 情感滑条 0-1（happy/calm/sad/angry/afraid/disgusted/melancholic）
  emoRandom?: boolean;          // 随机情感
  controlMethod?: string;       // 情感控制方式（默认 与音色参考音频相同）
  status: 'idle' | 'generating' | 'done' | 'failed';
  taskId?: string;
  stage?: string;
  error?: string;
  startedAt?: number;
  elapsedMs?: number;
  url?: string;                 // （旧存档）产物本地 /api/aud/file/…wav；新生成走 🔊 产物节点
}

/** 🎧 音频素材节点：参考音频（音色来源），等价图片的参考图节点。
 *  拖音频文件进画布 / 属性栏上传 / 属性栏 URL 服务端抓取 → 本地 /api/aud/file/… 落盘；
 *  out 口连音频生成节点的「参」口。 */
export interface AudRefData extends Record<string, unknown> {
  kind: 'audref';
  url: string;      // 本地 /api/aud/file/…（空 = 未载入）
  name: string;     // 文件名 / 来源名
  loading?: boolean; // 上传/抓取中
  error?: string;    // 载入失败信息
}

/** 🔊 音频产物节点：音频生成节点的产物（等价图片的输出节点 / 视频的视频输出节点）。
 *  内嵌播放 + 下载；out 口可连下游音频生成节点「参」口复用音色。 */
export interface AudOutData extends Record<string, unknown> {
  kind: 'audout';
  url: string;        // 本地 /api/aud/file/…wav
  elapsedMs?: number;
  createdAt: number;
}

/** 生图配置（双轨）：default=默认轨；🏠 private=ComfyUI 控制面板（地址 + 工作流 ID）；🌐 public=中转（地址+key+真实模型 ID 表）。
 *  api_key 服务端打码返回，前端不持有明文。base_url/api_key/key_set/model_list 为旧版前端兼容别名（镜像 public 轨，服务端返回）。
 *  private.model 为旧版原生 ComfyUI checkpoint，仅在未配置 workflow_id 时由服务端兼容使用。 */
export interface ImgConfig {
  default: 'public' | 'private';
  private: { base_url: string; workflow_id: string; model?: string };
  public: { base_url: string; api_key: string; key_set?: boolean; model_list: string[] };
  base_url?: string; // 兼容别名 → public.base_url
  api_key?: string; // 兼容别名 → public.api_key（打码）
  key_set?: boolean;
  model_list?: string[]; // 兼容别名 → public.model_list
  sizes: string[];
  image_sizes: string[];
  max_refs?: number;
}

/** 画布存档（imagegraphs/*.json 的 graph 字段形状） */
export interface ImgGraphDoc {
  nodes: ImgNode[];
  edges: ImgEdge[];
  currentOutId?: string | null;
}
