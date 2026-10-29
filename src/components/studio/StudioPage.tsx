/** 创作台页（#/studio）：地图式画布——🧑 人物节点 + 🏗 环境节点（建筑/房间/社区/城镇等，自由拖放摆位），画布即地图。
 *  规则/目标/卷章与大纲正文生成（双引擎分工：🏠 私有模型 / 🌐 公共模型）；编辑室为右侧 AI 对话面板。
 *  存档：localStorage persist（nc2-sim-v1）+ 本地命名快照（nc2-sim-archives-v1），不上传服务器。 */
import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  type Edge,
} from '@xyflow/react';
import {
  useStudioStore,
  useActiveBoard,
  useActiveNodes,
  useActiveEdges,
  selectActiveNodes,
  findContainerAt,
  findViewportDropPosition,
  absPositionOf,
  boardLabel,
  volumeBoardId,
  DEFAULT_BOARD_ID,
  DEFAULT_BOARD_LABEL,
  STAGE_BOARD_ID,
  STAGE_BOARD_LABEL,
  ENV_DEFAULT_W,
  ENV_DEFAULT_H,
} from '../../stores/studioStore';
import { useSimSessionStore, pauseSimSession } from '../../stores/simSessionStore';
import { StageSimBar } from './StageSimBar';
import { useEditorRoomStore } from '../../stores/editorRoomStore';
import { useEditorialStore } from '../../stores/editorialStore';
import { useUiStore } from '../../stores/uiStore';
import { chapterBoardOf } from '../../stores/chapterRegions';
import { characterReferenceSummary, referenceChapterText } from '../../stores/snapshotRefs';
import type { CharacterPlacementData, SimData, SimNodeType } from '../../types/sim';
import { ENV_TYPE_META, genderOf } from '../../types/sim';
import { DEFAULT_STATE_ID } from '../../stores/characterStates';
import { genRandomCharacter } from '../../engines/studioEngine';
import { GENDER_STYLE, simNodeTypes } from './SimNodes';
import { SimInspector } from './SimInspector';
import { EditorRoomPanel } from './EditorRoomPanel';
import { OutlineManager, VolumesDialog } from './OutlineManager';
import { ContentManager } from './ContentManager';
import { Bookshelf } from './Bookshelf';
import { CopyToVolumeDialog } from './CopyToVolumeDialog';
import { CharacterSearchDialog } from './CharacterSearchDialog';
import { CharacterLibraryPanel } from './CharacterLibraryPanel';
import { ChapterRegionsOverlay } from './ChapterRegionsOverlay';
import { useActiveChapterId } from './useActiveChapter';
import { beginChapterRegion } from './chapterRegionActions';
import { startChapterSceneSync } from '../../stores/chapterSceneSync';
import {
  saveLocal,
} from '../../services/studioSync';
import { useQwenStore } from '../../shared/qwenStore';
import { ModelCenterPanel } from './ModelCenterPanel';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Field, Textarea } from '../ui/Field';
import { Badge, StatusDot } from '../ui/Badge';
import {
  ArrowLeft,
  BookUser,
  Copy,
  Cpu,
  Dna,
  Eye,
  EyeOff,
  FileText,
  FolderPlus,
  Landmark,
  LibraryBig,
  ListTree,
  MessagesSquare,
  Save,
  ScrollText,
  Search,
  SlidersHorizontal,
  SquareDashed,
  Target,
  UserCheck,
  UserPlus,
} from 'lucide-react';

// 人物节点渲染前没有实测尺寸：落点居中/避让按经验尺寸估算（宽取人名最大宽，高取头像+人名）
const CHAR_NOMINAL_SIZE = { w: 144, h: 104 };

function StudioCanvas() {
  const storeNodes = useActiveNodes();
  const activeBoard = useActiveBoard();
  const activeBoardId = useStudioStore((s) => s.activeBoardId);
  // 🎬 推演：只在舞台画布把会话里的人物坐标**投影**到渲染层——
  //   绝不写回 boards（画布摆放保持不变；重置/切走即回到原位）。
  const onStage = activeBoardId === STAGE_BOARD_ID;
  const simSession = useSimSessionStore((s) => s.session);
  const actorPos = useMemo(() => {
    if (!onStage || !simSession) return null;
    return new Map(simSession.actors.map((a) => [a.nodeId, { x: a.x, y: a.y }]));
  }, [onStage, simSession]);
  // 环境节点：选中后才可拖动（锁定的除外）。
  // ⚠ React Flow 会给可拖动节点整个加 nopan——未选中环境若可拖动，拖动环境空白处会移动环境而不是平移画布，
  //   章节区域固定在世界坐标 → 看起来像区域和内容脱离。未选中时设为不可拖动，拖动即平移画布；
  //   点击选中后可正常拖动/缩放（缩放手柄也只在这种情况下出现）。
  // 推演期间整体冻结拖动：人物位置来自会话投影，环境几何是会话建世界时的快照，拖了就对不上。
  const nodes = useMemo(() => {
    const byId = new Map(storeNodes.map((n) => [n.id, n]));
    return storeNodes.map((n) => {
      if (n.data.kind === 'environment') {
        return { ...n, draggable: !simSession && n.selected === true && n.data.locked !== true };
      }
      const p = actorPos?.get(n.id);
      if (!p) return simSession ? { ...n, draggable: false } : n;
      // actor 存绝对坐标；RF 节点位置相对父容器 → 减父链偏移
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      const origin = parent ? absPositionOf(parent, byId) : { x: 0, y: 0 };
      return { ...n, position: { x: p.x - origin.x, y: p.y - origin.y }, draggable: false };
    });
  }, [storeNodes, actorPos, simSession]);
  const edges = useActiveEdges();
  const onNodesChange = useStudioStore((s) => s.onNodesChange);
  const onEdgesChange = useStudioStore((s) => s.onEdgesChange);
  const setBoardViewport = useStudioStore((s) => s.setBoardViewport);
  const regionDrawing = useUiStore((s) => s.regionDrawChapterId !== null);
  useActiveChapterId();
  // 切离舞台即暂停（会话保留，回来可继续）；离开创作台也停表，避免后台空转
  useEffect(() => {
    if (activeBoardId !== STAGE_BOARD_ID) pauseSimSession();
  }, [activeBoardId]);
  useEffect(() => () => pauseSimSession(), []);
  // 属性面板开关：用户拍板不随节点点击自动弹出，由顶栏「⚙ 属性」开/关（v2.4）
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // 作品书架：每次进入先见书架（着陆视图）；「打开 / 返回首页」也回到这里
  const [shelfOpen, setShelfOpen] = useState(true);
  // 🎬 当前章节场景自动跟随画布（名单/位置/父环境/状态），去抖写入内存，手动保存才落盘
  useEffect(() => {
    startChapterSceneSync();
  }, []);

  // 节点点击：Ctrl+点人物节点=插入人名到大纲管理器「本章需求」；点节点时退出区域选中
  const onNodeClick = useCallback((e: ReactMouseEvent, node: SimNodeType) => {
    useUiStore.getState().setSelectedRegionId(null);
    // ✎ Ctrl/Cmd+点人物节点：把人名插进「本章需求」光标处（OutlineManager 挂载时才监听，未开面板静默）
    if ((e.ctrlKey || e.metaKey) && node.data.kind === 'character') {
      // 人名读人物库（放置只是引用）
      const name = (useStudioStore.getState().characters[node.data.characterId]?.name || '').trim();
      if (name) window.dispatchEvent(new CustomEvent('sim-insert-char-name', { detail: name }));
    }
  }, []);

  // Del/Backspace 删除：环境删除自行 confirm；人物删除=仅移除放置（C5 非破坏，免确认），返回 false 阻止 RF 默认变更流
  const onBeforeDelete = useCallback(async ({ nodes: doomed }: { nodes: SimNodeType[]; edges: Edge[] }) => {
    if (!doomed.length) return true; // 仅选中边：走 RF 默认（直接删边）
    const st = useStudioStore.getState();
    const envs = doomed.filter((n) => n.data.kind === 'environment');
    if (envs.length) {
      const refLines = doomed
        .filter((n): n is SimNodeType & { data: CharacterPlacementData } => n.data.kind === 'character')
        .map((n) => {
          const ref = characterReferenceSummary(st.chapters, n.data.characterId);
          if (!ref.count) return '';
          const name = (st.characters[n.data.characterId]?.name || '未命名').trim();
          return `${name}：被 ${ref.count} 章引用（${referenceChapterText(ref, 4)}）`;
        })
        .filter(Boolean);
      const impact = refLines.length
        ? `\n\n章节名单引用：\n${refLines.join('\n')}\n被移除画布对应章节的场景会随之自动同步（历史章节保留采集记录）。`
        : '';
      const tip = `删除选中的 ${envs.length} 个环境（内部节点将提升回根层）${
        doomed.length > envs.length ? `，并把 ${doomed.length - envs.length} 个人物从本画布移除（人物与形象保留在人物库）` : ''
      }？${impact}`;
      if (!window.confirm(tip)) return false;
    }
    doomed.forEach((n) => st.deleteNode(n.id));
    return false; // 已自行删除，阻止 RF 默认变更
  }, []);

  // 拖拽落点重定父级（层级语义）：拖动停止时若「中心点」落在某个环境节点内 → 成为它的子节点（随父移动）；
  // 移出（含拖出原父容器）→ 提升回根层；中心没进但矩形与容器重叠 ≥45% 也算放进去了（贴边放置不漏判）。
  // 框选多个一起拖 = 整组逐个判归入：祖先也在拖拽集的子项随祖先走（不拆家）。
  // ⚠ 坐标/尺寸一律以 store 为基准（拖拽期间 position/dimensions change 已实时写入 store）：
  //   曾用 reactFlow.getInternalNode 取绝对坐标，取不到时退回 dragged.position——对已嵌套子节点那是
  //   **相对父坐标**，被误当绝对坐标 → 判定点错乱 → 识别不准/瞬移（拖进去不见）/挂错容器不跟随（v2.17a 修复）。
  const onNodeDragStop = useCallback(
    (_e: unknown, node: SimNodeType, nodes: SimNodeType[]) => {
      const st = useStudioStore.getState();
      const boardNodes = selectActiveNodes(st);
      const draggedSet = new Set((nodes?.length ? nodes : [node]).map((n) => n.id));
      const byId = new Map(boardNodes.map((n) => [n.id, n]));
      for (const dragged of boardNodes) {
        if (!draggedSet.has(dragged.id)) continue;
        // 祖先也在拖拽集中 → 随祖先整体走，只判拖拽集顶层
        const guard = new Set<string>([dragged.id]);
        let p = dragged.parentId;
        let withAncestor = false;
        while (p && !guard.has(p)) {
          guard.add(p);
          if (draggedSet.has(p)) {
            withAncestor = true;
            break;
          }
          p = byId.get(p)?.parentId;
        }
        if (withAncestor) continue;
        const abs = absPositionOf(dragged, byId);
        const w = dragged.width ?? dragged.measured?.width ?? 0;
        const h = dragged.height ?? dragged.measured?.height ?? 0;
        const container = findContainerAt(boardNodes, abs.x + w / 2, abs.y + h / 2, dragged.id, {
          x: abs.x,
          y: abs.y,
          w,
          h,
        });
        st.reparentNode(dragged.id, container?.id ?? null);
      }
    },
    [],
  );

  return (
    <div className="w-screen h-screen overflow-hidden bg-slate-50">
      <ReactFlow
        key={activeBoardId}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onBeforeDelete={onBeforeDelete}
        onNodeClick={onNodeClick}
        onPaneClick={() => useUiStore.getState().setSelectedRegionId(null)}
        nodeTypes={simNodeTypes}
        deleteKeyCode={regionDrawing ? null : ['Delete', 'Backspace']}
        nodesDraggable={!regionDrawing}
        nodesConnectable={!regionDrawing}
        elementsSelectable={!regionDrawing}
        panOnDrag={!regionDrawing}
        zoomOnScroll={!regionDrawing}
        zoomOnPinch={!regionDrawing}
        zoomOnDoubleClick={false}
        // 每张画布独立视口：有保存值就恢复，没有则首次进入自动 fitView；切换时按 key 重挂载避免旧实例回写
        defaultViewport={activeBoard?.viewport}
        fitView={!activeBoard?.viewport}
        fitViewOptions={{ padding: 0.3, maxZoom: 0.9 }}
        onMoveEnd={(_, vp) => setBoardViewport(activeBoardId, vp)}
        minZoom={0.15}
        maxZoom={1.6}
        className="bg-slate-50"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#dbe2ea" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          className="!bg-white/80 !rounded-lg !shadow-lg"
          nodeColor={(node) => {
            const d = node.data as SimData;
            // 人物性别读人物库（放置无性别字段；小地图点色随库同步：男蓝=默认/女玫红），环境按类型点色（v2.18）
            if (d.kind === 'character') {
              const character = useStudioStore.getState().characters[d.characterId];
              return GENDER_STYLE[genderOf(character?.gender)].dot;
            }
            return ENV_TYPE_META[d.etype]?.dot ?? '#64748b';
          }}
        />
      </ReactFlow>
      <ChapterRegionsOverlay enabled={!shelfOpen} />
      {!shelfOpen && nodes.length === 0 && (
        // 空画布引导（不挡交互；书架打开期间不显示）
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
          <div className="max-w-xl text-center text-slate-400">
            <p className="text-[14px] font-semibold text-slate-500">在画布上搭建你的故事世界</p>
            <p className="mt-2 text-[13px] leading-relaxed">
              用顶栏「人物」「环境」创建节点；「属性」打开左侧面板，编辑名称、类型与基础信息/身份信息——节点面上只展示、不直接输入。
              <br />
              写清「目标」与「规则」，在大纲里分卷、添加章节并生成大纲，再按大纲生成正文。
              <br />
              选中环境后拖角缩放；把环境拖进另一个环境形成层级（镇 → 建筑 → 房间），人物永远浮在环境之上。
            </p>
          </div>
        </div>
      )}
      <SimInspector open={inspectorOpen} onClose={() => setInspectorOpen(false)} />
      {!shelfOpen && onStage && <StageSimBar />}
      {!shelfOpen && (
        <SimBar inspectorOpen={inspectorOpen} onToggleInspector={() => setInspectorOpen((v) => !v)} onOpenShelf={() => setShelfOpen(true)} />
      )}
      {shelfOpen && <Bookshelf onClose={() => setShelfOpen(false)} />}
    </div>
  );
}

// ── 全文规则对话框（世界级约束，只此一条；章节大纲规则在「大纲」管理器内单独编辑） ──

function RulesDialog({ onClose }: { onClose: () => void }) {
  const rules = useStudioStore((s) => s.rules);
  return (
    <Dialog
      onClose={onClose}
      width="lg"
      icon={<ScrollText />}
      title="全文规则"
      subtitle={
        <>
          只规定两点：<b>世界法则</b>（这个世界如何运作的规律、约束与代价）与<b>写作文风</b>（叙述、语言、节奏的写法要求）。
          故事走向不写在这里——统一方向用「全文目标」表达。随地图存档保存；<b>正文生成</b>遵守（编辑室与大纲生成不注入规则）；
          <b>章节大纲规则</b>在「章节大纲」管理器内单独设置。
        </>
      }
      footer={
        <Button variant="primary" onClick={onClose}>
          完成
        </Button>
      }
    >
      <Field label="全文规则（世界法则 / 写作文风）" counter={`${rules.length}/3000`}>
        <Textarea
          value={rules}
          onChange={(e) => useStudioStore.getState().setRules(e.target.value)}
          maxLength={3000}
          rows={12}
          placeholder={
            '例：\n· 这是一个人人躺平的修仙世界——灵气充裕到无人苦修，宗门排名比的是谁躺得更快；境界越高越懒，斗法全靠傀儡和嘴炮\n· 文风：轻松诙谐、反差幽默；短句为主，对话推动剧情；避免说教和大段独白'
          }
        />
      </Field>
    </Dialog>
  );
}

// ── 人物生成规则对话框（「＋人物」随机生成 + 编辑室批量设计人物共用；随地图存档） ──

function CharRulesDialog({ onClose }: { onClose: () => void }) {
  const charGenRules = useStudioStore((s) => s.charGenRules);
  return (
    <Dialog
      onClose={onClose}
      width="lg"
      icon={<Dna />}
      title="人物规则"
      subtitle={
        <>
          规定如何随机生成人物（出身/性格/命名/性别分布等要求）。<b>规则存在时，每次点「＋ 人物」自动按规则随机生成一个人物</b>；
          编辑室批量设计人物时同样遵守。规则为空则「＋ 人物」只创建空白节点。随地图存档保存。
        </>
      }
      footer={
        <Button variant="primary" onClick={onClose}>
          完成
        </Button>
      }
    >
      <Field label="人物生成规则" counter={`${charGenRules.length}/1000`}>
        <Textarea
          value={charGenRules}
          onChange={(e) => useStudioStore.getState().setCharGenRules(e.target.value)}
          maxLength={1000}
          rows={10}
          placeholder={
            '例：\n· 修仙世界散修，境界随机（练气~金丹）；名字 2~3 字中式名，不与已有人物重名\n· 每人一个与「躺平」相关的怪癖；性格随机（社恐/话痨/戏精…）\n· 性别男女随机；年龄 16~88 岁；背景与本地图的环境相关'
          }
        />
      </Field>
    </Dialog>
  );
}

// ── 全文目标对话框（几句话写明整部小说的主要目标——各处生成的统一方向；v2.16，随地图存档） ──

function GoalDialog({ onClose }: { onClose: () => void }) {
  const mainGoal = useStudioStore((s) => s.mainGoal);
  return (
    <Dialog
      onClose={onClose}
      width="lg"
      icon={<Target />}
      title="全文目标"
      subtitle={
        <>
          用几句话写明这部小说的主要目标（要讲一个什么样的故事、最终达成什么）。<b>所有生成都会带上它作为统一方向</b>：
          编辑室、章节大纲、正文、随机人物。章节间的整体方向用「卷」表达（在「章节大纲」管理器里分卷并写卷介绍，控制整卷各章大纲）。
          随地图存档保存。
        </>
      }
      footer={
        <Button variant="primary" onClick={onClose}>
          完成
        </Button>
      }
    >
      <Field label="全文目标（几句话，整部小说的统一方向）" counter={`${mainGoal.length}/500`}>
        <Textarea
          value={mainGoal}
          onChange={(e) => useStudioStore.getState().setMainGoal(e.target.value)}
          maxLength={500}
          rows={8}
          placeholder={
            '例：\n· 讲一个躺平散修被迫一路「卷赢」的故事——用爆笑的方式写出「内卷无意义」\n· 最终目标：主角以躺平哲学化解宗门大战，全书收束于「无为而治」的爽点结局\n· 读者读完的感受：爽、轻松、想安利朋友'
          }
        />
      </Field>
    </Dialog>
  );
}

// ── 顶栏：跨页导航 / 图名 / 存档 / ⚙ 属性开关 / ＋人物 / ＋环境 ──

function SimBar({ inspectorOpen, onToggleInspector, onOpenShelf }: { inspectorOpen: boolean; onToggleInspector: () => void; onOpenShelf: () => void }) {
  const graphName = useStudioStore((s) => s.graphName);
  const saveStatus = useUiStore((s) => s.saveStatus);
  const saveMsg = useUiStore((s) => s.saveMsg);
  const modelCenterOpen = useUiStore((s) => s.modelCenterOpen);
  const [agentOpen, setAgentOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [charRulesOpen, setCharRulesOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [contentOpen, setContentOpen] = useState(false);
  const [volumesOpen, setVolumesOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [charSearchOpen, setCharSearchOpen] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
  const characterCount = useStudioStore((s) => Object.keys(s.characters).length);
  // 🗂 多卷画布：标签 = 默认主画布 + 各卷画布（异常数据里的未关联画布也保留显示）
  const boards = useStudioStore((s) => s.boards);
  const volumes = useStudioStore((s) => s.volumes);
  const activeBoardId = useStudioStore((s) => s.activeBoardId);
  const activeBoardNodes = useStudioStore((s) => s.boards[s.activeBoardId]?.nodes);
  const selectedCount = activeBoardNodes?.filter((n) => n.selected).length ?? 0;
  const volumeTabs = volumes.map((v) => {
    const id = volumeBoardId(v.id);
    return { id, label: v.title || '未命名卷', count: boards[id]?.nodes.length ?? 0 };
  });
  const knownBoardIds = new Set<string>([DEFAULT_BOARD_ID, STAGE_BOARD_ID, ...volumeTabs.map((t) => t.id)]);
  const orphanBoards = Object.values(boards)
    .filter((b) => !knownBoardIds.has(b.id))
    .map((b) => ({ id: b.id, label: boardLabel(b, volumes), count: b.nodes.length }));
  const switchToBoard = (boardId: string) => {
    if (boardId === activeBoardId) return;
    const st = useStudioStore.getState();
    // 切标签前保存当前视口；新画布由 keyed ReactFlow 用保存的 viewport 恢复/自动 fitView
    if (st.boards[activeBoardId]) st.saveActiveViewport(reactFlow.getViewport());
    st.switchBoard(boardId);
  };
  const addVolumeBoard = () => {
    const st = useStudioStore.getState();
    if (st.boards[activeBoardId]) st.saveActiveViewport(reactFlow.getViewport());
    st.addVolume();
  };
  // 📜 已设全文规则徽标：非空即亮（amber）；章节大纲规则徽标在大纲管理器内
  const hasRules = useStudioStore((s) => !!s.rules.trim());
  // 🧬 已设人物生成规则徽标：非空即亮（amber）——＋人物会自动随机生成
  const hasCharRules = useStudioStore((s) => !!s.charGenRules.trim());
  // 🎯 已设全文目标徽标：非空即亮（amber）——各处生成注入统一方向
  const hasMainGoal = useStudioStore((s) => !!s.mainGoal.trim());
  // 🏛 作品责任编辑（v2.21）：顶栏选择、随作品存档——其职责与对应技能记忆注入各处生成与总编辑对话
  const responsibleId = useStudioStore((s) => s.responsibleId);
  const localEditors = useEditorialStore((s) => s.localEditors);
  const serverEditors = useEditorialStore((s) => s.serverEditors);
  const editorOptions = useMemo(() => [...localEditors, ...serverEditors].filter((e) => e.enabled), [localEditors, serverEditors]);
  // 📋 章节数（大纲管理器入口徽标）
  const chapters = useStudioStore((s) => s.chapters);
  const chapterCount = chapters.length;
  // 📝 已成文章节数（正文管理器入口徽标）
  const contentCount = chapters.reduce((a, c) => a + (c.content.trim() ? 1 : 0), 0);
  // 📐 当前章节区域：顶栏按钮直接绑定当前章，自动切到所属卷画布
  const activeChapterId = useActiveChapterId();
  const activeChapter = chapters.find((c) => c.id === activeChapterId);
  const chapterRegionBoardId = activeChapterId
    ? chapterBoardOf(activeChapter?.volumeId, volumes, boards)
    : '';
  const chapterHasRegion =
    !!chapterRegionBoardId &&
    !!boards[chapterRegionBoardId]?.regions.some((r) => r.chapterId === activeChapterId);
  const regionDrawing = useUiStore((s) => s.regionDrawChapterId !== null);
  const regionsVisible = useUiStore((s) => s.regionsVisible);
  const totalRegions = Object.values(boards).reduce((a, b) => a + b.regions.length, 0);
  // Qwen 引擎可达性（全站共用 qwenStore；两个独立 selector，避免整对象重渲染）
  const qwenStatus = useQwenStore((s) => s.status);
  const qwenMsg = useQwenStore((s) => s.msg);
  const reactFlow = useReactFlow();

  // 挂载即后台探测一次：⚡ 徽章立刻有意义，也预热 ensureOnline 的 60s 新鲜缓存
  useEffect(() => {
    void useQwenStore.getState().check();
    // 正式编辑列表只在内存缓存：进创作台即拉取，顶栏「👤 责编」与「🏛 编辑部」才能看到全部正式编辑
    void useEditorialStore.getState().loadServerEditors();
  }, []);

  // 手动保存快捷键：Ctrl/Cmd+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveLocal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 手动保存：有未保存改动或上次保存失败时，刷新/关闭前让浏览器弹出离开确认（只提示，不自动保存）
  useEffect(() => {
    if (saveStatus !== 'unsaved' && saveStatus !== 'error') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveStatus]);

  // 地图落点：当前可视区域中心（按节点尺寸居中；附近小范围错开避免叠死，且始终在可视区内）
  const dropPos = (size: { w: number; h: number }) => {
    const tl = reactFlow.screenToFlowPosition({ x: 0, y: 0 });
    const br = reactFlow.screenToFlowPosition({ x: window.innerWidth, y: window.innerHeight });
    return findViewportDropPosition(selectActiveNodes(useStudioStore.getState()), { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }, size);
  };

  // 创建节点：落点在某个环境容器内 → 创建即归入（与拖放嵌套语义一致）
  const addNode = (kind: 'character' | 'environment') => {
    const st = useStudioStore.getState();
    const size = kind === 'environment' ? { w: ENV_DEFAULT_W, h: ENV_DEFAULT_H } : CHAR_NOMINAL_SIZE;
    const pos = dropPos(size);
    if (kind === 'environment') {
      const id = st.createEnvironment(pos);
      // ⚠ excludeId=新节点自身：判定点取新节点中心，不排除会「创建即挂到自己」
      // （self-parent + 相对坐标 {0,0}，RF12 定位坏掉 → 节点凭空消失，v2.1 踩坑）
      const container = findContainerAt(selectActiveNodes(useStudioStore.getState()), pos.x + size.w / 2, pos.y + size.h / 2, id);
      if (container) st.reparentNode(id, container.id);
      return;
    }
    // 📇 v3 人物库：创建=建库记录+放置到当前画布（createCharacter 返回库 ID，放置节点随建即选中）
    const characterId = st.createCharacter({ placeOnBoardId: st.activeBoardId, pos, select: true });
    const nodes = selectActiveNodes(useStudioStore.getState());
    const nodeId = nodes.find((n) => n.data.kind === 'character' && n.data.characterId === characterId)?.id;
    if (nodeId) {
      const container = findContainerAt(nodes, pos.x + size.w / 2, pos.y + size.h / 2, nodeId);
      if (container) st.reparentNode(nodeId, container.id);
    }
    // 🧬 人物生成规则存在 → ＋人物自动按规则随机生成（v2.15）：先落空放置（位置/嵌套照旧），生成完填库
    void autoFillCharacter(characterId);
  };

  // 🧬 人物自动生成填充：占位「生成中…」→ 成功填名字/性别/基础信息/身份信息；失败/互斥回空人物可手填（不吞掉放置）
  const autoFillCharacter = async (characterId: string) => {
    const st = useStudioStore.getState();
    if (!st.charGenRules.trim()) return;
    st.updateCharacter(characterId, { name: '生成中…' });
    const engine = useEditorRoomStore.getState().settings.engine;
    // 🏛 作品责任编辑：注入其职责与该模块技能记忆（v2.21）
    const responsible = useEditorialStore.getState().getWorkResponsibleData('人物生成');
    const r = await genRandomCharacter({ engine, ...(responsible ? { responsible } : {}) });
    const s2 = useStudioStore.getState();
    if (r.ok && r.block) {
      const gender = genderOf(r.block.gender);
      s2.updateCharacter(characterId, { name: r.block.name, gender });
      // 显式写状态0：生成期间用户若新建/切换了状态，也不会把随机属性写进别的状态。
      // 新人物默认没有形象，画布先显示性别剪影，由用户上传/生成后再裁头像。
      s2.updateCharacterState(
        characterId,
        {
          age: r.block.age,
          basicInfo: r.block.basicInfo ?? '',
          identityInfo: r.block.identityInfo ?? '',
          relations: r.block.relations,
        },
        DEFAULT_STATE_ID,
      );
    } else {
      s2.updateCharacter(characterId, { name: '' });
      if (r.error && r.error !== '已有生成任务进行中') window.alert(`⚠ 人物自动生成失败：${r.error}（已保留空白人物，可手动填写）`);
    }
  };

  const saveTone: 'ok' | 'warn' | 'down' = saveStatus === 'error' ? 'down' : saveStatus === 'unsaved' ? 'warn' : 'ok';
  const qwenTone = qwenStatus === 'ok' ? 'ok' : qwenStatus === 'down' ? 'down' : qwenStatus === 'checking' ? 'warn' : 'idle';
  const qwenLabel =
    qwenStatus === 'checking' ? '检测中' : qwenStatus === 'ok' ? `在线 ${qwenMsg}` : qwenStatus === 'down' ? '离线' : '检测';

  return (
    <>
      {/* 两级顶栏：第一行作品身份与主操作，第二行写作/画布工具（窄屏横向滚动） */}
      <div className="fixed left-2 right-2 top-2 z-40 sm:left-1/2 sm:right-auto sm:top-4 sm:w-[min(calc(100vw-2rem),1180px)] sm:-translate-x-1/2">
        <div className="overflow-hidden rounded-[16px] border border-slate-200/80 bg-white/95 shadow-float backdrop-blur">
          {/* 第一行：返回 / 作品名 / 保存状态 / 保存 + 属性、模型、编辑室 */}
          <div className="flex h-12 items-center gap-1.5 px-2 sm:gap-2 sm:px-3">
            <button
              onClick={onOpenShelf}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
              title="返回作品书架"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <input
              value={graphName}
              onChange={(e) => useStudioStore.getState().setGraphName(e.target.value)}
              title="作品名（保存用）"
              placeholder="未命名作品"
              className="h-8 w-24 min-w-0 shrink rounded-[8px] border border-transparent bg-transparent px-1.5 text-[14px] font-semibold text-slate-800 transition hover:border-slate-200 focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10 sm:w-44"
            />
            <span
              className={`flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] ${
                saveStatus === 'error' ? 'text-rose-500' : saveStatus === 'unsaved' ? 'text-amber-600' : 'text-slate-400'
              }`}
            >
              <StatusDot tone={saveTone} pulse={false} />
              <span className="max-sm:hidden">{saveMsg}</span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              icon={<Save />}
              onClick={() => saveLocal()}
              title="保存当前作品到本机（同时更新作品进度与命名存档；Ctrl/Cmd+S）"
              className="max-sm:px-2"
            >
              <span className="max-sm:hidden">保存</span>
            </Button>
            <span className="flex-1" />
            <Button
              size="sm"
              variant={inspectorOpen ? 'soft' : 'ghost'}
              icon={<SlidersHorizontal />}
              onClick={onToggleInspector}
              title="打开/关闭左侧属性面板（选中节点后在此编辑名称/类型与基础信息/身份信息）"
              className="max-sm:px-2"
            >
              <span className="max-sm:hidden">属性</span>
            </Button>
            <button
              onClick={() => useUiStore.getState().setModelCenterOpen(true)}
              title={`模型中心：文本/推理/生图统一配置（私有模型：${qwenMsg || '未检测'}）`}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] border border-slate-200 bg-white px-2 text-[13px] text-slate-600 transition hover:bg-slate-50 sm:px-2.5"
            >
              <StatusDot tone={qwenTone} pulse={qwenStatus === 'checking'} />
              <Cpu className="h-4 w-4 shrink-0 text-slate-400" />
              <span className="max-sm:hidden">{qwenLabel}</span>
            </button>
            <Button
              size="sm"
              variant={agentOpen ? 'primary' : 'soft'}
              icon={<MessagesSquare />}
              onClick={() => setAgentOpen((v) => !v)}
              title="编辑室（右侧 AI 对话：让 AI 设计人物/环境/设定，一键落为画布节点）"
              className="max-sm:px-2"
            >
              <span className="max-sm:hidden">编辑室</span>
            </Button>
          </div>

          {/* 第二行：书架（打开/新建都在书架中完成） · 写作 · 画布 · 责编 */}
          <div className="flex h-9 items-center gap-1 overflow-x-auto border-t border-slate-100 bg-slate-50/70 px-2 [scrollbar-width:none] sm:gap-1.5 sm:px-3 [&::-webkit-scrollbar]:hidden">
            <Button
              size="sm"
              variant="ghost"
              icon={<LibraryBig />}
              onClick={onOpenShelf}
              title="作品书架：打开已有作品或新建作品"
            >
              书架
            </Button>
            <span className="mx-0.5 h-4 w-px shrink-0 bg-slate-200" />
            <Button
              size="sm"
              variant={hasRules ? 'soft' : 'ghost'}
              icon={<ScrollText />}
              onClick={() => setRulesOpen(true)}
              title="全文规则：规定小说世界的法则与写作文风（正文生成遵守；随地图存档）"
            >
              规则
              {hasRules && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />}
            </Button>
            <Button
              size="sm"
              variant={hasCharRules ? 'soft' : 'ghost'}
              icon={<Dna />}
              onClick={() => setCharRulesOpen(true)}
              title="人物规则：规定如何随机生成人物——规则存在时「＋人物」自动随机生成；编辑室批量设计人物也遵守（随地图存档）"
            >
              人物规则
              {hasCharRules && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />}
            </Button>
            <Button
              size="sm"
              variant={hasMainGoal ? 'soft' : 'ghost'}
              icon={<Target />}
              onClick={() => setGoalOpen(true)}
              title="全文目标：几句话写明整部小说的主要目标——所有生成都会带上它作为统一方向（随地图存档）"
            >
              目标
              {hasMainGoal && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />}
            </Button>
            <span className="mx-0.5 h-4 w-px shrink-0 bg-slate-200" />
            <Button
              size="sm"
              variant="ghost"
              icon={<ListTree />}
              onClick={() => setOutlineOpen(true)}
              title="章节大纲管理器（半页浮层）：添加章节、写本章需求、按章节大纲规则生成大纲（章节大纲规则在此设置）"
            >
              大纲
              {chapterCount > 0 && <Badge className="h-4 px-1.5 text-[11px]">{chapterCount}</Badge>}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<FileText />}
              onClick={() => setContentOpen(true)}
              title="正文管理器（半页浮层）：按本章大纲生成正文——本章大纲已生成后，对应章节的生成正文才可点击"
            >
              正文
              {contentCount > 0 && <Badge className="h-4 px-1.5 text-[11px]">{contentCount}</Badge>}
            </Button>
            <span className="mx-0.5 h-4 w-px shrink-0 bg-slate-200" />
            <Button
              size="sm"
              variant="ghost"
              icon={<UserPlus />}
              onClick={() => addNode('character')}
              title={hasCharRules ? '新建人物（已设人物规则：自动按规则随机生成人物）' : '新建人物节点（选中后在左侧属性面板填人名/基础信息/身份信息）'}
            >
              人物
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Landmark />}
              onClick={() => addNode('environment')}
              title="新建环境节点（选中后拖角缩放；属性在左侧面板编辑）"
            >
              环境
            </Button>
            <Button
              size="sm"
              variant={regionDrawing ? 'primary' : chapterHasRegion ? 'soft' : 'ghost'}
              icon={<SquareDashed />}
              disabled={!activeChapterId}
              onClick={() => {
                if (regionDrawing) {
                  useUiStore.getState().cancelRegionDraw();
                  return;
                }
                const r = beginChapterRegion(activeChapterId, { viewport: reactFlow.getViewport() });
                if (!r.ok) window.alert(r.message);
              }}
              title={
                !activeChapterId
                  ? '还没有章节：先到「大纲」添加章节'
                  : regionDrawing
                    ? '取消绘制章节区域'
                    : chapterHasRegion
                      ? `定位《${activeChapter?.title.trim() || '未命名章节'}》的区域`
                      : `为《${activeChapter?.title.trim() || '未命名章节'}》画区域（自动切到章节所属卷画布）`
              }
            >
              区域
            </Button>
            <Button
              size="icon"
              variant={regionsVisible ? 'ghost' : 'soft'}
              icon={regionsVisible ? <Eye /> : <EyeOff />}
              disabled={totalRegions === 0}
              onClick={() => useUiStore.getState().setRegionsVisible(!regionsVisible)}
              title={regionsVisible ? '隐藏所有章节区域' : '显示所有章节区域'}
              aria-label={regionsVisible ? '隐藏章节区域' : '显示章节区域'}
            />
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy />}
              disabled={selectedCount === 0}
              onClick={() => setCopyOpen(true)}
              title={
                selectedCount
                  ? `把当前画布选中的 ${selectedCount} 个节点复制到其它卷画布`
                  : '先在画布上选中要复制的节点'
              }
            >
              复制到卷
            </Button>
            <label
              className="flex h-8 shrink-0 items-center gap-1 rounded-[10px] border border-slate-200 bg-white px-2 text-slate-600"
              title="作品责任编辑：把关本作品——其职责与对应能力的技能记忆会注入大纲/正文/人物等生成与总编辑对话（随作品存档）"
            >
              <UserCheck className="h-4 w-4 shrink-0 text-slate-400" />
              <select
                value={responsibleId}
                onChange={(e) => useStudioStore.getState().setResponsibleId(e.target.value)}
                className="max-w-[120px] cursor-pointer bg-transparent text-[13px] text-slate-600 focus:outline-none"
              >
                <option value="">责编：未设置</option>
                {editorOptions.map((e) => (
                  <option key={e.id} value={e.id}>
                    责编：{e.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="w-1 shrink-0" />
          </div>
          {/* 第三行：卷画布标签——默认主画布 | 各卷（节点数） | ＋卷 | 管理卷 */}
          <div className="flex h-9 items-center gap-1 overflow-x-auto border-t border-slate-100 bg-white/70 px-2 [scrollbar-width:none] sm:gap-1.5 sm:px-3 [&::-webkit-scrollbar]:hidden">
            <span className="shrink-0 text-[11px] text-slate-400">画布</span>
            <button
              data-cross-board-search
              onClick={() => setCharSearchOpen(true)}
              title="跨卷查人：按人名搜索全部画布人物，定位或查看人物时间轴"
              className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 text-[12px] text-slate-500 transition hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-700"
            >
              <Search className="h-3 w-3" strokeWidth={1.75} />
              查人
            </button>
            <button
              data-character-library-open
              onClick={() => setLibOpen(true)}
              title="人物库：作品级人物唯一管理（身份写一处全局生效；状态按画布放置显示）"
              className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 text-[12px] text-slate-500 transition hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-700"
            >
              <BookUser className="h-3 w-3" strokeWidth={1.75} />
              人物库
              {characterCount > 0 && <span className="text-[10px] tabular-nums opacity-70">{characterCount}</span>}
            </button>
            <button
              onClick={() => switchToBoard(DEFAULT_BOARD_ID)}
              title="默认主画布：未分卷章节与旧单画布内容（所有画布节点合计会显示在属性面板）"
              className={`flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] transition ${
                activeBoardId === DEFAULT_BOARD_ID
                  ? 'border-brand-500/40 bg-brand-50 font-medium text-brand-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              {DEFAULT_BOARD_LABEL}
              {boards[DEFAULT_BOARD_ID] && (
                <span className="text-[10px] tabular-nums opacity-70">{boards[DEFAULT_BOARD_ID].nodes.length}</span>
              )}
            </button>
            {/* 🎬 舞台：剧情推演专用画布（固定一张，不参与卷派生；推演只在这里发生） */}
            <button
              data-stage-board-tab
              onClick={() => switchToBoard(STAGE_BOARD_ID)}
              title="舞台：剧情推演专用画布——放环境与人物，点「开始推演」看人物自主走动/张望/休息（推演不修改画布摆放）"
              className={`flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] transition ${
                activeBoardId === STAGE_BOARD_ID
                  ? 'border-brand-500/40 bg-brand-50 font-medium text-brand-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              {STAGE_BOARD_LABEL}
              {boards[STAGE_BOARD_ID] && (
                <span className="text-[10px] tabular-nums opacity-70">{boards[STAGE_BOARD_ID].nodes.length}</span>
              )}
            </button>
            {volumeTabs.map((t) => (
              <button
                key={t.id}
                onClick={() => switchToBoard(t.id)}
                title={`${t.label}（${t.count} 个节点）`}
                className={`flex h-6 max-w-[180px] shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] transition ${
                  activeBoardId === t.id
                    ? 'border-brand-500/40 bg-brand-50 font-medium text-brand-700'
                    : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                <span className="truncate">{t.label}</span>
                <span className="text-[10px] tabular-nums opacity-70">{t.count}</span>
              </button>
            ))}
            {orphanBoards.map((t) => (
              <button
                key={t.id}
                onClick={() => switchToBoard(t.id)}
                title="未关联卷的异常画布（数据仍保留，可复制节点后自行清理）"
                className={`flex h-6 max-w-[180px] shrink-0 items-center gap-1 rounded-full border border-dashed px-2.5 text-[12px] transition ${
                  activeBoardId === t.id
                    ? 'border-amber-400 bg-amber-50 font-medium text-amber-700'
                    : 'border-slate-300 bg-white text-slate-400 hover:bg-slate-50'
                }`}
              >
                <span className="truncate">{t.label}</span>
                <span className="text-[10px] tabular-nums opacity-70">{t.count}</span>
              </button>
            ))}
            <button
              onClick={addVolumeBoard}
              title="新建一卷并创建空白卷画布（自动切到新画布）"
              className="flex h-6 shrink-0 items-center gap-0.5 rounded-full border border-dashed border-slate-300 px-2 text-[12px] text-slate-500 transition hover:border-brand-400 hover:bg-brand-50/50 hover:text-brand-700"
            >
              <FolderPlus className="h-3 w-3" strokeWidth={1.75} />卷
            </button>
            <button
              onClick={() => setVolumesOpen(true)}
              title="管理卷：改名/介绍/删除（删除会一并删除该卷画布与节点）"
              className="flex h-6 shrink-0 items-center rounded-full px-2 text-[12px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              管理卷
            </button>
            <span className="w-1 shrink-0" />
          </div>
        </div>
      </div>
      {rulesOpen && <RulesDialog onClose={() => setRulesOpen(false)} />}
      {charRulesOpen && <CharRulesDialog onClose={() => setCharRulesOpen(false)} />}
      {goalOpen && <GoalDialog onClose={() => setGoalOpen(false)} />}
      {outlineOpen && <OutlineManager onClose={() => setOutlineOpen(false)} />}
      {contentOpen && <ContentManager onClose={() => setContentOpen(false)} />}
      {volumesOpen && <VolumesDialog onClose={() => setVolumesOpen(false)} />}
      {copyOpen && <CopyToVolumeDialog onClose={() => setCopyOpen(false)} />}
      {charSearchOpen && <CharacterSearchDialog onClose={() => setCharSearchOpen(false)} />}
      {libOpen && <CharacterLibraryPanel onClose={() => setLibOpen(false)} />}
      {agentOpen && <EditorRoomPanel onClose={() => setAgentOpen(false)} />}
      {modelCenterOpen && (
        <ModelCenterPanel
          onClose={() => {
            useUiStore.getState().setModelCenterOpen(false);
            void useQwenStore.getState().check(); // 配置可能已改，重探刷新徽章
          }}
        />
      )}
    </>
  );
}

export function StudioPage() {
  return (
    <ReactFlowProvider>
      <StudioCanvas />
    </ReactFlowProvider>
  );
}
