/** 🗂 跨卷复制对话框（v2.29，仅复制）：当前画布选中节点 → 另一张画布（默认主画布/其它卷）。
 *  - 保留 ID 镜像：同一人物/环境在另一卷的镜像；目标已有同 ID 时默认跳过，可改为更新数据（保留目标位置/父子）。
 *  - 复制为新：全部换新 ID，父子/内部连线/人物写真一起重映射，副本独立。
 *  只写目标画布，默认不切换标签；复制落点=目标画布已保存视口的中心（无视口则原点）。 */
import { useEffect, useMemo, useState } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import type { SimBoard } from '../../types/sim';
import {
  useActiveBoard,
  useStudioStore,
  boardLabel,
  volumeBoardId,
} from '../../stores/studioStore';
import { collectCopySet, type BoardCopyConflict, type BoardCopyMode, type BoardCopyResult } from '../../stores/boardCopy';
import { localImgCopy } from '../../services/localImages';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Field, Select } from '../ui/Field';

function nodeLabel(b: SimBoard, id: string): string {
  const n = b.nodes.find((x) => x.id === id);
  if (!n) return id;
  return n.data.kind === 'character'
    ? `人物「${n.data.name || '未命名'}」`
    : `环境「${n.data.name || '未命名'}」`;
}

export function CopyToVolumeDialog({ onClose }: { onClose: () => void }) {
  const boards = useStudioStore((s) => s.boards);
  const volumes = useStudioStore((s) => s.volumes);
  const activeBoardId = useStudioStore((s) => s.activeBoardId);
  const source = useActiveBoard();
  const copyNodesToBoard = useStudioStore((s) => s.copyNodesToBoard);

  const targets = useMemo(() => {
    const ordered: SimBoard[] = [];
    const seen = new Set<string>();
    const push = (b: SimBoard | undefined) => {
      if (!b || b.id === activeBoardId || seen.has(b.id)) return;
      seen.add(b.id);
      ordered.push(b);
    };
    push(boards.main);
    for (const v of volumes) push(boards[volumeBoardId(v.id)]);
    for (const b of Object.values(boards)) push(b);
    return ordered.map((b) => ({ board: b, label: boardLabel(b, volumes), count: b.nodes.length }));
  }, [activeBoardId, boards, volumes]);

  const [targetId, setTargetId] = useState(() => targets[0]?.board.id ?? '');
  const [mode, setMode] = useState<BoardCopyMode>('mirror');
  const [conflict, setConflict] = useState<BoardCopyConflict>('skip');
  const [includeDescendants, setIncludeDescendants] = useState(true);
  const [switchAfter, setSwitchAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BoardCopyResult | null>(null);
  const [portraitWarning, setPortraitWarning] = useState('');
  const [error, setError] = useState('');

  // 目标画布被删除/切换后兜底到第一张可用目标
  useEffect(() => {
    if (!targets.some((t) => t.board.id === targetId)) setTargetId(targets[0]?.board.id ?? '');
  }, [targetId, targets]);

  const selectedIds = useMemo(() => (source?.nodes.filter((n) => n.selected).map((n) => n.id) ?? []), [source]);
  const copySet = useMemo(
    () => (source ? collectCopySet(source, selectedIds, includeDescendants) : { nodes: [], edges: [] }),
    [source, selectedIds, includeDescendants],
  );
  const target = boards[targetId];
  const conflicts = useMemo(() => {
    if (!target || mode !== 'mirror') return [];
    return copySet.nodes.filter((n) => target.nodes.some((x) => x.id === n.id)).map((n) => nodeLabel(source!, n.id));
  }, [copySet.nodes, mode, source, target]);

  const run = async () => {
    if (!source || !target || busy) return;
    if (!selectedIds.length) {
      setError('当前画布没有选中的节点。');
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    setPortraitWarning('');
    try {
      // 目标画布视口中心（flow 坐标）；没有保存视口时以原点为中心。
      // 用画布容器自身中心（顶栏/属性面板会让窗口中心偏移），容器未挂载时才退回窗口中心。
      const vp = target.viewport;
      const rect = document.querySelector('.react-flow')?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      const placement = vp
        ? {
            x: (cx - (rect?.left ?? 0) - vp.x) / vp.zoom,
            y: (cy - (rect?.top ?? 0) - vp.y) / vp.zoom,
          }
        : { x: 0, y: 0 };
      const r = copyNodesToBoard({
        targetBoardId: target.id,
        nodeIds: selectedIds,
        mode,
        ...(mode === 'mirror' ? { conflict } : {}),
        includeDescendants,
        placement,
        switchAfter,
        selectResult: switchAfter,
      });
      setResult(r);
      if (r.portraitTasks.length) {
        const settled = await Promise.allSettled(
          r.portraitTasks.map((t) => localImgCopy(t.fromKey, t.toKey)),
        );
        // 源人物本来就没有写真（'missing'）是正常情况，不提示；只有读写异常才算失败
        const failed = settled.filter((x) => x.status === 'rejected').length;
        if (failed) setPortraitWarning(`${failed}/${r.portraitTasks.length} 张状态写真未能复制（节点已复制，可稍后重新生成写真）。`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sourceLabel = source ? boardLabel(source, volumes) : '当前画布';

  return (
    <Dialog
      onClose={onClose}
      width="lg"
      icon={<Copy />}
      title="复制到卷画布"
      subtitle={
        <>
          把<b>{sourceLabel}</b>上选中的 {selectedIds.length} 个节点复制到另一张画布。
          「保留 ID 镜像」让同一人物/环境在多个卷保持同一身份，目标已有同 ID 时默认跳过冲突节点；
          「复制为新」生成完全独立的副本。本操作只复制，不会移动或删除源节点。
        </>
      }
      footer={
        <>
          <Button variant="soft" onClick={onClose}>
            {result ? '完成' : '取消'}
          </Button>
          <Button
            variant="primary"
            icon={busy ? <Loader2 className="animate-spin" /> : <Copy />}
            onClick={() => void run()}
            disabled={busy || !source || !target || selectedIds.length === 0}
          >
            {busy ? '复制中…' : mode === 'mirror' ? '镜像复制' : '复制为新'}
          </Button>
        </>
      }
    >
      <Field label="目标画布">
        <Select
          value={targetId}
          onChange={(e) => {
            setTargetId(e.target.value);
            setResult(null);
            setError('');
          }}
          disabled={targets.length === 0}
        >
          {targets.map((t) => (
            <option key={t.board.id} value={t.board.id}>
              {t.label}（{t.count} 节点）
            </option>
          ))}
          {targets.length === 0 && <option value="">没有其它画布——请先在顶栏「＋卷」新建</option>}
        </Select>
      </Field>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Field label="复制模式">
          <Select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as BoardCopyMode);
              setResult(null);
            }}
          >
            <option value="mirror">保留 ID 镜像（推荐）</option>
            <option value="new">复制为新（独立副本）</option>
          </Select>
        </Field>
        <Field label="镜像冲突">
          <Select
            value={conflict}
            onChange={(e) => {
              setConflict(e.target.value as BoardCopyConflict);
              setResult(null);
            }}
            disabled={mode !== 'mirror'}
            title="目标画布已有同 ID 节点时的处理：跳过=补缺失节点（默认安全）；更新=用源数据覆盖目标数据与环境尺寸，位置保留"
          >
            <option value="skip">跳过冲突（推荐）</option>
            <option value="update">更新目标节点</option>
          </Select>
        </Field>
      </div>

      <div className="mt-3 space-y-1.5">
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-600">
          <input
            type="checkbox"
            checked={includeDescendants}
            onChange={(e) => {
              setIncludeDescendants(e.target.checked);
              setResult(null);
            }}
          />
          包含选中环境的全部子节点（环境/人物）
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-600">
          <input
            type="checkbox"
            checked={switchAfter}
            onChange={(e) => setSwitchAfter(e.target.checked)}
          />
          复制后切换到目标画布
        </label>
      </div>

      <div className="mt-3 rounded-[10px] border border-slate-200 bg-slate-50/70 px-3 py-2 text-[12px] leading-relaxed text-slate-500">
        将复制 <b className="text-slate-700">{selectedIds.length}</b> 个选中节点
        {includeDescendants && copySet.nodes.length > selectedIds.length
          ? `，展开子节点后共 ${copySet.nodes.length} 个`
          : ''}
        {copySet.edges.length ? `、${copySet.edges.length} 条内部连线` : ''}。
        {!result && conflicts.length > 0 && (
          <span className="mt-1 block text-amber-600">
            目标已有 {conflicts.length} 个同 ID 节点：{conflicts.slice(0, 6).join('、')}
            {conflicts.length > 6 ? '…' : ''}
            {mode === 'mirror' && conflict === 'skip' ? '（将跳过这些节点，继续复制缺失后代）' : ''}
          </span>
        )}
        {mode === 'new' && <span className="mt-1 block">新 ID 会自动重映射父子关系、内部连线与每个人物状态的写真。</span>}
      </div>

      {error && <p className="mt-2 rounded-[8px] bg-rose-50 px-3 py-2 text-[12px] text-rose-600">{error}</p>}
      {result && (
        <div className="mt-2 rounded-[8px] bg-emerald-50 px-3 py-2 text-[12px] leading-relaxed text-emerald-700">
          已复制到「{target ? boardLabel(target, volumes) : '目标画布'}」：新增 {result.report.added}、更新{' '}
          {result.report.updated}、跳过 {result.report.skipped}、新增连线 {result.report.edgesAdded}
          {result.report.parentFallbacks ? `、${result.report.parentFallbacks} 个节点父级回退为根层` : ''}。
          {result.report.warnings.length > 0 && (
            <span className="mt-1 block text-amber-700">{result.report.warnings.join('；')}</span>
          )}
          {portraitWarning && <span className="mt-1 block text-amber-700">{portraitWarning}</span>}
        </div>
      )}
    </Dialog>
  );
}
