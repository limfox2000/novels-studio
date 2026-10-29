/** 创作台节点：🧑 人物（放置卡片：圆形头像+人名+年龄，属性读人物库 v3，zIndex 恒顶层）+ 🏗 环境（可缩放容器，RF12 parentId 嵌套层级）。
 *  节点面上**只展示不输入**：人名/环境名/类型/描述一律在左侧属性面板（SimInspector）编辑——
 *  节点内嵌输入框极易误入输入态、难拖拽（v2.3 用户反馈），现在整面都可拖拽。
 *  环境拖到别的环境节点里即成为其子节点（随父移动），拖出回根层（判定在 StudioPage onNodeDragStop）。
 *  v2.18：环境按类型取清淡配色与图标（ENV_TYPE_META——房间/建筑/社区/城镇/区域/床/物品），物品不是容器。
 *  当前阶段仅创建/摆位/嵌套；连线语义随规则系统需求定义（暂无 Handle）。 */
import type { ComponentType } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { BedDouble, Blocks, Building2, DoorOpen, Landmark, Lock, LockOpen, Map, Package, X } from 'lucide-react';
import { useStudioStore, ENV_MIN_W, ENV_MIN_H } from '../../stores/studioStore';
import { CharacterAvatar } from './CharacterAvatar';
import { useSimSessionStore } from '../../stores/simSessionStore';
import { SIM_BEHAVIOR_LABELS } from '../../engines/simRunner';
import { SIM_BEHAVIOR_STYLE } from './StageSimBar';
import {
  ENV_TYPE_LABELS,
  ENV_TYPE_META,
  genderOf,
  type CharacterGender,
  type CharacterPlacementData,
  type EnvironmentData,
  type EnvironmentType,
} from '../../types/sim';
import { characterActiveState } from '../../stores/characterStates';
import { characterReferenceSummary, referenceChapterText } from '../../stores/snapshotRefs';
import { tagDefOf } from '../../stores/simTags';

/** 环境类型 → 线性图标（节点标题条用；ENV_TYPE_META.icon 的 emoji 仍供提示词/生成内容使用） */
const ENV_ICON: Record<EnvironmentType, ComponentType<{ className?: string }>> = {
  room: DoorOpen,
  building: Building2,
  community: Blocks,
  town: Landmark,
  area: Map,
  bed: BedDouble,
  item: Package,
};

/** 🚻 性别 → 胶囊配色/人名文字色/MiniMap 点色（人物节点与属性面板共用；男蓝=默认 / 女玫红） */
export const GENDER_STYLE: Record<CharacterGender, { label: string; capsule: string; text: string; dot: string }> = {
  male: { label: '男', capsule: 'border-blue-300/60 bg-blue-600', text: 'text-blue-600', dot: '#2563eb' },
  female: { label: '女', capsule: 'border-rose-300/60 bg-rose-500', text: 'text-rose-500', dot: '#f43f5e' },
};

// ── 人物节点：放置卡片（圆形头像 64×64 + 下方人名+年龄；人名/性别/状态读人物库——作品级身份，画布节点只是放置；
//    永远浮在环境之上——zIndex 由 store 恒置 CHAR_ZINDEX） ──

export function SimCharacterNode({ id, data }: NodeProps) {
  const d = data as CharacterPlacementData;
  // 订阅库记录：人物属性/状态在库中修改时，所有画布的放置同步刷新
  const character = useStudioStore((s) => s.characters[d.characterId]);
  const gender = genderOf(character?.gender);
  const g = GENDER_STYLE[gender];
  const state = character ? characterActiveState(character, d.activeStateId) : undefined;
  // 🎬 推演中：订阅本放置对应的 actor 行为（无会话/未参演 → undefined，节点外观不变）
  const simBehavior = useSimSessionStore((s) => s.session?.actors.find((a) => a.nodeId === id)?.behavior);
  if (!character || !state) {
    // 悬空放置理论上被 sanitize 滤除；兜底占位，仍可移除
    return (
      <div className="group relative flex min-w-[84px] flex-col items-center rounded-xl px-2 pb-1.5 pt-1.5" data-character-id={d.characterId}>
        <span className="text-xs text-slate-400">未知人物</span>
        <button
          onClick={() => useStudioStore.getState().deleteNode(id)}
          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-600 text-white opacity-0 shadow transition hover:bg-rose-500 group-hover:opacity-100"
          title="移除本放置"
          aria-label="移除本放置"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }
  const ageTxt = typeof state.age === 'number' && Number.isFinite(state.age) && state.age > 0 ? ` ${state.age}` : '';
  return (
    <div className="group relative flex min-w-[84px] flex-col items-center rounded-xl px-2 pb-1.5 pt-1.5" data-character-id={d.characterId}>
      <CharacterAvatar image={state.image} gender={gender} stateId={state.id} size={64} />
      <span className={`mt-1 max-w-[128px] truncate text-xs font-semibold ${g.text}`}>
        {character.name || '未命名'}
        {ageTxt && <span className="font-normal opacity-80">{ageTxt}</span>}
      </span>
      {character.states.length > 1 && (
        <span
          className="mt-0.5 max-w-[128px] truncate rounded-full bg-white/85 px-1.5 text-[10px] leading-4 text-slate-500 shadow-sm ring-1 ring-slate-200/70"
          title={`当前状态：${state.label}（共 ${character.states.length} 个状态）`}
        >
          {state.label}
        </span>
      )}
      {/* 🎬 推演行为气泡：只在有会话时出现（data-sim-behavior 供 E2E 断言） */}
      {simBehavior && (
        <span
          data-sim-behavior={simBehavior}
          className={`mt-0.5 whitespace-nowrap rounded-full px-1.5 text-[10px] leading-4 shadow-sm ring-1 ${SIM_BEHAVIOR_STYLE[simBehavior].chip}`}
          title={`推演行为：${SIM_BEHAVIOR_LABELS[simBehavior]}`}
        >
          {SIM_BEHAVIOR_STYLE[simBehavior].icon} {SIM_BEHAVIOR_LABELS[simBehavior]}
        </span>
      )}
      <button
        onClick={() => {
          // C5：画布删除 = 仅移除放置。人物记录/形象保留在人物库，其它画布放置不受影响
          const s = useStudioStore.getState();
          const ref = characterReferenceSummary(s.chapters, d.characterId);
          const impact = ref.count
            ? `\n\n该人物被 ${ref.count} 章引用：${referenceChapterText(ref, 6)}；被移除的画布若是某章的工作画布，该章场景会随之自动同步（历史章节保留采集记录）。`
            : '';
          if (window.confirm(`把「${character.name || '未命名'}」从本画布移除？人物与形象保留在人物库，其它画布不受影响。${impact}`)) s.deleteNode(id);
        }}
        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-600 text-white opacity-0 shadow transition hover:bg-rose-500 group-hover:opacity-100"
        title="从本画布移除（人物保留在库）"
        aria-label="从本画布移除"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// ── 环境节点：地图容器（房间/建筑/社区/城镇/区域/床/物品）——NodeResizer 缩放 + parentId 嵌套层级；面上仅展示 ──

export function SimEnvironmentNode({ id, data, selected }: NodeProps) {
  const d = data as EnvironmentData;
  const meta = ENV_TYPE_META[d.etype];
  const EnvIcon = ENV_ICON[d.etype];
  const locked = d.locked === true;
  return (
    <>
      {/* 选中后显示缩放柄（写 node.width/height，经 dimensions change 进 store 持久化）；锁定后隐藏；柄色随类型 */}
      <NodeResizer isVisible={selected && !locked} minWidth={ENV_MIN_W} minHeight={ENV_MIN_H} color={meta.dot} />
      <div
        data-env-id={id}
        className={`group flex h-full w-full flex-col overflow-hidden rounded-xl border-2 shadow-md ${meta.border} ${meta.body}`}
      >
        {/* 标题条：图标 + 名称 + 类型徽章 + 锁定 + 删除（悬停出现）——均只展示，编辑走属性面板；配色随类型（清淡）
            选中后拖动标题条/空白处移动环境；未选中时拖动空白处平移画布（节点由 StudioPage 设为不可拖动） */}
        <div
          className={`flex shrink-0 cursor-grab items-center gap-1 px-1.5 py-1 ${meta.bar}`}
          title={selected && !locked ? '拖动移动环境' : '点击选中后可拖动移动环境；未选中时拖动空白处平移画布'}
        >
          <EnvIcon className="h-3.5 w-3.5 shrink-0 text-white/90" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-white">{d.name || '未命名'}</span>
          {/* 🏷 环境标签（世界认知池）：如 🍚 提供食物 / 🛏 可睡 / 🗑 脏乱 */}
          {(d.tags ?? []).map((tagId) => {
            const def = tagDefOf(tagId);
            if (!def) return null;
            return (
              <span key={tagId} data-env-tag-chip={tagId} className="shrink-0 text-[11px] leading-none" title={`${def.name}：${def.desc}`}>
                {def.icon}
              </span>
            );
          })}
          <span
            className="shrink-0 whitespace-nowrap rounded-full bg-black/15 px-1.5 py-0.5 text-[11px] text-white"
            title={
              meta.container
                ? '环境类型（在属性面板可改）——容器，可容纳人物/子环境'
                : '环境类型（在属性面板可改）——物品不是容器，仅标记此处存在一个东西'
            }
          >
            {ENV_TYPE_LABELS[d.etype]}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              useStudioStore.getState().updateEnvironment(id, { locked: !locked });
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className={`nodrag nopan flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition hover:bg-black/20 hover:text-white ${
              locked ? 'bg-black/25 text-white' : 'text-white/60'
            }`}
            title={locked ? '解锁环境（当前已锁定：不能拖动/缩放）' : '锁定环境（防止误拖动画布时移动环境）'}
            aria-label={locked ? '解锁环境' : '锁定环境'}
            aria-pressed={locked}
            data-env-lock={locked ? '1' : '0'}
          >
            {locked ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`删除环境「${d.name || '未命名'}」？（其内部节点将提升回画布根层）`)) useStudioStore.getState().deleteNode(id);
            }}
            className="nodrag nopan flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-white/60 opacity-0 transition hover:bg-black/20 hover:text-white group-hover:opacity-100"
            title="删除本环境（内部节点提升回根层）"
            aria-label="删除本环境"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        {/* 描述不在画布上展示（避免小节点里文字拥挤凌乱）：只在属性面板查看/编辑
            未选中时整个节点不可拖动 → 此处拖动平移画布；选中后拖动移动环境 */}
        <div
          className="min-h-0 flex-1"
          style={{ cursor: selected && !locked ? 'grab' : 'default' }}
        />
      </div>
    </>
  );
}

/** RF 节点类型注册 */
export const simNodeTypes = {
  character: SimCharacterNode,
  environment: SimEnvironmentNode,
};
