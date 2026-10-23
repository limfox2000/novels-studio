/** 🎭 编辑室右侧停靠面板（创作台页内浮层）：AI 对话搭建故事舞台。
 *  流式回复、停止/重生成/复制/删除/清空、⚙ 设置（列宽/压缩/📜附带规则与目标——v2.19 默认不注入规则/目标；模型与推理统一移到「模型中心」，v2.27）、历史持久化（nc2-sim-agent-v1）；
 *  回复带【人物设定】/【环境设定】块时气泡下方出「📎 落为人物/环境」按钮——创建节点、填好属性、
 *  落点在某环境内自动归入嵌套（与顶栏创建同语义）；带【区域规划】块时出「📎 落为规划」——
 *  容器+N 座建筑整组落地，建筑按 AI 给的大小/位置摆好并自动成为容器子节点（v2.7）。
 *  关面板不中断生成，重开继续看流式进度。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useEditorRoomStore, type EditorRoomMessage, type EditorRoomSettings } from '../../stores/editorRoomStore';
import { useStudioStore, findContainerAt } from '../../stores/studioStore';
import { useUiStore } from '../../stores/uiStore';
import { REASONING_EFFORT_LABEL } from '../../shared/qwenClient';
import { genImage, type EditorRoomBlock, type ResponsibleEditor, type SimBlock, type SimImageBlock, type SimPlanBlock, type SimVolumeBlock } from '../../engines/studioEngine';
import { SimWriteButtons } from './SimWriteButtons';
import { pickRandomCharAsset } from '../../services/charAssetApi';
import { localImgGet, localImgSaveFromUrl } from '../../services/localImages';
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
  Send,
  Settings2,
  Square,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';

/** 极简排版：转义后仅渲染 **加粗**（配合 whitespace-pre-wrap 保留换行） */
function fmt(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

/** token 数缩写：1234 → 1.2K，1234567 → 1.2M */
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

function SimBlockDropRow({ msg }: { msg: EditorRoomMessage }) {
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [doneMsg, setDoneMsg] = useState('');
  const reactFlow = useReactFlow();
  if (!msg.blocks?.length) return null;

  // 视口中心级进落点（与顶栏 ＋人物/＋环境 一致）
  const centerPos = () => {
    const c = reactFlow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const n = useStudioStore.getState().nodes.length;
    return { x: c.x + n * 24, y: c.y + n * 24 };
  };

  const drop = (b: EditorRoomBlock, i: number) => {
    setDoneMsg('');
    const st = useStudioStore.getState();
    const pos = centerPos();
    const id = b.kind === 'character' ? st.createCharacter(pos) : st.createEnvironment(pos);
    if (b.kind === 'character') {
      const gender = b.gender ?? 'male';
      st.updateCharacter(id, {
        name: b.name,
        gender,
        age: b.age,
        basicInfo: b.basicInfo ?? '',
        identityInfo: b.identityInfo ?? '',
        relations: b.relations,
      });
      void pickRandomCharAsset(gender === 'female' ? '女' : '男', b.age)
        .then((avatar) => {
          if (avatar) useStudioStore.getState().updateCharacter(id, { avatar });
        })
        .catch(() => undefined);
    } else st.updateEnvironment(id, { name: b.name, desc: b.desc ?? '', etype: b.etype ?? 'building' });
    const container = findContainerAt(useStudioStore.getState().nodes, pos.x, pos.y, id);
    if (container) st.reparentNode(id, container.id);
    setDropped((prev) => new Set(prev).add(i));
    setDoneMsg(b.kind === 'character' ? `✓ 人物「${b.name}」已落为画布节点` : `✓ 环境「${b.name}」已落为画布节点`);
  };

  // 区域规划整组落地：容器（按规划范围尺寸）+ N 座建筑（按规划大小/位置摆好，reparentNode 自动换算相对坐标）。
  // 建筑不参与落点判定，全部显式挂进容器；容器落点在既有环境内则整组嵌进去（与单节点落点语义一致）。
  const dropPlan = (b: SimPlanBlock, i: number) => {
    setDoneMsg('');
    const st = useStudioStore.getState();
    const pos = centerPos();
    const pid = st.createEnvironment(pos, { w: b.w, h: b.h });
    st.updateEnvironment(pid, { name: b.name, desc: b.desc ?? '', etype: b.etype });
    const container = findContainerAt(useStudioStore.getState().nodes, pos.x, pos.y, pid);
    if (container) st.reparentNode(pid, container.id);
    for (const it of b.items) {
      const cid = st.createEnvironment({ x: pos.x + it.x, y: pos.y + it.y }, { w: it.w, h: it.h });
      st.updateEnvironment(cid, { name: it.name, desc: it.desc, etype: it.etype });
      st.reparentNode(cid, pid);
    }
    // 收尾重选容器（创建过程每个新节点都自动选中过，归位于容器便于直接改名/拖动整组）
    const after = useStudioStore.getState();
    after.onNodesChange(after.nodes.map((n2) => ({ id: n2.id, type: 'select' as const, selected: n2.id === pid })));
    setDropped((prev) => new Set(prev).add(i));
    setDoneMsg(`✓ 规划「${b.name}」已落地（${b.items.length} 座建筑已嵌套）`);
  };

  // 卷块：新建一卷（只新建，不覆盖已有卷）；标题重名不去重，由用户自行调整
  const dropVolume = (b: SimVolumeBlock, i: number) => {
    setDoneMsg('');
    const id = useStudioStore.getState().addVolume();
    useStudioStore.getState().updateVolume(id, { title: b.name, intro: b.intro });
    setDropped((prev) => new Set(prev).add(i));
    setDoneMsg(`✓ 卷「${b.name}」已新建`);
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
        const pending = msg.blocks
          .map((b, i) => ({ b, i }))
          .filter((x): x is { b: EditorRoomBlock; i: number } => x.b.kind === 'character' && !dropped.has(x.i));
        return pending.length >= 2 ? (
          <button
            onClick={() => {
              pending.forEach(({ b, i }) => drop(b, i));
              setDoneMsg(`✓ ${pending.length} 个人物已全部落为画布节点`);
            }}
            title="把本条回复的全部人物设定块逐个落为画布人物节点（属性按块填好，性别随块）"
            className="flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-brand-700"
          >
            <UserPlus className="h-3.5 w-3.5" />
            全部落为人物（{pending.length}）
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
  const mode = useEditorialStore((s) => s.mode);
  const meetingRunning = useEditorialStore((s) => s.status === 'running');
  const routeChat = useEditorialStore((s) => s.routeChat);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 🧑‍💼 对话对象（v2.19b）：总编辑（默认）或编辑部某位编辑；名单合并必须 useMemo（选择器禁返回新数组）
  const chatEditor = useEditorRoomStore((s) => s.chatEditor);
  const localEditors = useEditorialStore((s) => s.localEditors);
  const serverEditors = useEditorialStore((s) => s.serverEditors);
  const editors = useMemo(() => [...localEditors, ...serverEditors].filter((e) => e.enabled), [localEditors, serverEditors]);
  // 编辑被删除/停用后自动回总编辑
  useEffect(() => {
    if (chatEditor && !editors.some((e) => e.id === chatEditor.id)) useEditorRoomStore.getState().setChatEditor(null);
  }, [chatEditor, editors]);

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
    <div className="fixed bottom-2 left-2 right-2 top-[calc(var(--topbar-h)+10px)] z-40 flex flex-col overflow-hidden rounded-[16px] border border-slate-200/80 bg-white shadow-panel sm:left-auto sm:right-4 sm:w-[560px]">
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
              value={chatEditor?.id ?? 'chief'}
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
              placeholder={meetingRunning && routeChat ? '插话：会进入正在进行的会议讨论（Enter 发送）' : '描述想要的舞台：地点、人物、氛围…（Enter 发送）'}
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
              <Button variant="primary" icon={<Send />} onClick={send} disabled={!input.trim()}>
                发送
              </Button>
            )}
          </div>
        </div>
        </>)}
      </div>
      {showDept && <EditorialDeptDialog onClose={() => setShowDept(false)} />}
    </div>
  );
}
