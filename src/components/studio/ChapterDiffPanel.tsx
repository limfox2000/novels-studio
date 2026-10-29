/** 🔍 与上一章相比（R7）：只读展示相邻章快照的名单变化。
 *  按全局章节顺序找上一章（跨卷同样适用）；任一章无快照时显示空态。
 *  不读当前人物属性，不提供修改入口。 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, GitCompareArrows } from 'lucide-react';
import { useStudioStore } from '../../stores/studioStore';
import { boardLabel } from '../../stores/boardOps';
import { stateFingerprint } from '../../stores/chapterSnapshots';
import { resolveSnapshotEntry } from '../../stores/snapshotRefs';
import { DIFF_CHANGE_LABEL, diffChapterSnapshots, type ChapterDiffRow, type ChapterDiffSide } from '../../stores/chapterDiff';
import type { CastRole, SimChapter } from '../../types/sim';

function roleText(role: CastRole): string {
  return role === 'present' ? '在场' : '仅提及';
}

function Side({ side, missing }: { side: ChapterDiffSide; missing: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span>{roleText(side.role)}</span>
      <span>·</span>
      <span>{side.stateLabel || '未记录状态'}</span>
      {side.envPath && (
        <>
          <span>·</span>
          <span className="max-w-[18em] truncate" title={side.envPath}>{side.envPath}</span>
        </>
      )}
      {missing && (
        <span className="inline-flex items-center gap-0.5 text-amber-600" title="快照引用在当前画布上解析不到；仅显示采集时的冻结标签">
          <AlertTriangle className="h-3 w-3" />
          资料缺失
        </span>
      )}
    </span>
  );
}

function Row({ row, prevMissing, currMissing }: { row: ChapterDiffRow; prevMissing: boolean; currMissing: boolean }) {
  const from = row.from;
  const to = row.to;
  const parts: string[] = [];
  if (row.changes.includes('role') && from && to) parts.push(`${roleText(from.role)} → ${roleText(to.role)}`);
  if (row.changes.includes('state') && from && to) parts.push(`状态「${from.stateLabel}」 → 「${to.stateLabel}」`);
  if (row.changes.includes('state-content') && to) parts.push(`状态「${to.stateLabel}」内容已修改`);
  if (row.changes.includes('name') && from && to) parts.push(`改名「${from.name}」 → 「${to.name}」`);
  if (row.changes.includes('env') && from && to) parts.push(`环境「${from.envPath || '未归属'}」 → 「${to.envPath || '未归属'}」`);
  return (
    <div data-diff-character={row.characterId} className="rounded-[8px] border px-2 py-1.5" style={{ borderColor: 'var(--rd-border)' }}>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--rd-sub)' }}>
        <span className="truncate">{row.name}</span>
        {row.changes.map((c) => (
          <span
            key={c}
            data-diff-change={c}
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-normal ${
              c === 'added'
                ? 'bg-emerald-50 text-emerald-700'
                : c === 'removed'
                  ? 'bg-rose-50 text-rose-600'
                  : 'bg-amber-50 text-amber-700'
            }`}
          >
            {DIFF_CHANGE_LABEL[c]}
          </span>
        ))}
      </div>
      {parts.length > 0 ? (
        <div className="mt-0.5 text-[11px] leading-relaxed" style={{ color: 'var(--rd-sub)' }}>{parts.join('；')}</div>
      ) : (
        <>
          <div className="mt-0.5 text-[11px] leading-relaxed" style={{ color: 'var(--rd-sub)' }}>
            {from && <Side side={from} missing={prevMissing} />}
            {from && to && <span className="mx-1">→</span>}
            {to && <Side side={to} missing={currMissing} />}
          </div>
        </>
      )}
    </div>
  );
}

export function ChapterDiffPanel({ chapter }: { chapter: SimChapter }) {
  const chapters = useStudioStore((s) => s.chapters);
  const boards = useStudioStore((s) => s.boards);
  const volumes = useStudioStore((s) => s.volumes);
  const characters = useStudioStore((s) => s.characters);
  const [open, setOpen] = useState(false);

  // 切章时收起，避免沿用上一章的展开状态遮蔽新章节空态
  useEffect(() => {
    setOpen(false);
  }, [chapter.id]);

  const idx = chapters.findIndex((c) => c.id === chapter.id);
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const curr = chapter.snapshot;
  const prevSnap = prev?.snapshot;
  const rows = useMemo(
    () => (prevSnap && curr ? diffChapterSnapshots(prevSnap, curr) : []),
    [prevSnap, curr],
  );
  const changedRows = rows.length;

  // 每侧条目是否可解析（人物库直查；只影响标签展示，仍显示冻结名称）
  const missingIds = (snap: NonNullable<typeof curr>) => {
    const set = new Set<string>();
    for (const e of snap.entries) {
      const r = resolveSnapshotEntry(e, snap.boardId, boards, characters, stateFingerprint);
      if (!r.ok) set.add(e.characterId);
    }
    return set;
  };
  const prevMissing = useMemo(() => (prevSnap ? missingIds(prevSnap) : new Set<string>()), [prevSnap, boards, characters]);
  const currMissing = useMemo(() => (curr ? missingIds(curr) : new Set<string>()), [curr, boards, characters]);

  const prevLabel = prevSnap ? (boards[prevSnap.boardId] ? boardLabel(boards[prevSnap.boardId], volumes) : `已删除的画布（${prevSnap.boardId}）`) : '';
  const currLabel = curr ? (boards[curr.boardId] ? boardLabel(boards[curr.boardId], volumes) : `已删除的画布（${curr.boardId}）`) : '';

  return (
    <div
      data-chapter-diff={chapter.id}
      className="mt-2 overflow-hidden rounded-[10px] border"
      style={{ borderColor: 'var(--rd-border)', background: 'var(--rd-card)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] font-semibold"
        style={{ color: 'var(--rd-sub)' }}
        title="对比当前章与全局顺序上一章的名单快照（只读）"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <GitCompareArrows className="h-3.5 w-3.5 opacity-70" />
        与上一章相比
        {open && prev && (
          <span className="font-normal opacity-75">
            {prev.title.trim() || '未命名章节'} → {chapter.title.trim() || '未命名章节'}
          </span>
        )}
        {open && prev && prevSnap && curr && (
          <span className="font-normal opacity-75">· {changedRows} 处变化</span>
        )}
        <span className="flex-1" />
      </button>

      {open && (
        <div className="border-t px-3 py-2.5 text-[12px] leading-relaxed" style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}>
          {!prev ? (
            <div>这是第一章，没有上一章可比较。</div>
          ) : !prevSnap || !curr ? (
            <div>上一章或本章还没有记录名单快照，暂无可比较内容。</div>
          ) : (
            <>
              <div className="mb-1.5 text-[10.5px] opacity-80">
                来源：{prevLabel} → {currLabel}（只比较快照冻结标签，不读取当前画布属性）
              </div>
              {rows.length ? (
                <div className="space-y-1.5">
                  {rows.map((r) => (
                    <Row key={r.characterId} row={r} prevMissing={prevMissing.has(r.characterId)} currMissing={currMissing.has(r.characterId)} />
                  ))}
                </div>
              ) : (
                <div>名单人员、角色与状态均无变化。</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
