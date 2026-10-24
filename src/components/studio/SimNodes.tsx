/** 创作台节点：🧑 人物（人物卡片：形象+人名+年龄，zIndex 恒顶层）+ 🏗 环境（可缩放容器，RF12 parentId 嵌套层级）。
 *  节点面上**只展示不输入**：人名/环境名/类型/描述一律在左侧属性面板（SimInspector）编辑——
 *  节点内嵌输入框极易误入输入态、难拖拽（v2.3 用户反馈），现在整面都可拖拽。
 *  环境拖到别的环境节点里即成为其子节点（随父移动），拖出回根层（判定在 StudioPage onNodeDragStop）。
 *  v2.18：环境按类型取清淡配色与图标（ENV_TYPE_META——房间/建筑/社区/城镇/区域/床/物品），物品不是容器。
 *  当前阶段仅创建/摆位/嵌套；连线语义随规则系统需求定义（暂无 Handle）。 */
import type { ComponentType } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { BedDouble, Blocks, Building2, DoorOpen, Landmark, Map, Package, X } from 'lucide-react';
import { useStudioStore, ENV_MIN_W, ENV_MIN_H } from '../../stores/studioStore';
import { charAssetUrl, DEFAULT_CHARASSET } from '../../services/charAssetApi';
import {
  ENV_TYPE_LABELS,
  ENV_TYPE_META,
  genderOf,
  type CharacterData,
  type CharacterGender,
  type EnvironmentData,
  type EnvironmentType,
} from '../../types/sim';
import { activeCharacterState } from '../../stores/characterStates';
import { characterReferenceSummary, referenceChapterText } from '../../stores/snapshotRefs';

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

/** 🚻 性别 → 头像/胶囊配色/人名文字色/MiniMap 点色（人物节点与属性面板共用；男蓝=默认 / 女玫红） */
export const GENDER_STYLE: Record<CharacterGender, { avatar: string; label: string; capsule: string; text: string; dot: string }> = {
  male: { avatar: '👨', label: '男', capsule: 'border-blue-300/60 bg-blue-600', text: 'text-blue-600', dot: '#2563eb' },
  female: { avatar: '👩', label: '女', capsule: 'border-rose-300/60 bg-rose-500', text: 'text-rose-500', dot: '#f43f5e' },
};

// ── 人物节点：人物卡片（素材图原尺寸 64×64 透明显示，下方人名+年龄；人名色按性别区分；仅展示，编辑在属性面板；永远浮在环境之上——zIndex 由 store 恒置 CHAR_ZINDEX） ──

export function SimCharacterNode({ id, data }: NodeProps) {
  const d = data as CharacterData;
  const g = GENDER_STYLE[genderOf(d.gender)];
  const state = activeCharacterState(d);
  const ageTxt = typeof state.age === 'number' && Number.isFinite(state.age) && state.age > 0 ? ` ${state.age}` : '';
  return (
    <div className="group relative flex min-w-[84px] flex-col items-center rounded-xl px-2 pb-1.5 pt-1.5">
      <img
        src={charAssetUrl(state.avatar || DEFAULT_CHARASSET)}
        alt=""
        width={64}
        height={64}
        draggable={false}
        onError={(e) => {
          // 形象素材已被删除 → 回落默认素材
          const img = e.currentTarget;
          if (img.dataset.fallback) return;
          img.dataset.fallback = '1';
          img.src = charAssetUrl(DEFAULT_CHARASSET);
        }}
        className="h-16 w-16 shrink-0"
        style={{ imageRendering: 'pixelated' }}
      />
      <span className={`max-w-[128px] truncate text-xs font-semibold ${g.text}`}>
        {d.name || '未命名'}
        {ageTxt && <span className="font-normal opacity-80">{ageTxt}</span>}
      </span>
      {d.states.length > 1 && (
        <span
          className="mt-0.5 max-w-[128px] truncate rounded-full bg-white/85 px-1.5 text-[10px] leading-4 text-slate-500 shadow-sm ring-1 ring-slate-200/70"
          title={`当前状态：${state.label}（共 ${d.states.length} 个状态）`}
        >
          {state.label}
        </span>
      )}
      <button
        onClick={() => {
          const s = useStudioStore.getState();
          const ref = characterReferenceSummary(s.chapters, s.activeBoardId, id);
          const impact = ref.count
            ? `\n\n该人物被 ${ref.count} 章引用：${referenceChapterText(ref, 6)}。删除后这些章节的名单会显示「资料缺失」，快照不会自动更新。`
            : '';
          if (window.confirm(`删除人物「${d.name || '未命名'}」？${impact}`)) s.deleteNode(id);
        }}
        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-600 text-white opacity-0 shadow transition hover:bg-rose-500 group-hover:opacity-100"
        title="删除本人物"
        aria-label="删除本人物"
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
  return (
    <>
      {/* 选中后显示缩放柄（写 node.width/height，经 dimensions change 进 store 持久化）；柄色随类型 */}
      <NodeResizer isVisible={selected} minWidth={ENV_MIN_W} minHeight={ENV_MIN_H} color={meta.dot} />
      <div className={`group flex h-full w-full flex-col overflow-hidden rounded-xl border-2 shadow-md ${meta.border} ${meta.body}`}>
        {/* 标题条：图标 + 名称 + 类型徽章 + 删除（悬停出现）——均只展示，编辑走属性面板；配色随类型（清淡） */}
        <div className={`flex shrink-0 items-center gap-1 px-1.5 py-1 ${meta.bar}`}>
          <EnvIcon className="h-3.5 w-3.5 shrink-0 text-white/90" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-white">{d.name || '未命名'}</span>
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
            onClick={() => { if (window.confirm(`删除环境「${d.name || '未命名'}」？（其内部节点将提升回画布根层）`)) useStudioStore.getState().deleteNode(id); }}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-white/60 opacity-0 transition hover:bg-black/20 hover:text-white group-hover:opacity-100"
            title="删除本环境（内部节点提升回根层）"
            aria-label="删除本环境"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        {/* 描述不在画布上展示（避免小节点里文字拥挤凌乱）：只在属性面板查看/编辑 */}
        <div className="min-h-0 flex-1" />
      </div>
    </>
  );
}

/** RF 节点类型注册 */
export const simNodeTypes = {
  character: SimCharacterNode,
  environment: SimEnvironmentNode,
};
