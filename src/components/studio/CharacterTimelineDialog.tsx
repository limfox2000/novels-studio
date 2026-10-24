/** 🕒 人物时间轴（P3）：只读展示一个人物在全部章节快照中的出现记录。
 *
 *  - 按全局章节顺序（跨卷同样适用）；
 *  - 与上一次出现对比角色/状态/画布/卷变化；
 *  - 解析失败只显示采集时的冻结标签并标注原因，不读取、不编造当前属性；
 *  - 不提供任何修改入口。 */
import { useMemo } from 'react';
import { CalendarClock, History } from 'lucide-react';
import { useStudioStore } from '../../stores/studioStore';
import { stateFingerprint } from '../../stores/chapterSnapshots';
import {
  characterTimeline,
  findCharacterById,
  TIMELINE_CHANGE_LABEL,
  TIMELINE_RESOLUTION_LABEL,
  type CharacterTimelineRow,
} from '../../stores/characterSearch';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import type { CastRole } from '../../types/sim';

function timeText(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function roleText(role: CastRole): string {
  return role === 'present' ? '在场' : '仅提及';
}

function Row({ row, first }: { row: CharacterTimelineRow; first: boolean }) {
  const missing = row.resolution !== 'ok';
  return (
    <div
      data-timeline-row={row.chapterId}
      data-timeline-role={row.role}
      data-timeline-resolution={row.resolution}
      className="rounded-[10px] border px-2.5 py-2"
      style={{ borderColor: 'var(--rd-border)' }}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--rd-text)' }}>
        <span className="tabular-nums opacity-60">{row.chapterIndex + 1}.</span>
        <span className="truncate">{row.chapterTitle}</span>
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-normal ${
            row.role === 'present' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
          }`}
        >
          {roleText(row.role)}
        </span>
        <span className="rounded border px-1 text-[10px] font-normal opacity-75" style={{ borderColor: 'var(--rd-border)' }}>
          {row.displayStateLabel}
        </span>
        {missing && (
          <span
            className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-normal text-amber-700"
            title="快照引用的资料在当前画布解析失败；只显示采集时冻结的标签"
          >
            {TIMELINE_RESOLUTION_LABEL[row.resolution]}
          </span>
        )}
        {row.contentModified && (
          <span
            className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-normal text-amber-700"
            title="该章快照记录后，当前状态属性被原地修改；时间轴仍以快照记录为准，不自动刷新"
          >
            状态内容已修改
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px]" style={{ color: 'var(--rd-sub)' }}>
        <span>
          {row.chapterVolumeTitle} · {row.sourceBoardLabel}
        </span>
        <span>·</span>
        <span>{timeText(row.recordedAt)}</span>
      </div>
      {first && row.changes.length === 0 ? (
        <div className="mt-1 text-[10.5px] opacity-65" style={{ color: 'var(--rd-sub)' }}>
          时间轴中首次出现
        </div>
      ) : row.changes.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {row.changes.map((c) => (
            <span
              key={c}
              data-timeline-change={c}
              className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
            >
              {TIMELINE_CHANGE_LABEL[c]}
            </span>
          ))}
        </div>
      ) : null}
      {missing && row.nameAtCapture !== row.displayName && (
        <div className="mt-1 text-[10.5px]" style={{ color: 'var(--rd-sub)' }}>
          采集时：{row.nameAtCapture}
        </div>
      )}
    </div>
  );
}

export function CharacterTimelineDialog({ characterId, onClose }: { characterId: string; onClose: () => void }) {
  const chapters = useStudioStore((s) => s.chapters);
  const boards = useStudioStore((s) => s.boards);
  const volumes = useStudioStore((s) => s.volumes);
  const rows = useMemo(
    () => characterTimeline(chapters, boards, volumes, characterId, stateFingerprint),
    [chapters, boards, volumes, characterId],
  );
  const live = findCharacterById(boards, characterId);
  const displayName = live ? (live.data.name || '未命名').trim() : rows[0]?.displayName || '未命名';
  const missingCount = rows.filter((r) => r.resolution !== 'ok').length;

  return (
    <Dialog
      title={`人物时间轴 · ${displayName}`}
      subtitle={
        rows.length
          ? `共 ${rows.length} 章出现记录${missingCount ? `，${missingCount} 条资料缺失` : ''}。按全局章节顺序，只读。`
          : '按全局章节顺序扫描章节快照；只读，不修改任何数据。'
      }
      icon={<History />}
      width="md"
      onClose={onClose}
      footer={
        <Button size="sm" variant="secondary" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div data-character-timeline={characterId} className="space-y-1.5">
        {rows.length === 0 ? (
          <div className="flex items-start gap-2 rounded-[10px] border px-3 py-3 text-[12px] leading-relaxed" style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}>
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 opacity-60" />
            <span>该人物没有出现在任何章节快照中。先在章节名单里记录本章名单，时间轴才会出现记录。</span>
          </div>
        ) : (
          rows.map((row, i) => <Row key={row.chapterId} row={row} first={i === 0} />)
        )}
        {live == null && rows.length > 0 && (
          <div className="rounded-[10px] border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
            当前画布上已找不到该人物（或其 ID 不唯一）。时间轴仅显示快照冻结标签，不会猜测补全。
          </div>
        )}
      </div>
    </Dialog>
  );
}
