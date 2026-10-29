import type { Edge, Node } from '@xyflow/react';

/** 创作台页（#/studio）节点数据：🧑 人物 + 🏗 环境。
 *  形态：画布即地图——环境节点自由拖放摆出建筑/房间/社区/城镇等，人物节点放置其间；规则/目标约束大纲与正文生成。 */

/** 环境类型（开放集合，先列常用；「区域」兜底自定义场景）。
 *  v2.18 增两种语义属性：床=房间下一层的容器（可设定为床/炕，容纳人物休息睡觉）；物品=非容器的物件标记
 *  （告知 AI 此处存在一个东西——一桌饭菜/一头野兽/一堆火把），拖放判定不把物品当容器。 */
export const ENV_TYPES = ['room', 'building', 'community', 'town', 'area', 'bed', 'item'] as const;
export type EnvironmentType = (typeof ENV_TYPES)[number];

/** 环境类型元数据（v2.18）：图标 / 是否容器 / 清淡配色（节点边框+底色、标题条、MiniMap 点色）——
 *  节点渲染（SimEnvironmentNode）、拖放容器判定（findContainerAt）、MiniMap 点色共用。
 *  class 全量字面量书写（Tailwind 4 扫描本文件生成）。 */
export const ENV_TYPE_META: Record<
  EnvironmentType,
  { label: string; icon: string; container: boolean; border: string; body: string; bar: string; dot: string }
> = {
  room: { label: '房间', icon: '🚪', container: true, border: 'border-emerald-300/60', body: 'bg-emerald-50/70', bar: 'bg-emerald-500/85', dot: '#34d399' },
  building: { label: '建筑', icon: '🏗', container: true, border: 'border-teal-300/60', body: 'bg-teal-50/70', bar: 'bg-teal-500/85', dot: '#2dd4bf' },
  community: { label: '社区', icon: '🏘', container: true, border: 'border-sky-300/60', body: 'bg-sky-50/70', bar: 'bg-sky-500/85', dot: '#38bdf8' },
  town: { label: '城镇', icon: '🏙', container: true, border: 'border-indigo-300/60', body: 'bg-indigo-50/70', bar: 'bg-indigo-500/85', dot: '#818cf8' },
  area: { label: '区域', icon: '🗺', container: true, border: 'border-slate-300/60', body: 'bg-slate-50/70', bar: 'bg-slate-500/85', dot: '#94a3b8' },
  bed: { label: '床', icon: '🛏', container: true, border: 'border-amber-300/70', body: 'bg-amber-50/80', bar: 'bg-amber-500/85', dot: '#fbbf24' },
  item: { label: '物品', icon: '📦', container: false, border: 'border-stone-300/70', body: 'bg-stone-50/80', bar: 'bg-stone-500/85', dot: '#a8a29e' },
};

export const ENV_TYPE_LABELS: Record<EnvironmentType, string> = Object.fromEntries(
  ENV_TYPES.map((t) => [t, ENV_TYPE_META[t].label]),
) as Record<EnvironmentType, string>;

/** 该环境类型是否容器（物品不是——findContainerAt 跳过，任何节点都不可拖入物品） */
export function isContainerEnv(t: EnvironmentType): boolean {
  return ENV_TYPE_META[t].container;
}

/** 🚻 人物性别（基础属性）：male=男（默认）/ female=女；决定剪影头像与配色（男蓝/女玫红，SimNodes.GENDER_STYLE） */
export type CharacterGender = 'male' | 'female';

/** 性别兜底：非 female 一律归默认男（sanitize 旧档案/损坏缓存共用；v2.13a 用户拍板不设「未设置」态） */
export function genderOf(v: unknown): CharacterGender {
  return v === 'female' ? 'female' : 'male';
}

/** 性别 → 中文标签（AI 注入用：主角简报/画布摘要/编辑室协议） */
export const GENDER_LABELS: Record<CharacterGender, string> = { male: '男', female: '女' };

/** 🖼 人物大图尺寸预设：AI 生成使用；上传原图保持自身尺寸。 */
export const CHARACTER_IMAGE_PRESETS = ['1:1', '4:3', '16:9', '9:16'] as const;
export type CharacterImagePreset = (typeof CHARACTER_IMAGE_PRESETS)[number];

export const CHARACTER_IMAGE_PRESET_DIMS: Record<
  CharacterImagePreset,
  { label: string; w: number; h: number }
> = {
  '1:1': { label: '1024×1024', w: 1024, h: 1024 },
  '4:3': { label: '1440×1080', w: 1440, h: 1080 },
  '16:9': { label: '1920×1080', w: 1920, h: 1080 },
  '9:16': { label: '1080×1920', w: 1080, h: 1920 },
};

/** 从大图裁出的头部区域（源图像素坐标；size 同时是宽高，保持正方形） */
export interface CharacterImageCrop {
  x: number;
  y: number;
  size: number;
}

/** 人物状态的大图与圆形头像引用：图片本体在浏览器 IndexedDB，状态里只存轻量元数据。 */
export interface CharacterStateImage {
  /** IndexedDB key：charimg:<characterId>:<stateId>:<nonce>（旧数据以 node.id 建库，旧 key 原样有效） */
  key: string;
  width: number;
  height: number;
  /** AI 生成时的尺寸预设；上传原图时为 'original' */
  preset: CharacterImagePreset | 'original';
  /** IndexedDB key：charhead:<characterId>:<stateId>:<nonce>；undefined=未裁切，画布显示性别剪影 */
  headKey?: string;
  /** 头部裁切区域；只有存在 headKey 时才有意义 */
  crop?: CharacterImageCrop;
}

/** 🧬 人物状态（v2.30）：同一人物随剧情变化的一套属性。
 *  人名/性别跨状态稳定，留在 WorkCharacter 顶层；其余属性与人物形象都属于状态。
 *  旧版平铺字段由 sanitize 自动迁入首项「状态0」；旧 avatar/写真不迁移。 */
export interface CharacterState {
  /** 状态 ID：人物内稳定；创建时首项固定 state0，新增用 uid。复制人物时保留 */
  id: string;
  /** 状态标签：默认「状态0」，新增建议「状态1/状态2」，可重命名（如「重伤后」）；人物内唯一 */
  label: string;
  /** 年龄（可选）：节点上跟在人名后显示（如「李刚 32」） */
  age?: number;
  /** 基础信息（v2.27）：长相、身材、习惯穿搭、性格——人物本身的样子与性情 */
  basicInfo: string;
  /** 身份信息（v2.27）：职业、身份、与故事相关的特殊设计——人物在世界中的位置与钩子 */
  identityInfo: string;
  /** 关系信息（v2.20，可选）：与其他人物之间的关系（如父子/仇敌/师徒） */
  relations?: string;
  /** 🖼 人物形象（v2.31）：大图 + 手动裁切的头部圆形头像，按状态独立保存 */
  image?: CharacterStateImage;
}

/** 📇 作品级人物（人物库 v3）：身份与全部状态定义只存这一份，作品内唯一。
 *  画布节点退化为放置（CharacterPlacementData）：只决定人物出现在哪张画布、当前用哪个状态。
 *  姓名/性别/状态的任何修改全局生效——所有卷/章的放置立即读到同一份数据。 */
export interface WorkCharacter {
  /** 人物库 ID，作品内唯一；与画布节点 ID 解耦 */
  id: string;
  name: string;
  gender: CharacterGender;
  /** 至少一项；首项=默认状态「状态0」。状态属于人物，不属于某张画布 */
  states: CharacterState[];
}

/** 人物节点（放置）：只保存「谁放在这里、当前显示哪个状态」——位置/父子/尺寸仍属 React Flow 节点本体。
 *  人物属性（姓名/性别/状态/形象）一律查 SimState.characters[characterId]；本画布当前状态按放置独立（C1），
 *  切换状态只写放置节点，不影响其它卷。同一画布内一个 characterId 最多一个放置（sanitize 去重保留首个）。 */
export interface CharacterPlacementData extends Record<string, unknown> {
  kind: 'character';
  /** 指向 SimState.characters；与画布节点 ID 解耦 */
  characterId: string;
  /** 本画布当前使用的状态；非法值由 sanitize/解析回落首项 */
  activeStateId: string;
}

/** 环境节点：地图摆放单元兼容器——可表达建筑/房间/社区/城镇等，自由拖放定位（v2.18 增 床=可住人的容器 / 物品=非容器标记）；
 *  可用 NodeResizer 缩放（尺寸存 node.width/height），可用 RF12 parentId 嵌套（镇>建筑>房间…，子节点随父移动） */
export interface EnvironmentData extends Record<string, unknown> {
  kind: 'environment';
  name: string;
  etype: EnvironmentType;
  desc: string;
  /** 🔒 移动锁定：只禁止拖动/缩放，不影响改名、描述、父子归属与删除 */
  locked?: boolean;
  /** 🏷 环境标签（统一标签内核，设计文档 §19.3）：引用作品级定义库（SimSchema）中 scope=env 的
   *  affordance / narrative 定义 id。缺省=无标签；sanitize 时过滤未知定义。
   *  内核零内置内容：具体有哪些标签完全由作者在设计页定义。 */
  tags?: string[];
}

export type SimData = CharacterPlacementData | EnvironmentData;
export type SimNodeType = Node<SimData>;

/** 两类合法节点 kind（sanitize：服务器旧档案/损坏缓存中不在集合内的节点一律过滤） */
export const SIM_KINDS = ['character', 'environment'] as const;

/** 📚 卷（v2.17）：章节的分卷——第 1~3 章都属第一卷，每卷一段简单介绍；
 *  生成该卷各章的大纲时注入卷介绍，给出统一方向、防止卷内各章大纲偏离/彼此割裂（替代 v2.16 的长期目标节点方案） */
export interface SimVolume {
  id: string;
  /** 卷名（如「第一卷 初入宗门」） */
  title: string;
  /** 卷介绍：这一卷讲什么、往哪个方向推进（大纲生成时注入） */
  intro: string;
}

/** 📋 章节大纲管理器 / 📝 正文管理器：单章数据（随地图存档保存）。
 *  大纲生成消费 📜章节大纲规则（v2.14c 起不带全文规则）+ 🎯全文目标（store.mainGoal，v2.16）+ 📚本章所属卷的卷介绍（v2.17，统一整卷方向）
 *  + 画布舞台 + 前情大纲（studioEngine.genChapterOutline）；
 *  正文生成消费 📜全文规则 + 🎯全文目标（v2.16）+ 本章大纲（必须有——正文生成按钮的开启条件）+ 画布舞台 + 前情正文（studioEngine.genChapterContent） */
export interface SimChapter {
  id: string;
  title: string;
  /** 📚 所属卷（v2.17）：volumes 里的 id（''=未分卷）；生成大纲时注入该卷的卷介绍控制整卷方向 */
  volumeId: string;
  /** 用户手写的大概需求（本章方向，可留空） */
  requirement: string;
  /** AI 生成的大纲（按章节大纲规则的结构，流式写入） */
  outline: string;
  /** AI 生成的正文（按本章大纲展开成小说正文，流式写入；无大纲不可生成） */
  content: string;
  /** 📸 本章舞台快照（R2/R3）：区域名单、冻结几何与采集时标签；生成大纲/正文时作为权威名单 */
  snapshot?: ChapterSnapshot;
  /** ✨ 本章正文启用的写作技能 ID（全局技能库 nc2-writing-skills-v1；最多 3 个，缺省=不启用）。
   *  只注入本章正文生成，不影响大纲；技能库中已删除的 ID 在解析时忽略。随章节存档/导出自然携带。 */
  writingSkillIds?: string[];
}

/** 🎭 名单角色：在场（可行动/说话/被直接描写）/ 仅提及（只能被提到，不在现场行动） */
export type CastRole = 'present' | 'mentioned';

/** 快照来源：旧手动记录 / 旧生成时自动采集 / 自动跟随当前章节场景（v2.32） */
export type SnapshotSource = 'manual' | 'auto-outline' | 'auto-content' | 'auto-scene';

/** 📸 本章名单条目：只存人物/状态引用与采集时标签，不复制完整属性（属性仍从人物库解析） */
export interface ChapterSnapshotEntry {
  /** 人物身份 = 人物库 ID（characters 的键；非画布节点 ID） */
  characterId: string;
  /** 采集/手动选择的状态 id；人物内稳定 */
  stateId: string;
  role: CastRole;
  /** 采集时画布绝对坐标（用于记录位置与后续差异，不做画布视觉投影） */
  x: number;
  y: number;
  /** 直接父环境 id（如有） */
  parentEnvId?: string;
  /** 采集时环境路径（当前环境缺失时展示） */
  envPathAtCapture: string;
  nameAtCapture: string;
  stateLabelAtCapture: string;
  /** 状态属性指纹：用于检测快照采集后状态被原地修改 */
  stateFingerprintAtCapture: string;
  /** region=区域自动采集；manual=人工添加 */
  origin: 'region' | 'manual';
  /** 人工改过角色：刷新快照时保留，不被几何建议覆盖 */
  roleLocked?: boolean;
  /** 人工选过状态：刷新快照时保留，不跟随人物当前状态 */
  stateLocked?: boolean;
}

/** 📸 快照环境引用：冻结名称/类型/路径/最小描述，生成时不受工作画布后续修改影响 */
export interface SnapshotEnvRef {
  id: string;
  name: string;
  etype: EnvironmentType;
  path: string;
  desc: string;
}

/** 📸 章节快照（R3）：一章一份；区域几何、名单、环境引用在采集时冻结。
 *  快照引用人物/状态 id，不复制完整属性；后续修改状态会影响解析结果（UI 提示引用章节）。 */
export interface ChapterSnapshot {
  version: 1;
  /** 采集时章节所属画布 */
  boardId: string;
  capturedAt: number;
  updatedAt: number;
  source: SnapshotSource;
  /** 冻结区域几何；当前 UI 一章一个，保留数组便于后续多场景 */
  regions: ChapterRegion[];
  entries: ChapterSnapshotEntry[];
  envRefs: SnapshotEnvRef[];
}

/** 卷画布视口（v2.29）：每张画布独立记住平移/缩放，切标签时恢复 */
export interface SimViewport {
  x: number;
  y: number;
  zoom: number;
}

/** 📐 章节区域（v2.31）：画布上的浅色矩形注释，绑定一个章节。
 *  只用来采集/展示本章舞台范围，**不是人物/环境节点**，不进入 AI 节点检索、属性面板或 MiniMap。
 *  几何为画布绝对坐标；区域随所属 board 持久化，一章在一个画布上最多一个。 */
export interface ChapterRegion {
  id: string;
  chapterId: string;
  /** 标签始终由章节标题派生，不单独存储，避免与章名不一致 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 预留主题色；R1 统一使用品牌色 */
  color?: string;
}

// ── 🎬 推演世界模型定义库（SimSchema）：作品级数据，内核零内置内容（设计文档 §19） ──
// 上一版把讨论里随手举的例子（西装/手枪/食物/友善…）写进了产品代码；现在全部删除：
// 引擎只认六种原语，标签/需求/情绪/affordance/反应/关系全部是作者定义的作品数据。
// 新作品 schema 为空，舞台照样能跑（走动/张望），但不会出现任何题材内容。

/** 标签载体：人物 / 环境（关系另有 SimRelationDef，语义字段不同） */
export type SimTagScope = 'character' | 'env';
/** 标签角色：trait=属性/物品/能力，need=需求，emotion=情绪，affordance=环境交互，narrative=纯叙述 */
export type SimTagRole = 'trait' | 'need' | 'emotion' | 'affordance' | 'narrative';
/** 可感知性（感知原语）：always=一眼看到；near=进入感知范围；concealed=靠近或张望才发现 */
export type SimTagVisibility = 'always' | 'near' | 'concealed';
/** 立场（反应/关系原语）：approach=靠近，avoid=远离，talk=靠近并交谈 */
export type SimStanceKind = 'approach' | 'avoid' | 'talk';

/** 需求参数（need 角色）：0-100 标尺 + 每拍增长 + 阈值 + 紧急阈值 + 非 affordance 缓解来源 */
export interface SimNeedParams {
  /** 初值（0-100） */
  initial: number;
  /** 每拍增长（0-20） */
  growth: number;
  /** 达到后主动满足 */
  threshold: number;
  /** 达到后进入紧急层（100=不设紧急层） */
  emergency: number;
  /** 无环境交互时的缓解来源与每次缓解量（新颖度/张望/社交） */
  relievers?: Partial<Record<'novelty' | 'observe' | 'social', number>>;
}

/** 情绪参数（emotion 角色）：0-100 + 每拍衰减；达到 breakThreshold 触发 stance，低于 clearThreshold 清除 */
export interface SimEmotionParams {
  initial: number;
  decay: number;
  breakThreshold: number;
  clearThreshold: number;
  /** 情绪自身驱动的立场（反应规则未指定 stance 时使用） */
  stance?: SimStanceKind | 'none';
}

/** 环境交互参数（affordance 角色）：满足哪项需求、耗时、缓解量、可用次数、可用时段 */
export interface SimAffordanceParams {
  /** 引用 role=need 的标签 id */
  needId: string;
  /** 每次缓解量（0-100） */
  relief: number;
  /** 耗时（拍） */
  duration: number;
  /** 可用次数（运行时每个环境独立计数；缺省=不限） */
  uses?: number;
  /** 仅在这些时间相位可用（空/缺省=全天） */
  activePhases?: string[];
}

export interface SimNarrativeParams {
  /** 首次注意/进入时的事件文案（{env} 替换为环境名） */
  discoverText?: string;
}

/** 标签定义（作品级） */
export interface SimTagDef {
  /** 作品内唯一 id（≤64，不含空白；创建后不建议改） */
  id: string;
  name: string;
  icon?: string;
  scope: SimTagScope;
  role: SimTagRole;
  desc?: string;
  /** trait：可感知性 */
  visibility?: SimTagVisibility;
  /** trait：撤销的能力（仅识别 move:walk） */
  revokes?: string[];
  /** trait：授予的移动模式 */
  grantsMove?: { mode: 'walk' | 'fly'; speedMultiplier: number };
  /** need 参数 */
  need?: SimNeedParams;
  /** emotion 参数 */
  emotion?: SimEmotionParams;
  /** affordance 参数（scope=env） */
  affordance?: SimAffordanceParams;
  /** narrative 参数（scope=env） */
  narrative?: SimNarrativeParams;
}

/** 反应规则（原语 6）：观察到 triggerTag（+自身满足 selfTag）→ 情绪Δ/需求Δ/立场 + 事件文案 */
export interface SimReactionDef {
  id: string;
  /** 触发载体：观察到的人物标签（actor）或进入/看见的环境标签（env） */
  triggerScope: 'actor' | 'env';
  triggerTag: string;
  /** 观察者自身必须携带的 trait（如「喜欢某类人」才起反应） */
  selfTag?: string;
  emotion?: { defId: string; delta: number };
  need?: { defId: string; delta: number };
  stance?: { kind: SimStanceKind; emotionRef?: string };
  /** 事件文案（{target}/{env} 模板）；缺省用系统泛化文案 */
  text?: string;
  /** 同类规则再次触发的最小间隔（拍，0-120） */
  cooldown?: number;
  /** 越大越优先（-100~100） */
  priority?: number;
}

/** 关系定义（作品级）：关系标签的语义——stance + 数值门槛 + 社交距离/耗时 */
export interface SimRelationDef {
  id: string;
  name: string;
  icon?: string;
  desc?: string;
  /** 同场时的立场：approach/avoid/talk/none */
  stance: SimStanceKind | 'none';
  /** 越大越优先（多标签时取第一个有效 stance） */
  priority?: number;
  /** 关系数值门槛（缺省 0/100） */
  minValue?: number;
  maxValue?: number;
  /** talk 立场耗时（拍，缺省 2） */
  talkDuration?: number;
  /** talk 立场直接交谈距离（缺省引擎常量） */
  talkDistance?: number;
}

/** 时间相位（0-1 归一化一天内的半开区间 [from,to)） */
export interface SimTimePhase {
  id: string;
  name: string;
  from: number;
  to: number;
}

/** 时间维度：一天多少拍 + 相位表；缺省=单相「全天」 */
export interface SimTimeDef {
  ticksPerDay: number;
  phases: SimTimePhase[];
}

/** 🎬 作品级推演定义库：空对象=零内容（新作品默认） */
export interface SimSchema {
  tags: SimTagDef[];
  reactions: SimReactionDef[];
  relations: SimRelationDef[];
  time?: SimTimeDef;
}

// ── 🎬 推演档案（SimProfile）：与人物档案物理分离的数值数据（设计文档 §6，D20） ──
// 人物档案（WorkCharacter/CharacterState）= 叙事身份，给人看；推演档案 = 数值行为，给引擎跑。
// 两者只通过 characterId 关联，各自 sanitize、各自脏检查；推演结果不回写人物档案。

/** 基础能力（世界模型原生，固定三项，不可增量扩展；作者只调数值不定义语义） */
export interface SimCapabilities {
  /** 移动速度（px/拍），默认 80 */
  speed: number;
  /** 感知范围（px），默认 400 */
  perception: number;
  /** 观察力（0-100），默认 50：张望耗时 = OBSERVE_BASE / (0.5 + observation/100) */
  observation: number;
}

/** 需求实例：引用 schema 中 role=need 的定义，可逐人物启停/调初值/覆盖增长与阈值 */
export interface SimNeedInstance {
  defId: string;
  /** 初值（0-100）；缺省=定义默认 */
  intensity?: number;
  /** 每拍增长；缺省=定义默认 */
  growthPerTick?: number;
  /** 触发阈值；缺省=定义默认 */
  threshold?: number;
  /** 紧急阈值；缺省=定义默认 */
  emergency?: number;
  enabled: boolean;
}

/** 🏷 标签实例（统一标签内核，设计文档 §19.3）：引用定义库中 scope=character 的 trait/emotion。
 *  value 只对 emotion 有意义（情绪初值/当前覆盖）；trait 只用 defId。 */
export interface SimTagInstance {
  defId: string;
  /** 0-100（情绪初值等）；缺省=定义默认 */
  value?: number;
}

/** 🔗 人物关系边（作品级有向图，设计文档 §19.3 / D25）：from 对 to 的看法（标签 + 好感值）。
 *  与画布连线无关（画布 edge 表达通道）；只通过 characterId 关联人物库，随作品存档。
 *  反向看法是另一条边——A 对 B 友善，不代表 B 对 A 友善。 */
export interface SimRelation {
  /** 人物 characterId */
  from: string;
  /** 人物 characterId */
  to: string;
  /** 关系标签（引用 schema.relations），最多 3 条 */
  tags: string[];
  /** 好感 0-100（缺省 50）；关系定义的 min/max 门槛消费它 */
  value?: number;
}

/** 人物推演档案：一个作品内每人物一份，创建人物时自动建立（设计文档 §6.4） */
export interface SimProfile {
  characterId: string;
  capabilities: SimCapabilities;
  /** 🏷 人物标签（trait + emotion 实例）；need 走下面的 needs */
  tags?: SimTagInstance[];
  /** 需求实例（schema 中每个 need 定义一条） */
  needs: SimNeedInstance[];
}

/** 🚪 画布通道（环境↔环境连线）的数据：显式空间拓扑 */
export interface SimPortalData extends Record<string, unknown> {
  kind?: 'portal';
  name?: string;
  /** 锁闭（锁住的门/断掉的路：寻路不可过） */
  locked?: boolean;
  /** 穿过额外耗时（拍，0-10） */
  traverseCost?: number;
  /** 单向通道（只能 from→to） */
  oneWay?: boolean;
  /** 路点（画布绝对坐标）；缺省取两端环境中心中点 */
  waypoint?: { x: number; y: number };
}

/** 🗂 卷画布（v2.29）：一张画布 = 一个卷的舞台；默认主画布收纳未分卷章节/旧单画布。
 *  `boards` 是节点的唯一权威数据源，React Flow 只渲染 activeBoardId 指向的一张。 */
export interface SimBoard {
  id: string;
  /** 🎬 板类型：'stage' = 剧情推演舞台（作品内固定一张，不参与卷派生）；undefined = 默认主画布/卷画布 */
  kind?: 'stage';
  /** 关联的卷 id；undefined = 默认主画布 */
  volumeId?: string;
  nodes: SimNodeType[];
  edges: Edge[];
  /** 📐 章节区域（v2.31）：画布注释对象，不参与节点/AI；旧数据由 sanitize 补 [] */
  regions: ChapterRegion[];
  viewport?: SimViewport;
}
