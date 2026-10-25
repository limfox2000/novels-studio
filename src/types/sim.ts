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

/** 🚻 人物性别（基础属性）：male=男（默认）/ female=女；决定节点头像与配色（男蓝/女玫红，SimNodes.GENDER_STYLE） */
export type CharacterGender = 'male' | 'female';

/** 性别兜底：非 female 一律归默认男（sanitize 旧档案/损坏缓存共用；v2.13a 用户拍板不设「未设置」态） */
export function genderOf(v: unknown): CharacterGender {
  return v === 'female' ? 'female' : 'male';
}

/** 性别 → 中文标签（AI 注入用：主角简报/画布摘要/编辑室协议） */
export const GENDER_LABELS: Record<CharacterGender, string> = { male: '男', female: '女' };

/** 🧬 人物状态（v2.30）：同一人物随剧情变化的一套属性。
 *  人名/性别跨状态稳定，留在 CharacterData 顶层；其余属性与写真都属于状态。
 *  旧版平铺字段由 sanitize 自动迁入首项「状态0」，数据不丢。 */
export interface CharacterState {
  /** 状态 ID：人物内稳定；创建时首项固定 state0，新增用 uid。复制人物时保留 */
  id: string;
  /** 状态标签：默认「状态0」，新增建议「状态1/状态2」，可重命名（如「重伤后」）；人物内唯一 */
  label: string;
  /** 年龄（可选）：节点上跟在人名后显示（如「李刚 32」） */
  age?: number;
  /** 形象（v2.21，可选）：服务器人物素材库的素材 id；未设置 = 默认素材（DEFAULT_CHARASSET） */
  avatar?: string;
  /** 基础信息（v2.27）：长相、身材、习惯穿搭、性格——人物本身的样子与性情 */
  basicInfo: string;
  /** 身份信息（v2.27）：职业、身份、与故事相关的特殊设计——人物在世界中的位置与钩子 */
  identityInfo: string;
  /** 关系信息（v2.20，可选）：与其他人物之间的关系（如父子/仇敌/师徒） */
  relations?: string;
  /** 🎨 写真引用（v2.30）：浏览器 IndexedDB 的 key，不存图片本体。
   *  规范 key=portrait:<nodeId>:<stateId>；旧写真由迁移写在状态0 的 portrait:<nodeId>。undefined=该状态无写真 */
  portraitKey?: string;
}

/** 人物节点：胶囊上显示 头像+人名+年龄（如「李刚 32」，永远浮在环境节点之上）；
 *  人名/性别是跨状态稳定的基础属性（性别决定头像与节点颜色）；其余设定属于当前状态。
 *  所有属性读取必须走 stores/characterStates 的解析函数，不能直接读节点上的平铺字段（v2.30 已移除）。 */
export interface CharacterData extends Record<string, unknown> {
  kind: 'character';
  name: string;
  gender: CharacterGender;
  /** 至少一项；首项=默认状态「状态0」 */
  states: CharacterState[];
  /** 当前显示/编辑/章节生成使用的状态；非法值由 sanitize 回落首项 */
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
}

export type SimData = CharacterData | EnvironmentData;
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

/** 📸 本章名单条目：只存人物/状态引用与采集时标签，不复制完整属性（属性仍从画布解析） */
export interface ChapterSnapshotEntry {
  /** 人物身份 node.id */
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

/** 🗂 卷画布（v2.29）：一张画布 = 一个卷的舞台；默认主画布收纳未分卷章节/旧单画布。
 *  `boards` 是节点的唯一权威数据源，React Flow 只渲染 activeBoardId 指向的一张。 */
export interface SimBoard {
  id: string;
  /** 关联的卷 id；undefined = 默认主画布 */
  volumeId?: string;
  nodes: SimNodeType[];
  edges: Edge[];
  /** 📐 章节区域（v2.31）：画布注释对象，不参与节点/AI；旧数据由 sanitize 补 [] */
  regions: ChapterRegion[];
  viewport?: SimViewport;
}
