/** 🎭 编辑室右侧停靠面板（创作台页内浮层）：AI 对话搭建故事舞台。
 *  流式回复、停止/重生成/复制/删除/清空、⚙ 设置（列宽/压缩/📜附带规则与目标——v2.19 默认不注入规则/目标；模型与推理统一移到「模型中心」，v2.27）、历史持久化（nc2-sim-agent-v1）；
 *  回复带【人物设定】/【环境设定】块时气泡下方出「📎 落为人物/环境」按钮——创建节点、填好属性、
 *  落点在某环境内自动归入嵌套（与顶栏创建同语义）；块名与画布节点同名（或块带「更新：已有节点名」）时
 *  自动识别为修改，出「✏️ 更新…」，只覆盖块里写出的字段、未写字段保留原值（重名等无法判定才给下拉）；
 *  带【区域规划】块时出「📎 落为规划」——
 *  容器+N 座建筑整组落地，建筑按 AI 给的大小/位置摆好并自动成为容器子节点（v2.7）。
 *  关面板不中断生成，重开继续看流式进度。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useEditorRoomStore, type EditorRoomMessage, type EditorRoomSettings } from '../../stores/editorRoomStore';
import {
  useStudioStore,
  findContainerAt,
  findViewportDropPosition,
  findChildDropPosition,
  resolveBoardRef,
  boardLabel,
  ENV_DEFAULT_W,
  ENV_DEFAULT_H,
} from '../../stores/studioStore';
import { ENV_TYPE_LABELS, isContainerEnv, type EnvironmentData, type SimNodeType } from '../../types/sim';
import { useUiStore } from '../../stores/uiStore';
import { REASONING_EFFORT_LABEL } from '../../shared/qwenClient';
import { genImage, type EditorRoomBlock, type EditorStateBlock, type ResponsibleEditor, type SimBlock, type SimImageBlock, type SimPlanBlock, type SimVolumeBlock } from '../../engines/studioEngine';
import { activeCharacterState, characterStateIndex, DEFAULT_STATE_ID } from '../../stores/characterStates';
import { referenceChapterText, stateReferenceSummary } from '../../stores/snapshotRefs';
import { SimWriteButtons } from './SimWriteButtons';
import { pickRandomCharAsset } from '../../services/charAssetApi';
import { localImgDel, localImgGet, localImgSaveFromUrl } from '../../services/localImages';
import { EDITOR_MODULES, useEditorialStore } from '../../stores/editorialStore';
import { MeetingView } from './MeetingView';
import { EditorialDeptDialog } from './EditorialDeptDialog';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Segmented } from '../ui/Segmented';
import { Switch } from '../ui/Switch';
import {
  AlertTriangle,
  Archive,
  BookOpen,
  Brain,
  Check,
  Copy,
  Cpu,
  FlaskConical,
  ImageIcon,
  Layers,
  Loader2,
  MessagesSquare,
  PenLine,
  Plus,
  RotateCcw,
  ScanText,
  Send,
  Settings2,
  Square,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { LongTextAnalysisPanel } from './LongTextAnalysisPanel';

/** 极简排版：转义后仅渲染 **加粗**（配合 whitespace-pre-wrap 保留换行） */
function fmt(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

/** token 数缩写：1234 → 1.2K，1234567 → 1.2M */
// 人物节点渲染前没有实测尺寸：落点居中/避让按经验尺寸估算（与 StudioPage 一致）
const CHAR_NOMINAL_SIZE = { w: 144, h: 104 };

/** 节点名归一化（去引号/空白/前置类型词），用于把设定块名字/「更新：」目标与画布节点对上 */
function normNodeName(s: string | undefined): string {
  return (s || '').replace(/[「」『』《》"'“”]/g, '').replace(/\s+/g, '').replace(/^(?:人物|环境)/, '');
}

/** 「所在」路径拆分：「清风镇＞铁匠铺」→ ['清风镇','铁匠铺']（兼容 ＞ / > / → / 斜杠） */
function splitEnvRef(ref: string): string[] {
  return ref
    .split(/[＞>→/／]/)
    .map((s) => normNodeName(s))
    .filter(Boolean);
}

/** 按环境名/层级路径定位画布上的容器环境：路径匹配祖先链末尾，同名环境可用「镇＞建筑」区分。
 *  只返回可容纳子节点的容器（物品不算）。 */
type EnvNode = SimNodeType & { data: EnvironmentData };
function findEnvByRef(nodes: SimNodeType[], ref: string | undefined): EnvNode[] {
  const segs = ref ? splitEnvRef(ref) : [];
  if (!segs.length) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pathOf = (n: SimNodeType): string[] => {
    const out: string[] = [];
    const guard = new Set<string>();
    let cur: SimNodeType | undefined = n;
    while (cur && cur.data.kind === 'environment' && !guard.has(cur.id)) {
      guard.add(cur.id);
      out.unshift(normNodeName(cur.data.name));
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out;
  };
  // 兼容 AI 在名字前带上类型词（「建筑铁匠铺」）：路径名与引用词两侧都试一次去前缀
  const stripType = (s: string) => s.replace(/^(?:房间|建筑|社区|城镇|区域|床|物品)/, '');
  return nodes.filter((n) => {
    if (n.data.kind !== 'environment' || !isContainerEnv(n.data.etype)) return false;
    const path = pathOf(n);
    if (path.length < segs.length) return false;
    const tail = path.slice(path.length - segs.length);
    return tail.every((name, i) => name === segs[i] || stripType(name) === segs[i] || name === stripType(segs[i]));
  }) as EnvNode[];
}

/** 更新目标下拉的展示名：同名环境用「所在环境」区分 */
function nodeOptionLabel(n: SimNodeType, nodes: SimNodeType[]): string {
  const name = n.data.name || '未命名';
  const parent = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined;
  return parent && parent.data.kind === 'environment' ? `${name}（在${parent.data.name || '未命名'}内）` : name;
}

function fmtK(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

const QUICK_PROMPTS = [
  '帮我设计一个完整的小镇：3 个地点 + 2 个住民',
  '给镇上设计 3 个人物（含基础信息与身份信息）',
  '规划一个五户人家的小村，含整体布局',
  '头脑风暴：这块地图适合讲什么故事',
];

/** 聊天列宽档位（像素上限；全宽=跟随面板） */
const WIDTH_PX: Record<EditorRoomSettings['chatWidth'], number | undefined> = { narrow: 420, medium: 500, wide: 560, full: undefined };

// ── 上下文用量条（usage 来自上游精确值；nCtx 来自模型读取，未知则不显示） ──

function UsageMeter() {
  const usage = useEditorRoomStore((s) => s.usage);
  if (!usage || !usage.nCtx) return null;
  const used = usage.promptTokens + usage.completionTokens;
  const pct = used / usage.nCtx;
  const color = pct > 0.92 ? 'bg-rose-500' : pct > 0.8 ? 'bg-amber-500' : 'bg-brand-400';
  return (
    <div className="flex items-center gap-2 px-3 py-1" title="本轮对话占模型上下文的比例（上游 usage 精确统计）">
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(100, pct * 100).toFixed(1)}%` }} />
      </div>
      <span className={`text-[12px] tabular-nums whitespace-nowrap ${pct > 0.92 ? 'text-rose-600' : pct > 0.8 ? 'text-amber-600' : 'text-slate-400'}`}>
        {fmtK(used)} / {fmtK(usage.nCtx)} · 剩 {Math.max(0, Math.round((1 - pct) * 100))}%
      </span>
    </div>
  );
}

// ── ⚙ 设置弹层（列宽 / 压缩 / 附带规则；模型与推理统一在「模型中心」） ──

function SettingsPop({ onClose }: { onClose: () => void }) {
  const settings = useEditorRoomStore((s) => s.settings);
  const compactBusy = useEditorRoomStore((s) => s.compactBusy);
  const busy = useEditorRoomStore((s) => s.busy);
  const generating = useUiStore((s) => s.generating);
  const msgCount = useEditorRoomStore((s) => s.messages.length);
  const usage = useEditorRoomStore((s) => s.usage);
  const [msg, setMsg] = useState('');

  const doCompact = async () => {
    const okFlag = await useEditorRoomStore.getState().compact();
    if (okFlag) setMsg('已压缩：更早对话替换为摘要');
  };

  const rootRef = useRef<HTMLDivElement>(null);
  // 点击外部关闭（触发按钮本身除外：避免 mousedown 关掉后 click 又打开）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      // 齿轮按钮在设置层外部，点击它交给 onClick 做开/关切换（否则先关后开，永远关不掉）
      if (rootRef.current?.contains(target) || target.closest('[title^="对话设置"]')) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className="absolute right-3 top-[84px] z-10 max-h-[calc(100%-96px)] w-[280px] overflow-y-auto rounded-[12px] border border-slate-200 bg-white p-3 shadow-float"
    >
      <div className="mb-2.5 flex items-center gap-1.5">
        <Settings2 className="h-4 w-4 text-slate-400" />
        <span className="flex-1 text-[13px] font-semibold text-slate-700">对话设置</span>
        <IconButton icon={<X />} title="关闭设置" onClick={onClose} />
      </div>

      {/* 模型与推理：统一在「模型中心」配置（v2.27），这里只显示摘要并跳转 */}
      <div className="mb-2.5 rounded-[8px] bg-slate-50 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-slate-600">
              {settings.engine === 'public' ? '🌐 公共模型' : '🏠 私有模型'} · 推理：{REASONING_EFFORT_LABEL[settings.reasoningEffort]}
            </div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-slate-400">
              模型地址、密钥、引擎与推理强度在模型中心统一管理
            </div>
          </div>
        </div>
        <Button
          variant="soft"
          size="sm"
          icon={<Cpu />}
          className="mt-2 w-full"
          onClick={() => {
            useUiStore.getState().setModelCenterOpen(true);
            onClose();
          }}
        >
          打开模型中心
        </Button>
      </div>

      {/* 聊天列宽 */}
      <div className="mb-2.5">
        <div className="mb-1 text-[12px] font-medium text-slate-500">聊天列宽</div>
        <Segmented
          value={settings.chatWidth}
          onChange={(v) => useEditorRoomStore.getState().setSettings({ chatWidth: v })}
          options={[
            { value: 'narrow' as const, label: '窄', title: '最宽 420px' },
            { value: 'medium' as const, label: '中', title: '最宽 500px' },
            { value: 'wide' as const, label: '宽', title: '最宽 560px' },
            { value: 'full' as const, label: '全宽', title: '跟随面板宽度' },
          ]}
          className="w-full [&>button]:flex-1"
        />
      </div>

      {/* 自动压缩 */}
      <div className="mb-2 flex items-center justify-between gap-2 rounded-[8px] bg-slate-50 px-2.5 py-1.5">
        <span className="text-[12px] text-slate-600" title="上下文用量超 92% 时自动把更早对话压缩为摘要（摘要继续作为记忆注入）">
          自动压缩上下文
        </span>
        <Switch checked={settings.autoCompact} onChange={(v) => useEditorRoomStore.getState().setSettings({ autoCompact: v })} />
      </div>

      {/* 附带规则与目标（v2.19 默认关：编辑室是创意环境不被默认约束；开启后 AI 才能按需读到规则/目标） */}
      <div className="mb-2 flex items-center justify-between gap-2 rounded-[8px] bg-slate-50 px-2.5 py-1.5">
        <span
          className="text-[12px] text-slate-600"
          title="默认关——编辑室完全自由创意，规则/目标不注入。开启后把 全文目标/全文规则/章节大纲规则/人物生成规则 作为【项目资料】提供（仅按需参考，不构成默认约束）"
        >
          附带规则与目标
        </span>
        <Switch checked={settings.carryRules} onChange={(v) => useEditorRoomStore.getState().setSettings({ carryRules: v })} />
      </div>

      {/* 作品责编在顶栏选择（v2.21）；编辑室（总编辑对话）话题命中时注入其职责与对应技能记忆 */}

      {/* 立即压缩 */}
      <Button
        variant="soft"
        size="sm"
        icon={compactBusy ? <Loader2 className="animate-spin" /> : <Archive />}
        onClick={() => void doCompact()}
        disabled={busy || compactBusy || generating || msgCount < 4}
        className="w-full"
        title="把更早的对话压缩成一份摘要（保留最近 6 条），摘要继续注入后续对话"
      >
        {compactBusy ? '压缩中…' : '立即压缩上下文'}
      </Button>
      {usage && usage.nCtx > 0 && (
        <div className="mt-1 text-center text-[12px] tabular-nums text-slate-400">
          本轮 {fmtK(usage.promptTokens)} 入 + {fmtK(usage.completionTokens)} 出
        </div>
      )}
      {msg && <div className="mt-1 break-all text-[12px] text-slate-500">{msg}</div>}
    </div>
  );
}

// ── 📎 设定块按钮行：「📎 落为人物 / 落为环境 / 落为规划」（逐块落，落过的置灰防重复） ──

const NO_NODES: SimNodeType[] = [];

function SimBlockDropRow({ msg }: { msg: EditorRoomMessage }) {
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [doneMsg, setDoneMsg] = useState('');
  const reactFlow = useReactFlow();
  const boards = useStudioStore((s) => s.boards);
  const volumes = useStudioStore((s) => s.volumes);
  const activeBoardId = useStudioStore((s) => s.activeBoardId);
  const nodes = useStudioStore((s) => s.boards[s.activeBoardId]?.nodes) ?? NO_NODES;
  if (!msg.blocks?.length) return null;

  // 🗂 卷目标解析：省略「卷：」= 当前画布；写错/重名绝不回退当前画布。
  const resolveBlockBoard = (b: { volume?: string }) => {
    // 用实时 store：批量落地时前一秒刚创建的节点/卷也要能被后续块看到
    const st = useStudioStore.getState();
    if (!b.volume) {
      const board = st.boards[st.activeBoardId];
      return board
        ? ({ board, label: boardLabel(board, st.volumes) } as const)
        : ({ error: '当前画布不存在' } as const);
    }
    const r = resolveBoardRef(st.boards, st.volumes, b.volume);
    if ('error' in r) return { error: r.message } as const;
    return { board: r.board, label: boardLabel(r.board, st.volumes) } as const;
  };

  // 视口中心落点（与顶栏 ＋人物/＋环境 一致：按节点尺寸居中，附近小范围错开，始终在可视区内）。
  // 指定非当前卷时用目标画布自己的视口/节点，不借用当前标签的视口。
  const dropPos = (size: { w: number; h: number }, board = boards[activeBoardId]) => {
    if (!board) return { x: 0, y: 0 };
    if (board.id === activeBoardId) {
      const tl = reactFlow.screenToFlowPosition({ x: 0, y: 0 });
      const br = reactFlow.screenToFlowPosition({ x: window.innerWidth, y: window.innerHeight });
      return findViewportDropPosition(board.nodes, { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }, size);
    }
    const vp = board.viewport;
    const visible = vp
      ? {
          x: -vp.x / vp.zoom,
          y: -vp.y / vp.zoom,
          w: window.innerWidth / vp.zoom,
          h: window.innerHeight / vp.zoom,
        }
      : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    return findViewportDropPosition(board.nodes, visible, size);
  };

  const boardSuffix = (board: { id: string }, label: string) =>
    board.id === activeBoardId ? '' : `，已落到「${label}」画布`;

  const drop = (b: EditorRoomBlock, i: number) => {
    setDoneMsg('');
    const rb = resolveBlockBoard(b);
    if ('error' in rb) {
      setDoneMsg(`⚠ ${rb.error}，未落地`);
      return;
    }
    const board = rb.board;
    const boardNodes = board.nodes;
    const st = useStudioStore.getState();
    const size = b.kind === 'character' ? CHAR_NOMINAL_SIZE : { w: ENV_DEFAULT_W, h: ENV_DEFAULT_H };
    // 📍「所在」：按名字/层级路径在目标画布定位父环境 → 容器内排位，创建后挂为其子节点（容器不够大则自动扩展）
    const parentHits = b.parent ? findEnvByRef(boardNodes, b.parent) : [];
    const parentNode = parentHits.length === 1 ? parentHits[0] : undefined;
    const childSpot = parentNode ? findChildDropPosition(boardNodes, parentNode.id, size) : undefined;
    const pos = childSpot?.pos ?? dropPos(size, board);
    const select = board.id === activeBoardId;
    const id =
      b.kind === 'character'
        ? st.createCharacterOnBoard(board.id, pos, { select })
        : st.createEnvironmentOnBoard(board.id, pos, undefined, { select });
    if (!id) {
      setDoneMsg('⚠ 目标画布不存在，未落地');
      return;
    }
    if (b.kind === 'character') {
      const gender = b.gender ?? 'male';
      st.updateCharacterOnBoard(board.id, id, { name: b.name, gender });
      // 新建人物固定先写默认状态「状态0」；显式 stateId，异步形象也不会写进用户后来切到的状态
      st.updateCharacterStateOnBoard(
        board.id,
        id,
        {
          ...(b.age ? { age: b.age } : {}),
          basicInfo: b.basicInfo ?? '',
          identityInfo: b.identityInfo ?? '',
          relations: b.relations,
        },
        DEFAULT_STATE_ID,
      );
      void pickRandomCharAsset(gender === 'female' ? '女' : '男', b.age)
        .then((avatar) => {
          if (avatar) useStudioStore.getState().updateCharacterStateOnBoard(board.id, id, { avatar }, DEFAULT_STATE_ID);
        })
        .catch(() => undefined);
    } else st.updateEnvironmentOnBoard(board.id, id, { name: b.name, desc: b.desc ?? '', etype: b.etype ?? 'building' });
    if (parentNode) {
      st.reparentNodeOnBoard(board.id, id, parentNode.id);
      if (childSpot?.grow) st.resizeEnvironmentOnBoard(board.id, parentNode.id, childSpot.grow.w, childSpot.grow.h);
    } else {
      const latest = useStudioStore.getState().boards[board.id]?.nodes ?? [];
      const container = findContainerAt(latest, pos.x + size.w / 2, pos.y + size.h / 2, id);
      if (container) st.reparentNodeOnBoard(board.id, id, container.id);
    }
    setDropped((prev) => new Set(prev).add(i));
    // 明确反馈落点：在指定环境内创建成功 / 所在环境没唯一找到（退回视口落点）
    const inParent =
      parentNode
        ? `，已创建在${ENV_TYPE_LABELS[parentNode.data.etype]}「${parentNode.data.name || '未命名'}」内`
        : b.parent && parentHits.length !== 1
          ? `（所在环境「${b.parent}」${parentHits.length > 1 ? '有多处同名' : '未找到'}，已按视口落点创建）`
          : '';
    setDoneMsg(
      (b.kind === 'character'
        ? `✓ 人物「${b.name}」已落为画布节点${inParent}`
        : `✓ 环境「${b.name}」已落为画布节点${inParent}`) + boardSuffix(board, rb.label),
    );
  };

  // ✏️ 更新已有节点：只覆盖块里写出的字段，未写字段保留原值（改名时「名字」写新名，target 仍是原名）
  const updateExisting = (b: EditorRoomBlock, i: number, node: SimNodeType) => {
    setDoneMsg('');
    const rb = resolveBlockBoard(b);
    if ('error' in rb) {
      setDoneMsg(`⚠ ${rb.error}，未更新`);
      return;
    }
    const board = rb.board;
    const st = useStudioStore.getState();
    const oldName = node.data.name || '未命名';
    // 名字同样按归一化比较：仅书写差异（空格/引号）不算改名，避免「同名修改」把节点名改掉
    const newName = b.name && b.name !== '未命名' && normNodeName(b.name) !== normNodeName(oldName) ? b.name : '';
    if (b.kind === 'character' && node.data.kind === 'character') {
      st.updateCharacterOnBoard(board.id, node.id, {
        ...(newName ? { name: newName } : {}),
        ...(b.gender ? { gender: b.gender } : {}),
      });
      // 旧【人物设定】块只改**当前状态**；要改指定状态必须用【人物状态】
      st.updateActiveCharacterStateOnBoard(board.id, node.id, {
        ...(b.age ? { age: b.age } : {}),
        ...(b.basicInfo?.trim() ? { basicInfo: b.basicInfo } : {}),
        ...(b.identityInfo?.trim() ? { identityInfo: b.identityInfo } : {}),
        ...(b.relations?.trim() ? { relations: b.relations } : {}),
      });
    } else if (b.kind === 'environment' && node.data.kind === 'environment') {
      st.updateEnvironmentOnBoard(board.id, node.id, {
        ...(newName ? { name: newName } : {}),
        ...(b.etype ? { etype: b.etype } : {}),
        ...(b.desc?.trim() ? { desc: b.desc } : {}),
      });
    } else return;
    // 📍「所在」也用于修改：把节点移入指定环境（重新定父级；目标环境须唯一）
    let moved = '';
    if (b.parent) {
      const hits = findEnvByRef(board.nodes, b.parent);
      const target = hits.length === 1 ? hits[0] : undefined;
      if (target && target.id !== node.id) {
        st.reparentNodeOnBoard(board.id, node.id, target.id);
        moved = `，已移入${ENV_TYPE_LABELS[target.data.etype]}「${target.data.name || '未命名'}」`;
      } else if (hits.length !== 1) {
        moved = `（所在环境「${b.parent}」${hits.length > 1 ? '有多处同名' : '未找到'}，未移动归属）`;
      }
    }
    setDropped((prev) => new Set(prev).add(i));
    const renamed = newName ? ` → 「${newName}」` : '';
    setDoneMsg(
      `✓ 已更新${b.kind === 'character' ? '人物' : '环境'}「${oldName}」${renamed}${moved}` +
        boardSuffix(board, rb.label),
    );
  };

  // 🧬 人物状态块落地：只操作目标画布上按名唯一匹配的已有人物（绝不创建人物；找不到/重名就禁用）
  const dropState = (b: EditorStateBlock, i: number) => {
    setDoneMsg('');
    if (b.parseError) {
      setDoneMsg(`⚠ 状态块未落地：${b.parseError}`);
      return;
    }
    const rb = resolveBlockBoard(b);
    if ('error' in rb) {
      setDoneMsg(`⚠ ${rb.error}，未落地`);
      return;
    }
    const board = rb.board;
    const st = useStudioStore.getState();
    const key = normNodeName(b.character);
    const hits = key ? board.nodes.filter((n) => n.data.kind === 'character' && normNodeName(n.data.name) === key) : [];
    if (hits.length !== 1) {
      setDoneMsg(
        `⚠ ${hits.length > 1 ? '目标画布有多个同名人物' : '目标画布上未找到该人物'}「${b.character}」，未落地`,
      );
      return;
    }
    const node = hits[0];
    if (node.data.kind !== 'character') return;
    const d = node.data;
    const err = (code: string) =>
      ({
        'not-found': '人物或状态不存在',
        'base-not-found': '要复制的基准状态不存在',
        'empty-label': '状态名不能为空',
        'duplicate-label': '人物内已有同名状态',
        protected: '默认状态（首项）不可删除',
        'last-state': '人物至少保留一个状态',
      })[code] || code;
    const opErr = (r: { ok: true } | { ok: false; error: string }): string => (r.ok ? '' : err(r.error));
    const patch = {
      ...(typeof b.age === 'number' ? { age: b.age } : {}),
      ...(b.basicInfo !== undefined ? { basicInfo: b.basicInfo } : {}),
      ...(b.identityInfo !== undefined ? { identityInfo: b.identityInfo } : {}),
      ...(b.relations !== undefined ? { relations: b.relations } : {}),
    };
    const target = b.state ? d.states.find((s) => s.label === b.state) : undefined;
    // R5：状态块落地前提示引用影响（只提示，不阻止）
    const impactTarget =
      b.action === 'update' ? (target ?? activeCharacterState(d))
      : b.action === 'rename' || b.action === 'delete' ? target
      : undefined;
    const impact = impactTarget ? stateReferenceSummary(st.chapters, board.id, node.id, impactTarget.id) : null;
    const impactText = impact?.count
      ? `\n\n该状态被 ${impact.count} 章引用：${referenceChapterText(impact, 6)}。${b.action === 'delete' ? '删除后这些章节在切回同步前会显示「资料缺失」' : '原地修改会改变这些历史章节的生成内容'}；章节场景会随画布自动同步。`
      : '';
    if (impactText && (b.action === 'update' || b.action === 'rename')) {
      const verb = b.action === 'update' ? '修改' : '重命名';
      if (!window.confirm(`将${verb}人物「${d.name || '未命名'}」的状态「${impactTarget!.label}」？${impactText}`)) return;
    }
    let ok = false;
    let msg = '';
    if (b.action === 'create') {
      const label = (b.state || '').trim();
      if (!label) {
        setDoneMsg('⚠ 新建状态缺少状态名，未落地');
        return;
      }
      if (d.states.some((s) => s.label === label)) {
        setDoneMsg(`⚠ 人物「${d.name || '未命名'}」已有状态「${label}」，未落地`);
        return;
      }
      const base = b.baseState ? d.states.find((s) => s.label === b.baseState) : activeCharacterState(d);
      if (!base) {
        setDoneMsg(`⚠ 基准状态「${b.baseState}」不存在，未落地`);
        return;
      }
      const r = st.addCharacterStateOnBoard(board.id, node.id, {
        label,
        baseStateId: base.id,
        patch,
        activate: true,
      });
      ok = r.ok;
      msg = ok
        ? `✓ 人物「${d.name || '未命名'}」新建状态「${label}」（复制自「${base.label}」），已切换为当前状态`
        : `⚠ 未新建状态：${opErr(r)}`;
    } else if (b.action === 'update') {
      const targetState = target ?? activeCharacterState(d);
      if (b.state && !target) {
        setDoneMsg(`⚠ 人物「${d.name || '未命名'}」没有状态「${b.state}」，未落地`);
        return;
      }
      const r = st.updateCharacterStateOnBoard(board.id, node.id, patch, targetState.id);
      ok = r.ok;
      msg = ok
        ? `✓ 已更新人物「${d.name || '未命名'}」状态「${targetState.label}」`
        : `⚠ 未更新状态：${opErr(r)}`;
    } else if (b.action === 'switch') {
      if (!target) {
        setDoneMsg(`⚠ 人物「${d.name || '未命名'}」没有状态「${b.state}」，未落地`);
        return;
      }
      const r = st.switchCharacterStateOnBoard(board.id, node.id, target.id);
      ok = r.ok;
      msg = ok
        ? `✓ 已切换人物「${d.name || '未命名'}」到状态「${target.label}」`
        : `⚠ 未切换状态：${opErr(r)}`;
    } else if (b.action === 'rename') {
      if (!target) {
        setDoneMsg(`⚠ 人物「${d.name || '未命名'}」没有状态「${b.state}」，未落地`);
        return;
      }
      if (!b.newLabel) {
        setDoneMsg('⚠ 重命名缺少新状态名，未落地');
        return;
      }
      if (d.states.some((s) => s.id !== target.id && s.label === b.newLabel)) {
        setDoneMsg(`⚠ 人物「${d.name || '未命名'}」已有状态「${b.newLabel}」，未落地`);
        return;
      }
      const r = st.renameCharacterStateOnBoard(board.id, node.id, target.id, b.newLabel);
      ok = r.ok;
      msg = ok
        ? `✓ 已将人物「${d.name || '未命名'}」状态「${target.label}」重命名为「${b.newLabel}」`
        : `⚠ 未重命名状态：${opErr(r)}`;
    } else if (b.action === 'delete') {
      if (!target) {
        setDoneMsg(`⚠ 人物「${d.name || '未命名'}」没有状态「${b.state}」，未落地`);
        return;
      }
      if (characterStateIndex(d, target.id) === 0) {
        setDoneMsg(`⚠ 状态「${target.label}」是默认状态（首项），不可删除`);
        return;
      }
      if (!window.confirm(`删除人物「${d.name || '未命名'}」的状态「${target.label}」？该状态属性与写真引用会一并移除。${impactText}`)) return;
      const r = st.deleteCharacterStateOnBoard(board.id, node.id, target.id);
      ok = r.ok;
      if (ok) {
        const removedKey = r.ok ? r.removed?.portraitKey : undefined;
        if (removedKey) {
          const still = Object.values(useStudioStore.getState().boards).some((bd) =>
            bd.nodes.some((n) => n.data.kind === 'character' && n.data.states.some((s) => s.portraitKey === removedKey)),
          );
          if (!still) void localImgDel(removedKey).catch(() => {});
        }
      }
      msg = ok
        ? `✓ 已删除人物「${d.name || '未命名'}」状态「${target.label}」`
        : `⚠ 未删除状态：${opErr(r)}`;
    } else {
      setDoneMsg('⚠ 未识别状态动作，未落地');
      return;
    }
    if (ok && impactText) {
      msg += b.action === 'delete'
        ? '；其他章节在切回同步前会显示「资料缺失」'
        : '；当前章场景会自动跟随画布同步';
    }
    if (ok) setDropped((prev) => new Set(prev).add(i));
    setDoneMsg(msg + (ok ? boardSuffix(board, rb.label) : ''));
  };

  // 区域规划整组落地：容器（按规划范围尺寸）+ N 座建筑（按规划大小/位置摆好，reparentNode 自动换算相对坐标）。
  // 建筑不参与落点判定，全部显式挂进容器；容器落点在既有环境内则整组嵌进去（与单节点落点语义一致）。
  const dropPlan = (b: SimPlanBlock, i: number) => {
    setDoneMsg('');
    const st = useStudioStore.getState();
    const size = { w: b.w, h: b.h };
    const pos = dropPos(size);
    const pid = st.createEnvironment(pos, size);
    st.updateEnvironment(pid, { name: b.name, desc: b.desc ?? '', etype: b.etype });
    const activeNodes = useStudioStore.getState().boards[useStudioStore.getState().activeBoardId]?.nodes ?? [];
    const container = findContainerAt(activeNodes, pos.x + size.w / 2, pos.y + size.h / 2, pid);
    if (container) st.reparentNode(pid, container.id);
    for (const it of b.items) {
      const cid = st.createEnvironment({ x: pos.x + it.x, y: pos.y + it.y }, { w: it.w, h: it.h });
      st.updateEnvironment(cid, { name: it.name, desc: it.desc, etype: it.etype });
      st.reparentNode(cid, pid);
    }
    // 收尾重选容器（创建过程每个新节点都自动选中过，归位于容器便于直接改名/拖动整组）
    const after = useStudioStore.getState();
    const afterNodes = after.boards[after.activeBoardId]?.nodes ?? [];
    after.onNodesChange(afterNodes.map((n2) => ({ id: n2.id, type: 'select' as const, selected: n2.id === pid })));
    setDropped((prev) => new Set(prev).add(i));
    setDoneMsg(`✓ 规划「${b.name}」已落地（${b.items.length} 座建筑已嵌套）`);
  };

  // 卷块：新建卷 + 空画布（同名卷不重复创建；不自动切换当前标签——编辑室不改变用户视角）
  const dropVolume = (b: SimVolumeBlock, i: number) => {
    setDoneMsg('');
    const r = useStudioStore.getState().addVolumeFromBlock(b.name, b.intro);
    setDropped((prev) => new Set(prev).add(i));
    setDoneMsg(r.created ? `✓ 卷「${b.name}」已新建（含空白画布）` : `✓ 同名卷「${b.name}」已存在，未重复创建`);
  };

  // 生图块：点按钮才真正调用生图 API（轮询到完成 → 展示 + 写入消息持久化；同块可重生成）
  const [gens, setGens] = useState<Record<number, { status: 'generating' | 'done' | 'failed'; progress?: number; url?: string; error?: string }>>({});
  const genBlockImage = (b: SimImageBlock, i: number) => {
    if (gens[i]?.status === 'generating') return;
    setDoneMsg('');
    setGens((p) => ({ ...p, [i]: { status: 'generating' } }));
    void genImage({ prompt: b.prompt, size: b.size, onProgress: (progress) => setGens((p) => ({ ...p, [i]: { status: 'generating', progress } })) }).then((r) => {
      if (r.ok && r.urls?.length) {
        setGens((p) => ({ ...p, [i]: { status: 'done', url: r.urls![0] } }));
        useEditorRoomStore.getState().attachImage(msg.id, i, r.urls[0]);
        // 图片本体转存浏览器 IndexedDB（服务器文件 10 分钟后被 GC；本地副本长期有效）
        void localImgSaveFromUrl(`chat:${msg.id}:${i}`, r.urls[0]).catch(() => {});
      } else setGens((p) => ({ ...p, [i]: { status: 'failed', error: r.error } }));
    });
  };

  // 本地仓读图：展示优先 IndexedDB 副本（长期有效），退回消息里的服务器 URL（旧消息/转存失败兜底）
  const [localUrls, setLocalUrls] = useState<Record<number, string>>({});
  const imgKey = msg.blocks
    .map((b, i) => (b.kind === 'image' ? i : -1))
    .filter((i) => i >= 0)
    .join(',');
  useEffect(() => {
    let alive = true;
    const idxs = imgKey ? imgKey.split(',').map(Number) : [];
    void Promise.all(idxs.map((i) => localImgGet(`chat:${msg.id}:${i}`).then((v) => [i, v] as const)))
      .then((entries) => {
        if (alive) setLocalUrls(Object.fromEntries(entries.filter((e): e is readonly [number, string] => !!e[1])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [msg.id, imgKey]);

  return (
    <>
    <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1">
      {/* 🧬 批量落人物（v2.15）：回复含 ≥2 个未落的人物设定块时，一键全部落地（配合人物生成规则的批量产出） */}
      {(() => {
        // 只批量新建画布上没有同名节点的块；同名块已自动识别为「修改」，不能重复创建
        const pending = msg.blocks
          .map((b, i) => ({ b, i }))
          .filter((x): x is { b: EditorRoomBlock; i: number } => {
            if (x.b.kind !== 'character' || x.b.target || !x.b.age || dropped.has(x.i)) return false;
            const rb = resolveBlockBoard(x.b);
            if ('error' in rb) return false; // 卷目标不明确：不批量落地，避免写错画布
            const key = normNodeName(x.b.name);
            return !key || !rb.board.nodes.some((n) => n.data.kind === 'character' && normNodeName(n.data.name) === key);
          });
        return pending.length >= 2 ? (
          <button
            onClick={() => {
              pending.forEach(({ b, i }) => drop(b, i));
              setDoneMsg(`✓ ${pending.length} 个人物已全部落为画布节点`);
            }}
            title="把本条回复的全部新人物设定块逐个落为画布人物节点（同名人物会识别为修改，不在批量新建内）"
            className="flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-brand-700"
          >
            <UserPlus className="h-3.5 w-3.5" />
            全部落为人物（{pending.length}）
          </button>
        ) : null;
      })()}
      {/* ✏️ 批量更新：回复里 ≥2 个块都能唯一匹配到画布已有节点（如「给医院里所有人统一加服装要求」）→ 一键全部更新；
          同名节点只更新一次（以最后一个块为准），避免重复点击逐个确认 */}
      {(() => {
        const seen = new Map<string, { b: EditorRoomBlock; i: number; node: SimNodeType }>();
        msg.blocks.forEach((b, i) => {
          if (dropped.has(i) || (b.kind !== 'character' && b.kind !== 'environment')) return;
          const block = b as EditorRoomBlock;
          const key = normNodeName(block.target || block.name);
          if (!key) return;
          const rb = resolveBlockBoard(block);
          if ('error' in rb) return;
          const hits = rb.board.nodes.filter((n) => n.data.kind === block.kind && normNodeName(n.data.name) === key);
          // 不同卷画布可能有同 ID 镜像节点：去重键必须带上画布
          if (hits.length === 1) seen.set(`${rb.board.id}:${hits[0].id}`, { b: block, i, node: hits[0] });
        });
        const list = [...seen.values()];
        return list.length >= 2 ? (
          <button
            onClick={() => {
              list.forEach(({ b, i, node }) => updateExisting(b, i, node));
              setDoneMsg(`✓ 已按本条回复更新 ${list.length} 个节点`);
            }}
            title="把本条回复里所有能唯一匹配到画布节点的设定块一次性更新（只覆盖块里写出的字段）"
            className="flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-emerald-700"
          >
            <PenLine className="h-3.5 w-3.5" />
            全部更新（{list.length}）
          </button>
        ) : null;
      })()}
      {/* 📥 批量落卷：回复含 ≥2 个未落的卷设定块时，按卷序一次新建全部卷 */}
      {(() => {
        const pending = msg.blocks
          .map((b, i) => ({ b, i }))
          .filter((x): x is { b: SimVolumeBlock; i: number } => x.b.kind === 'volume' && !dropped.has(x.i));
        return pending.length >= 2 ? (
          <button
            onClick={() => {
              pending.forEach(({ b, i }) => dropVolume(b, i));
              setDoneMsg(`✓ ${pending.length} 卷已全部新建`);
            }}
            title="按卷序把本条回复的全部卷设定块新建为卷（已有卷不覆盖）"
            className="flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-brand-700"
          >
            <Layers className="h-3.5 w-3.5" />
            全部落为卷（{pending.length}）
          </button>
        ) : null;
      })()}
      {msg.blocks.map((b: SimBlock, i) => {
        // 🎨 生图块（v2.19b）：不进 dropped 落地流程，点按钮才调生图 API；完成后图显示在按钮行下方
        if (b.kind === 'image') {
          const g = gens[i];
          return (
            <button
              key={`image-${i}`}
              onClick={() => genBlockImage(b, i)}
              disabled={g?.status === 'generating'}
              title={
                g?.status === 'generating'
                  ? '正在调用生图 API（完成后显示在下方，约 1-2 分钟）'
                  : g?.status === 'done'
                    ? '重新生成（覆盖旧图）'
                    : '调用生图 API 把提示词画成图'
              }
              className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {g?.status === 'generating' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />}
              {g?.status === 'generating' ? `生成中${g.progress ? ` ${g.progress}%` : '…'}` : g?.status === 'done' ? '重新生成图片' : '生成图片'}
            </button>
          );
        }
        // 🧬 人物状态块：只操作已有人的状态；找不到人物/状态、重名、默认状态删除等一律禁用并说明原因
        if (b.kind === 'characterState') {
          const isDropped = dropped.has(i);
          const rb = resolveBlockBoard(b);
          if ('error' in rb) {
            return (
              <span key={`state-${b.character}-${i}`} className="inline-flex items-center gap-1">
                <button
                  disabled
                  title={`${rb.error}。请让编辑室确认卷名，或先创建该卷；不会落到当前画布。`}
                  className="flex cursor-not-allowed items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[12px] text-amber-700 opacity-80"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  状态·{b.character} → 卷「{b.volume}」：{rb.error}
                </button>
              </span>
            );
          }
          const key = normNodeName(b.character);
          const hits = key
            ? rb.board.nodes.filter((n) => n.data.kind === 'character' && normNodeName(n.data.name) === key)
            : [];
          const node = hits.length === 1 ? hits[0] : undefined;
          const d = node?.data.kind === 'character' ? node.data : undefined;
          let issue = b.parseError || '';
          if (!issue && !key) issue = '缺少人物名';
          if (!issue && hits.length > 1) issue = '目标画布有多个同名人物，请让编辑室用更准确的名字或先改名';
          if (!issue && !node) issue = '目标画布上未找到该人物（状态块不会创建人物）';
          if (!issue && d) {
            const target = b.state ? d.states.find((s) => s.label === b.state) : undefined;
            if (b.action === 'create') {
              if (b.state && d.states.some((s) => s.label === b.state)) issue = `人物已有状态「${b.state}」`;
              if (b.baseState && !d.states.some((s) => s.label === b.baseState)) issue = `基准状态「${b.baseState}」不存在`;
            } else if (b.action === 'update') {
              if (b.state && !target) issue = `人物没有状态「${b.state}」`;
            } else if (b.action === 'switch' || b.action === 'rename' || b.action === 'delete') {
              if (!target) issue = `人物没有状态「${b.state || '（未写）'}」`;
            }
            if (!issue && b.action === 'delete' && target && characterStateIndex(d, target.id) === 0) {
              issue = '默认状态（首项）不可删除';
            }
            if (
              !issue &&
              b.action === 'rename' &&
              b.newLabel &&
              d.states.some((s) => s.label === b.newLabel)
            ) {
              issue = `人物已有状态「${b.newLabel}」`;
            }
          }
          const current = d ? activeCharacterState(d) : undefined;
          const targetLabel = b.state || current?.label || '当前状态';
          const actLabel =
            b.action === 'create'
              ? `新建状态「${targetLabel}」`
              : b.action === 'update'
                ? `更新状态「${targetLabel}」`
                : b.action === 'switch'
                  ? `切换状态「${targetLabel}」`
                  : b.action === 'rename'
                    ? `重命名「${targetLabel}」→「${b.newLabel || '?'}」`
                    : b.action === 'delete'
                      ? `删除状态「${targetLabel}」`
                      : '状态操作无效';
          const title = issue
            ? issue
            : isDropped
              ? '已执行（要再改可让它重新输出）'
              : b.action === 'delete'
                ? '删除该非默认状态（会先确认；默认状态与最后一个状态不可删）'
                : b.action === 'create'
                  ? `复制「${b.baseState || current?.label || '当前状态'}」的全部属性与写真引用，创建后设为当前状态`
                  : b.action === 'rename'
                    ? '只改状态标签，状态 ID 与属性不变'
                    : b.action === 'switch'
                      ? '把该状态设为当前状态（画布展示与后续章节生成使用它）'
                      : '只覆盖块里写出的状态属性，未写的保留';
          return (
            <span key={`state-${b.character}-${i}`} className="inline-flex items-center gap-1">
              {b.volume && (
                <span
                  title={`目标卷画布：${rb.label}`}
                  className={`max-w-[110px] shrink-0 truncate rounded-full px-1.5 py-0.5 text-[11px] ${
                    rb.board.id !== activeBoardId ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  🗂{rb.label}
                </span>
              )}
              <button
                disabled={isDropped || !!issue}
                onClick={() => dropState(b, i)}
                title={title}
                className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  issue
                    ? 'border-amber-200 bg-amber-50 text-amber-700 opacity-80'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {isDropped ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                    {b.character}·{actLabel} 已完成
                  </>
                ) : issue ? (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5" />
                    状态·{b.character}：{issue}
                  </>
                ) : (
                  <>
                    <Layers className="h-3.5 w-3.5" />
                    {b.character}·{actLabel}
                  </>
                )}
              </button>
            </span>
          );
        }
        // ✏️ 人物/环境块：创建与修改自动区分——
        //   块名与画布上同名节点唯一匹配（或 AI 写了「更新：」）→ 修改已有节点，只覆盖块里写出的字段；
        //   无同名节点 → 纯创建，不再给创建块挂「更新已有」选择器。
        //   只有重名/找不到目标这类无法自动判定的情况才出选择器。
        if (b.kind === 'character' || b.kind === 'environment') {
          const isDropped = dropped.has(i);
          const kindLabel = b.kind === 'character' ? '人物' : '环境';
          const rb = resolveBlockBoard(b);
          if ('error' in rb) {
            // 卷目标写错/重名：禁用落地，绝不静默写进当前画布
            return (
              <span key={`${b.kind}-${b.name}-${i}`} className="inline-flex items-center gap-1">
                <button
                  disabled
                  title={`${rb.error}。请让编辑室确认卷名，或先创建该卷；不会落到当前画布。`}
                  className="flex cursor-not-allowed items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[12px] text-amber-700 opacity-80"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {kindLabel}「{b.name}」→ 卷「{b.volume}」：{rb.error}
                </button>
              </span>
            );
          }
          const blockNodes = rb.board.nodes;
          const crossBoard = rb.board.id !== activeBoardId;
          const boardHint = crossBoard ? `「${rb.label}」画布` : '';
          const sameKind = blockNodes.filter((n) => n.data.kind === b.kind);
          const lookupName = normNodeName(b.target || b.name);
          const hits = lookupName ? sameKind.filter((n) => normNodeName(n.data.name) === lookupName) : [];
          const targetNode = hits.length === 1 ? hits[0] : undefined;
          const autoMatched = !b.target && !!targetNode; // 块名即目标画布已有节点名 → 识别为修改
          const ambiguous = hits.length > 1;
          const missingTarget = !!b.target && hits.length === 0;
          const issue = ambiguous
            ? `目标画布有多个同名节点，请用右侧选择器指定`
            : missingTarget
              ? `${boardHint || '画布'}上未找到该节点`
              : '';
          // 📍「所在」：目标父环境（名字或 镇＞建筑 路径唯一定位）——只在目标画布内找
          const parentHits = b.parent ? findEnvByRef(blockNodes, b.parent) : [];
          const parentNode = parentHits.length === 1 ? parentHits[0] : undefined;
          const parentHint = b.parent
            ? parentNode
              ? `将在${ENV_TYPE_LABELS[parentNode.data.etype]}「${parentNode.data.name || '未命名'}」内创建并归为其子节点`
              : `未唯一找到所在环境「${b.parent}」（${parentHits.length > 1 ? '有多处同名' : '未找到'}），将按视口落点创建`
            : '';
          return (
            <span key={`${b.kind}-${b.name}-${i}`} className="inline-flex items-center gap-1">
              {b.volume && (
                <span
                  title={`目标卷画布：${rb.label}`}
                  className={`max-w-[110px] shrink-0 truncate rounded-full px-1.5 py-0.5 text-[11px] ${
                    crossBoard ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  🗂{rb.label}
                </span>
              )}
              {targetNode ? (
                <button
                  onClick={() => { if (targetNode) updateExisting(b, i, targetNode); }}
                  disabled={isDropped}
                  title={
                    isDropped
                      ? '已更新（要再改可让它重新输出）'
                      : autoMatched
                        ? `${boardHint || '画布上'}已有同名${kindLabel}，自动识别为修改：只覆盖块里写出的字段，其余保留原值`
                        : `更新${boardHint || ''}已有${kindLabel}「${targetNode.data.name || '未命名'}」：只覆盖块里写出的字段，其余保留原值`
                  }
                  className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isDropped ? <Check className="h-3.5 w-3.5" /> : <PenLine className="h-3.5 w-3.5" />}
                  {isDropped
                    ? `已更新${kindLabel}「${b.name}」`
                    : `更新${kindLabel}「${targetNode.data.name || '未命名'}」`}
                </button>
              ) : ambiguous || missingTarget ? (
                <button
                  disabled
                  title={issue}
                  className="flex cursor-not-allowed items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[12px] text-amber-700 opacity-80"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {kindLabel}「{b.target || b.name}」：{issue}
                </button>
              ) : b.kind === 'character' && !b.age ? (
                // 无同名节点 = 新建；新建人物仍要求年龄（修改块可省略年龄，但必须有同名/「更新：」目标）
                <button
                  disabled
                  title="新建人物需要年龄：若这是修改已有节点，请让块名与画布节点当前名字一致，或让编辑室重新生成带年龄的设定"
                  className="flex cursor-not-allowed items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[12px] text-amber-700 opacity-80"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {kindLabel}「{b.name}」：缺少年龄
                </button>
              ) : (
                <button
                  onClick={() => drop(b, i)}
                  disabled={isDropped}
                  title={
                    isDropped
                      ? `已落为画布${kindLabel}（再要一份可让它重新输出）`
                      : b.parent
                        ? parentHint
                        : `落到画布视口中心：创建${kindLabel}并填好属性`
                  }
                  className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isDropped ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                      {kindLabel}「{b.name}」已落
                    </>
                  ) : (
                    <>
                      <Plus className="h-3.5 w-3.5" />
                      落为{kindLabel}「{b.name}」
                    </>
                  )}
                </button>
              )}
              {/* 📍所在位置提示：创建会进该父环境；修改会把节点移入该环境 */}
              {b.parent && !isDropped && (
                <span
                  title={parentHint}
                  className={`max-w-[120px] shrink-0 truncate rounded-full px-1.5 py-0.5 text-[11px] ${
                    parentNode ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-600'
                  }`}
                >
                  📍{parentNode ? parentNode.data.name || '未命名' : parentHits.length > 1 ? '所在重名' : '所在未找到'}
                </span>
              )}
              {/* 仅无法自动判定（重名/AI 目标不存在）时才给选择器 */}
              {(ambiguous || missingTarget) && !isDropped && sameKind.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    const node = sameKind.find((n) => n.id === e.target.value);
                    if (node) updateExisting(b, i, node);
                  }}
                  title={`把设定块更新到已有${kindLabel}：只覆盖块里写出的字段，其余保留原值`}
                  className="max-w-[160px] rounded-full border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-500 transition hover:bg-slate-50"
                >
                  <option value="">{b.target ? '✏️ 换更新目标…' : '✏️ 选择要更新的节点…'}</option>
                  {sameKind.map((n) => (
                    <option key={n.id} value={n.id}>
                      {nodeOptionLabel(n, blockNodes)}
                    </option>
                  ))}
                </select>
              )}
              {/* AI 指定的目标不存在时，仍可当新建用，避免块无法落地（新建人物仍需年龄） */}
              {missingTarget && !isDropped && !(b.kind === 'character' && !b.age) && (
                <button
                  onClick={() => drop(b, i)}
                  title={`不更新已有节点，另建一个新${kindLabel}`}
                  className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-50 hover:text-slate-600"
                >
                  <Plus className="h-3 w-3" />
                  新建
                </button>
              )}
            </span>
          );
        }
        const isDropped = dropped.has(i);
        const disabled = isDropped || (b.kind === 'plan' && !b.items.length);
        const title =
          b.kind === 'volume'
            ? isDropped
              ? '已新建为卷（再要一份可让它重新输出）'
              : '在卷管理中新建一卷：卷名与介绍按块填好'
            : b.kind === 'plan'
            ? isDropped
              ? '已落地（再要一份可让它重新输出）'
              : b.items.length
                ? '落到画布视口中心：容器 + 全部建筑按规划大小/位置摆好并嵌套'
                : '未解析出建筑布局（可让它重新输出）'
            : isDropped
              ? '已落为画布节点（再要一份可让它重新输出）'
              : '落到画布视口中心：创建节点并填好属性';
        return (
          <button
            key={`${b.kind}-${b.name}-${i}`}
            onClick={() => (b.kind === 'volume' ? dropVolume(b, i) : b.kind === 'plan' ? dropPlan(b, i) : drop(b, i))}
            disabled={disabled}
            title={title}
            className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isDropped ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-500" />
                {b.label}「{b.name}」已落
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" />
                {b.kind === 'plan' ? `落为规划「${b.name}」（${b.items.length} 建筑）` : `落为${b.label}「${b.name}」`}
              </>
            )}
          </button>
        );
      })}
      {doneMsg && (
        <span className="flex items-center gap-1 text-[12px] text-emerald-600">
          <Check className="h-3.5 w-3.5" />
          {doneMsg.replace(/^✓\s*/, '')}
        </span>
      )}
    </div>
    {/* 🎨 生图块成品区：生成中占位 / 失败提示 / 图片（图片本体存浏览器 IndexedDB，msg.images 仅存服务器临时 URL 兜底） */}
    {msg.blocks.some((b) => b.kind === 'image') && (
      <div className="mt-1.5 flex flex-wrap gap-2 px-1">
        {msg.blocks.map((b, i) => {
          if (b.kind !== 'image') return null;
          const g = gens[i];
          const url = localUrls[i] ?? g?.url ?? msg.images?.find((x) => x.i === i)?.url;
          return (
            <div key={`img-${i}`} className="w-44">
              {url ? (
                <a href={url} target="_blank" rel="noreferrer">
                  <img src={url} alt={b.prompt.slice(0, 24)} className="w-full rounded-lg border border-slate-200 bg-slate-50" />
                </a>
              ) : g?.status === 'generating' ? (
                <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 text-[12px] text-slate-500">
                  生成中{g.progress ? ` ${g.progress}%` : '…'}
                </div>
              ) : g?.status === 'failed' ? (
                <div className="rounded-lg border border-dashed border-rose-300 bg-rose-50 px-2 py-3 text-[12px] leading-relaxed text-rose-600">
                  生成失败：{g.error}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    )}
    </>
  );
}

// ── 面板本体 ──

export function EditorRoomPanel({ onClose }: { onClose: () => void }) {
  const messages = useEditorRoomStore((s) => s.messages);
  const busy = useEditorRoomStore((s) => s.busy);
  const error = useEditorRoomStore((s) => s.error);
  const summary = useEditorRoomStore((s) => s.summary);
  const compactBusy = useEditorRoomStore((s) => s.compactBusy);
  const generating = useUiStore((s) => s.generating);
  const chatWidth = useEditorRoomStore((s) => s.settings.chatWidth);
  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showDept, setShowDept] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const mode = useEditorialStore((s) => s.mode);
  const meetingRunning = useEditorialStore((s) => s.status === 'running');
  const routeChat = useEditorialStore((s) => s.routeChat);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 🧑‍💼 对话对象（v2.19b）：总编辑（默认）或编辑部某位编辑；名单合并必须 useMemo（选择器禁返回新数组）
  const chatEditor = useEditorRoomStore((s) => s.chatEditor);
  const activeConvKey = useEditorRoomStore((s) => s.activeConvKey);
  const localEditors = useEditorialStore((s) => s.localEditors);
  const serverEditors = useEditorialStore((s) => s.serverEditors);
  const serverLoaded = useEditorialStore((s) => s.serverLoaded);
  const editors = useMemo(() => [...localEditors, ...serverEditors].filter((e) => e.enabled), [localEditors, serverEditors]);
  // 刷新恢复：chatEditor 对象不持久化，按 activeConvKey 从编辑名单找回（上下文随 messages/summary 已载入）；
  // 正式编辑还没拉完时先等，确认编辑已删除/停用才把活动会话归档并回总编辑
  useEffect(() => {
    if (activeConvKey !== 'chief' && !editors.some((e) => e.id === activeConvKey) && !serverLoaded) return;
    if (chatEditor) {
      if (!editors.some((e) => e.id === chatEditor.id)) useEditorRoomStore.getState().dropOrphanConv();
      return;
    }
    if (activeConvKey === 'chief') return;
    const ed = editors.find((e) => e.id === activeConvKey);
    if (ed) useEditorRoomStore.getState().restoreChatEditor(ed);
    else useEditorRoomStore.getState().dropOrphanConv();
  }, [chatEditor, activeConvKey, editors, serverLoaded]);
  // 会话恢复中（编辑名单未就绪）：暂停发送，避免消息错发到总编辑上下文
  const restoringConv = activeConvKey !== 'chief' && !chatEditor;
  // 长文分析只在「单独对话某编辑」时可用；切回总编辑/会议时收起
  useEffect(() => {
    if (mode !== 'chat' || !chatEditor) setAnalysisOpen(false);
  }, [mode, chatEditor]);

  // 🏛 作品责编技能记忆（v2.21）：作品责编（顶栏选择，随作品存档）在各模块的技能记忆解析为纯数据写入
  //  editorRoomStore（避免 store 循环依赖），总编辑对话（genSimTurn）按本轮话题命中注入；无技能记忆的模块不注入
  const responsibleId = useStudioStore((s) => s.responsibleId);
  useEffect(() => {
    const eds = [...useEditorialStore.getState().localEditors, ...useEditorialStore.getState().serverEditors];
    const ed = eds.find((e) => e.id === responsibleId && e.enabled);
    const rec: Partial<Record<string, ResponsibleEditor>> = {};
    if (ed) {
      for (const m of EDITOR_MODULES) {
        const mem = (ed.skills ?? {})[m];
        if (mem?.trim()) rec[m] = { name: ed.name, specialty: ed.specialty, persona: ed.persona, memory: mem };
      }
    }
    useEditorRoomStore.setState({ mentorByModule: rec });
  }, [responsibleId, localEditors, serverEditors]);

  // ✍ 职责草稿：采纳=写回该编辑并清草稿；忽略=仅清除。
  // 🧠 记忆更新条目（v2.21 双通道）出现即自动吸收（超优化阈值先 AI 精简，见 editorialStore.absorbMemoryDraft）；
  // 吸收后条目保留在消息上，气泡显示「🧠 主记忆/技能记忆已更新 N 条」供点开查看（块从正文剥离，不看清条目会误以为回复被截断）
  const adoptPersona = (m: EditorRoomMessage) => {
    if (!m.personaDraft || !m.editorId) return;
    void useEditorialStore.getState().updateEditor(m.editorId, { persona: m.personaDraft });
    useEditorRoomStore.setState((s) => ({ messages: s.messages.map((x) => (x.id === m.id ? { ...x, personaDraft: undefined } : x)) }));
  };
  const dismissDraft = (msgId: string) =>
    useEditorRoomStore.setState((s) => ({ messages: s.messages.map((x) => (x.id === msgId ? { ...x, personaDraft: undefined } : x)) }));
  const [memOpenId, setMemOpenId] = useState<string | null>(null);

  // 自动吸收记忆更新：ref 去重（键=msgId:target）防重复触发（异步写入期间 messages 仍带条目会再进本 effect）；done=已吸收（reload 后跳过）。
  // 逐条串行排队：AI 优化共用生成通道，并发会互斥失败回退截断
  const memSeenRef = useRef<Set<string>>(new Set());
  const memQueueRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    for (const m of messages) {
      if (!m.editorId) continue;
      for (const u of m.memUpdates ?? []) {
        const key = `${m.id}:${u.target}`;
        if (u.done || memSeenRef.current.has(key)) continue;
        memSeenRef.current.add(key);
        memQueueRef.current = memQueueRef.current
          .then(() => useEditorialStore.getState().absorbMemoryDraft(m.id, m.editorId!, u.target, u.text))
          .catch(() => undefined);
      }
    }
  }, [messages]);

  // 打开面板读一次模型信息（已读过则 store 内跳过；离线静默）
  useEffect(() => {
    void useEditorRoomStore.getState().loadMeta();
  }, []);

  // 新消息或流式增长时贴底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = () => {
    const t = input;
    if (!t.trim()) return;
    if (meetingRunning && routeChat) {
      useEditorialStore.getState().addRemark(t);
      setInput('');
      return;
    }
    if (busy || generating) return;
    setInput('');
    void useEditorRoomStore.getState().send(t);
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  };

  const lastAgentId = messages.length && messages[messages.length - 1].role === 'agent' ? messages[messages.length - 1].id : null;

  /** 恒定聊天列宽（⚙ 可调） */
  const colStyle = WIDTH_PX[chatWidth] ? { maxWidth: WIDTH_PX[chatWidth] } : undefined;

  /** 🧪 检验任务取该条记忆前最近的用户指令（≤500 字，最后指令优先）；没有（如旧会话）则由 store 回落标准任务 */
  const precedingTask = (mi: number): string => {
    for (let i = mi - 1; i >= 0; i--) {
      const p = messages[i];
      if (p.role === 'user') return p.text.trim().slice(0, 500);
    }
    return '';
  };

  const bubbles: ReactNode[] = messages.map((m, mi) => {
    const isUser = m.role === 'user';
    const streaming = !isUser && m.id === lastAgentId && busy;
    const showThink = !isUser && !!m.think?.trim();
    return (
      <div key={m.id} className={isUser ? 'flex justify-end' : 'flex justify-start'}>
        <div className="min-w-0" style={{ maxWidth: 'min(92%, 44em)' }}>
          {showThink && (
            <details className="mb-1 rounded-[10px] border border-slate-100 bg-slate-50/80 px-2.5 py-1.5" open={streaming && !m.text.trim()}>
              <summary className="flex cursor-pointer select-none items-center gap-1 text-[12px] text-slate-400">
                <Brain className="h-3.5 w-3.5" />
                思考过程
              </summary>
              <div className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-[1.7] text-slate-400">{m.think}</div>
            </details>
          )}
          <div
            className={
              isUser
                ? 'whitespace-pre-wrap break-words rounded-[14px] rounded-br-[4px] bg-brand-600 px-3.5 py-2 text-[14px] leading-[1.75] text-white'
                : 'whitespace-pre-wrap break-words rounded-[14px] rounded-bl-[4px] border border-slate-200 bg-slate-50 px-3.5 py-2 text-[14px] leading-[1.75] text-slate-800'
            }
            dangerouslySetInnerHTML={{ __html: fmt(m.text) + (streaming ? '<span class="agent-cursor">▍</span>' : '') }}
          />
          {isUser && (
            <div className="mt-0.5 flex justify-end pr-0.5">
              <IconButton
                icon={<Trash2 />}
                title="删除这条消息"
                onClick={() => useEditorRoomStore.getState().deleteMessage(m.id)}
                disabled={busy}
              />
            </div>
          )}
          {!isUser && !streaming && m.text && (
            <div className="mt-0.5 flex items-center gap-1 px-0.5">
              {m.editorName && (
                <span className="flex items-center gap-1 text-[12px] text-brand-600" title="本条由该编辑单独对话产出（非总编辑）">
                  <PenLine className="h-3.5 w-3.5" />
                  {m.editorName}
                </span>
              )}
              {m.engine === 'public' && (
                <span className="text-[12px] text-amber-600" title="本条由公共模型生成（可在设置里切换）">
                  公共模型
                </span>
              )}
              <IconButton icon={<Copy />} title="复制这条回复" onClick={() => void copyText(m.text)} />
              <IconButton
                icon={<Trash2 />}
                title="删除这条回复"
                onClick={() => useEditorRoomStore.getState().deleteMessage(m.id)}
                disabled={busy}
              />
              {m.id === lastAgentId && (
                <IconButton
                  icon={<RotateCcw />}
                  title="重新生成这条回复"
                  onClick={() => void useEditorRoomStore.getState().regenerate()}
                  disabled={busy || generating}
                />
              )}
              <span className="ml-auto text-[12px] tabular-nums text-slate-300">
                {new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          )}
          {!isUser && !streaming && <SimBlockDropRow msg={m} />}
          {!isUser && !streaming && <SimWriteButtons writes={m.writes} />}
          {!isUser && !streaming && m.personaDraft && (
            <div className="mt-1.5 rounded-[10px] border border-brand-200 bg-brand-50/50 px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-brand-700">
                <PenLine className="h-3.5 w-3.5" />
                职责改进草稿（确认后写入该编辑，下次对话生效）
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-[1.7] text-slate-600">{m.personaDraft}</div>
              <div className="mt-1.5 flex gap-1.5">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => adoptPersona(m)}
                  title="把草稿写为该编辑的职责（本地编辑存浏览器，正式编辑存服务器）"
                >
                  采纳为新职责
                </Button>
                <Button variant="secondary" size="sm" onClick={() => dismissDraft(m.id)}>
                  忽略
                </Button>
              </div>
            </div>
          )}
          {!isUser && !streaming && !!m.memUpdates?.some((u) => u.done) && (
            <div className="mt-1.5 flex flex-col gap-1">
              {m.memUpdates
                .filter((u) => u.done)
                .map((u) => (
                  <div key={u.target}>
                    <div className="flex items-start gap-1">
                      <button
                        onClick={() => setMemOpenId(memOpenId === `${m.id}:${u.target}` ? null : `${m.id}:${u.target}`)}
                        className="flex items-center gap-1.5 rounded-[8px] border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-600 transition hover:bg-slate-50"
                        title="本次对话沉淀进该编辑记忆的条目（已过格式校验自动写入；主记忆=通用协作偏好，技能记忆=对应能力的技法）"
                      >
                        <Brain className="h-3.5 w-3.5 text-slate-400" />
                        {u.target === 'main' ? '主记忆' : `技能记忆（${u.target}）`}已更新{' '}
                        {u.count ?? u.text.trim().split('\n').filter(Boolean).length} 条
                        <span className="text-slate-400">{memOpenId === `${m.id}:${u.target}` ? '收起' : '查看'}</span>
                      </button>
                      {u.target !== 'main' && m.editorId && (
                        <button
                          onClick={() => void useEditorialStore.getState().checkSkillMemory(m.id, m.editorId!, u.target, precedingTask(mi))}
                          disabled={u.check?.status === 'checking'}
                          className="flex items-center gap-1 rounded-[8px] border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
                          title="派发干净子 agent（不带对话历史，仅职责+当前技能记忆+任务）生成一次样例，看调教效果；只展示不落库"
                        >
                          <FlaskConical className="h-3.5 w-3.5" />
                          检验效果
                        </button>
                      )}
                    </div>
                    {u.check?.status === 'checking' && (
                      <div className="mt-1 flex items-center gap-1.5 rounded-[8px] border border-slate-200 bg-slate-50 px-2.5 py-2 text-[12px] text-slate-500">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        干净环境检验中（无对话历史，仅职责+技能记忆+任务）…
                      </div>
                    )}
                    {u.check?.status === 'error' && (
                      <div className="mt-1 rounded-[8px] border border-amber-200 bg-amber-50 px-2.5 py-2 text-[12px] leading-[1.7] text-amber-700">
                        检验失败：{u.check.error}（可再点「检验效果」重试）
                      </div>
                    )}
                    {u.check?.status === 'sample' && (
                      <details className="mt-1 rounded-[8px] border border-brand-200 bg-brand-50/40 px-2.5 py-2">
                        <summary className="cursor-pointer select-none text-[12px] font-semibold text-brand-700">
                          检验样例（干净环境生成，仅供参考，不写入记忆）
                        </summary>
                        <div className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-[1.7] text-slate-600">{u.check.sample}</div>
                      </details>
                    )}
                    {memOpenId === `${m.id}:${u.target}` && (
                      <div className="mt-1 whitespace-pre-wrap break-words rounded-[8px] border border-slate-200 bg-slate-50 px-2.5 py-2 text-[12.5px] leading-[1.7] text-slate-600">
                        {u.text}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    );
  });

  return (
    /* 桌面端固定宽（sm:w-[560px]）：不随流式文字抖动宽度（移动端左右贴边） */
    <div
      data-testid="editor-room"
      className="fixed bottom-2 left-2 right-2 top-[calc(var(--topbar-h)+10px)] z-40 flex flex-col overflow-hidden rounded-[16px] border border-slate-200/80 bg-white shadow-panel sm:left-auto sm:right-4 sm:w-[560px]"
    >
      {/* 头部：标题 + 编辑部 / 设置 / 清空 / 关闭 */}
      <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-slate-100 px-3 py-2">
        <span className="flex items-center gap-1.5 whitespace-nowrap text-[14px] font-semibold text-slate-700">
          <MessagesSquare className="h-4 w-4 text-slate-400" />
          编辑室
        </span>
        <span className="flex-1" />
        {compactBusy && (
          <span className="hidden items-center gap-1 whitespace-nowrap text-[12px] text-amber-600 sm:flex">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            压缩中
          </span>
        )}
        {busy && (
          <span className="flex items-center gap-1 whitespace-nowrap text-[12px] text-brand-600">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            生成中
          </span>
        )}
        {meetingRunning && (
          <span className="flex items-center gap-1 whitespace-nowrap text-[12px] text-brand-600">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            会议中
          </span>
        )}
        <button
          onClick={() => setShowDept(true)}
          className="flex items-center gap-1 whitespace-nowrap rounded-[8px] px-2 py-1 text-[12px] text-slate-500 transition hover:bg-slate-100"
          title="编辑部：管理参加会议的编辑（人物性格、剧情节奏等专项）"
        >
          <BookOpen className="h-3.5 w-3.5" />
          编辑部
        </button>
        <IconButton
          icon={<Settings2 />}
          title="对话设置：聊天宽度 / 上下文压缩 / 附带规则与目标（模型与推理在「模型中心」）"
          className={showSettings ? 'bg-slate-100 text-slate-800' : undefined}
          onClick={() => setShowSettings((v) => !v)}
        />
        {mode === 'chat' && (
          <IconButton
            icon={<Trash2 />}
            title="清空对话（摘要保留）"
            onClick={() => {
              if (messages.length && window.confirm('清空对话记录？（摘要保留）')) useEditorRoomStore.getState().clearChat();
            }}
            disabled={!messages.length || busy}
          />
        )}
        <IconButton icon={<X />} title="收起面板（生成继续，重开不丢）" onClick={onClose} />
      </div>

      {/* 对话对象选择（v2.19b）：默认总编辑；选编辑部编辑=与其单独对话，可借对话改进其职责 */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-slate-100 px-3 py-1.5">
        <Segmented
          value={mode}
          onChange={(m) => useEditorialStore.getState().setMode(m)}
          options={[
            { value: 'chat' as const, label: '对话' },
            { value: 'meeting' as const, label: '会议' },
          ]}
        />
        {mode === 'chat' ? (
          <>
            <span className="ml-1 whitespace-nowrap text-[12px] text-slate-400">对话对象</span>
            <select
              value={chatEditor?.id ?? activeConvKey}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'chief') {
                  useEditorRoomStore.getState().setChatEditor(null);
                  return;
                }
                const ed = editors.find((x) => x.id === v);
                if (ed) useEditorRoomStore.getState().setChatEditor(ed);
              }}
              disabled={busy || generating}
              title="默认与总编辑对话；选择其他编辑则按其职责单独交流（对话中可让 TA 改进自己的职责）；切换对象即切换到 TA 的独立上下文，各自的消息历史与摘要互不可见"
              className={`h-8 min-w-0 flex-1 rounded-[8px] border px-2 text-[12.5px] transition focus:border-brand-400 focus:outline-none focus:ring-4 focus:ring-brand-500/10 ${
                chatEditor ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-slate-200 bg-white text-slate-600'
              } disabled:opacity-50`}
            >
              <option value="chief">总编辑（默认）</option>
              {editors.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}（{e.specialty || '编辑'}）
                </option>
              ))}
            </select>
            {chatEditor && <span className="whitespace-nowrap text-[12px] text-brand-600">单独对话</span>}
            {chatEditor && (
              <button
                type="button"
                onClick={() => setAnalysisOpen((v) => !v)}
                disabled={busy || generating || meetingRunning}
                data-longtext-open
                title={`长文分析：让「${chatEditor.name}」按指定方向分析大段原文（独立面板，不写入对话）`}
                className={`flex h-7 shrink-0 items-center gap-1 rounded-[8px] border px-1.5 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  analysisOpen
                    ? 'border-brand-300 bg-brand-100 text-brand-700'
                    : 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100'
                }`}
              >
                <ScanText className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">长文分析</span>
              </button>
            )}
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12px] text-slate-400">编辑部会议：轮流发言，总编辑小结成纪要</span>
        )}
      </div>

      {/* 上下文用量条（读到 usage 后出现） */}
      {mode === 'chat' && <UsageMeter />}

      {/* ⚙ 设置弹层 */}
      {showSettings && <SettingsPop onClose={() => setShowSettings(false)} />}

      <div className="flex min-h-0 flex-1 flex-col">
        {mode === 'meeting' ? <MeetingView /> : (<>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="mx-auto flex w-full flex-col gap-3" style={colStyle}>
            {!messages.length && !summary.trim() && (
              <div className="flex min-h-[46vh] flex-col items-center justify-center px-6 text-center">
                <MessagesSquare className="h-7 w-7 text-slate-200" />
                <p className="mt-3 max-w-[24em] text-[13px] leading-relaxed text-slate-400">
                  描述你想搭建的世界——地点、人物、氛围。AI 会把回复整理成可直接落到画布的人物与环境设定。
                </p>
              </div>
            )}
            {summary.trim() && (
              <div className="rounded-[10px] border border-amber-200 bg-amber-50/70 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-amber-700">
                    <Archive className="h-3.5 w-3.5" />
                    更早对话已压缩为摘要（继续作为记忆注入）
                  </span>
                  <button
                    onClick={() => useEditorRoomStore.getState().clearSummary()}
                    disabled={busy || compactBusy}
                    className="whitespace-nowrap text-[12px] text-amber-600 transition hover:text-amber-800 disabled:opacity-40"
                    title="清除摘要后，更早对话将不再作为记忆（对话本身不受影响）"
                  >
                    清除
                  </button>
                </div>
                <details className="mt-1">
                  <summary className="cursor-pointer select-none text-[12px] text-amber-600">查看摘要</summary>
                  <div className="mt-1 whitespace-pre-wrap text-[12.5px] leading-[1.7] text-amber-800">{summary}</div>
                </details>
              </div>
            )}
            {bubbles}
            {error && (
              <div className="flex items-start gap-1.5 break-all px-1 text-[12.5px] leading-relaxed text-rose-600">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            )}
          </div>
        </div>

        {/* 快捷指令（有对话时也常驻一行，方便追加） */}
        {messages.length > 0 && (
          <div className="mx-auto flex w-full flex-shrink-0 gap-1.5 overflow-x-auto px-3 pb-1.5" style={colStyle}>
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q}
                onClick={() => setInput(q)}
                disabled={busy || generating}
                className="flex-shrink-0 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-500 transition hover:border-brand-200 hover:text-brand-700 disabled:opacity-40"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {/* 输入区 */}
        <div className="flex-shrink-0 border-t border-slate-100 px-3 py-2">
          {meetingRunning && routeChat && (
            <div className="mx-auto mb-1.5 w-full text-[12px] text-brand-600" style={colStyle}>
              会议进行中，此处发送的内容会作为插话进入讨论（可在会议页关闭）
            </div>
          )}
          <div className="mx-auto flex w-full items-end gap-2" style={colStyle}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder={
                restoringConv
                  ? '正在恢复单独对话的上下文…'
                  : meetingRunning && routeChat
                    ? '插话：会进入正在进行的会议讨论（Enter 发送）'
                    : '描述想要的舞台：地点、人物、氛围…（Enter 发送）'
              }
              className="min-w-0 flex-1 resize-none rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-2 text-[14px] leading-[1.7] text-slate-700 transition placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10"
            />
            {meetingRunning ? (
              <Button variant="danger" icon={<Square className="fill-current" />} onClick={() => useEditorialStore.getState().stopMeeting()} title="停止会议（保留已生成的发言）">
                停止会议
              </Button>
            ) : busy || generating ? (
              <Button variant="danger" icon={<Square className="fill-current" />} onClick={() => useEditorRoomStore.getState().stop()} title="停止当前生成（保留已生成部分）">
                停止
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<Send />}
                onClick={send}
                disabled={!input.trim() || restoringConv}
                title={restoringConv ? '正在恢复单独对话的上下文，请稍候' : undefined}
              >
                发送
              </Button>
            )}
          </div>
        </div>
        </>)}
      </div>
      {showDept && <EditorialDeptDialog onClose={() => setShowDept(false)} />}
      {analysisOpen && mode === 'chat' && chatEditor && (
        <LongTextAnalysisPanel
          key={chatEditor.id}
          editor={chatEditor}
          onClose={() => setAnalysisOpen(false)}
        />
      )}
    </div>
  );
}
