import type { Node } from '@xyflow/react';

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

/** 人物节点：胶囊上显示 头像+人名+年龄（如「李刚 32」，永远浮在环境节点之上）；
 *  性别/年龄是节点基础属性（性别决定头像与节点颜色）；人物设定分两层（v2.27）——
 *  基础信息 basicInfo（长相/身材/习惯穿搭/性格）与身份信息 identityInfo（职业/身份/与故事相关的特殊设计），
 *  另有关系信息 relations（人物间关系，编辑室可填充、随机生成默认不写）；均在属性面板编辑 */
export interface CharacterData extends Record<string, unknown> {
  kind: 'character';
  name: string;
  gender: CharacterGender;
  /** 年龄（v2.20 基础属性，可选）：节点上跟在人名后显示（如「李刚 32」） */
  age?: number;
  /** 基础信息（v2.27）：长相、身材、习惯穿搭、性格——人物本身的样子与性情 */
  basicInfo: string;
  /** 身份信息（v2.27）：职业、身份、与故事相关的特殊设计——人物在世界中的位置与钩子 */
  identityInfo: string;
  /** 关系信息（v2.20，可选）：与其他人物之间的关系（如父子/仇敌/师徒）；随机人物生成默认不写，编辑室按用户要求填充 */
  relations?: string;
  /** 形象（v2.21，可选）：服务器人物素材库的素材 id；未设置 = 默认素材（DEFAULT_CHARASSET） */
  avatar?: string;
  // 🎨 写真图（v2.19b）不存节点数据——存浏览器 IndexedDB（services/localImages.ts，key=portrait:<nodeId>），
  // 避免进服务器存档留引用（media GC 会回收无引用文件；图片本体保留在用户本地）
}

/** 环境节点：地图摆放单元兼容器——可表达建筑/房间/社区/城镇等，自由拖放定位（v2.18 增 床=可住人的容器 / 物品=非容器标记）；
 *  可用 NodeResizer 缩放（尺寸存 node.width/height），可用 RF12 parentId 嵌套（镇>建筑>房间…，子节点随父移动） */
export interface EnvironmentData extends Record<string, unknown> {
  kind: 'environment';
  name: string;
  etype: EnvironmentType;
  desc: string;
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
}
