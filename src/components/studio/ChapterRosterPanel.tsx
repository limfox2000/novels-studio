/** 🎭 本章名单 / 📸 章节场景面板（v2.32）：
 *  - 名单由章节区域内的人物自动派生，不再提供手动采集/增删/改角色；
 *  - 切出本章时把区域内人物位置、父环境、当前状态记入快照；切回时自动还原；
 *  - 面板只读展示「在场 / 仅提及」、当前解析名/状态/环境路径与资料缺失；
 *  - 正文管理器同样只读。
 *
 *  只读快照引用，不复制人物属性；修改画布状态会反映到历史章，面板用指纹差异提示“状态已修改”。 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  History,
  Search,
  Users,
} from 'lucide-react';
import { useStudioStore } from '../../stores/studioStore';
import { boardLabel } from '../../stores/boardOps';
import { chapterBoardOf } from '../../stores/chapterRegions';
import {
  envPathForCharacter,
  snapshotIssueLabel,
  snapshotStaleness,
  stateFingerprint,
} from '../../stores/chapterSnapshots';
import { resolveSnapshotEntry } from '../../stores/snapshotRefs';
import type { ChapterSnapshotEntry, SimChapter } from '../../types/sim';
import { beginChapterRegion } from './chapterRegionActions';
import { ChapterDiffPanel } from './ChapterDiffPanel';
import { CharacterSearchDialog } from './CharacterSearchDialog';
import { CharacterTimelineDialog } from './CharacterTimelineDialog';

const SOURCE_TEXT: Record<string, string> = {
  manual: '旧手动记录',
  'auto-outline': '旧生成时自动记录',
  'auto-content': '旧生成时自动记录',
  'auto-scene': '自动跟随画布',
};

function timeText(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

interface Props {
  chapter: SimChapter;
  /** 正文管理器：只读摘要，不提供编辑按钮 */
  readonly?: boolean;
  /** 画区域成功后可收起当前浮层，把画布让出来 */
  onRequestClose?: () => void;
}

export function ChapterRosterPanel({ chapter, readonly = false, onRequestClose }: Props) {
  const chapters = useStudioStore((s) => s.chapters);
  const volumes = useStudioStore((s) => s.volumes);
  const boards = useStudioStore((s) => s.boards);
  const [open, setOpen] = useState(!readonly);
  const [timelineId, setTimelineId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const snap = chapter.snapshot;
  const currentBoardId = chapterBoardOf(chapter.volumeId, volumes, boards);
  const currentBoard = boards[currentBoardId];
  const currentRegion = currentBoard?.regions.find((r) => r.chapterId === chapter.id);
  const sourceBoard = snap ? boards[snap.boardId] : currentBoard;
  const sourceRegion = snap && sourceBoard
    ? sourceBoard.regions.find((r) => r.chapterId === chapter.id)
    : currentRegion;
  const sourceLabel = sourceBoard ? boardLabel(sourceBoard, volumes) : snap ? `已删除的画布（${snap.boardId}）` : '';
  const stale = useMemo(
    () => (snap ? snapshotStaleness(snap, sourceBoard, sourceRegion) : null),
    [snap, sourceBoard, sourceRegion],
  );
  const boardNodes = useMemo(
    () => new Map((sourceBoard?.nodes ?? []).map((n) => [n.id, n])),
    [sourceBoard],
  );
  const resolved = useMemo(() => {
    if (!snap) return new Map<string, ReturnType<typeof resolveSnapshotEntry>>();
    return new Map(
      snap.entries.map((e) => [
        e.characterId,
        resolveSnapshotEntry(e, snap.boardId, boards, stateFingerprint),
      ]),
    );
  }, [snap, boards]);

  const grouped = useMemo(() => {
    const present: ChapterSnapshotEntry[] = [];
    const mentioned: ChapterSnapshotEntry[] = [];
    for (const e of snap?.entries ?? []) (e.role === 'present' ? present : mentioned).push(e);
    return { present, mentioned };
  }, [snap]);

  const drawRegion = () => {
    if (readonly) return;
    const r = beginChapterRegion(chapter.id);
    if (!r.ok) {
      window.alert(r.message);
      return;
    }
    onRequestClose?.();
  };

  const count = snap?.entries.length ?? 0;
  const issues = stale?.codes ?? [];
  const sourceChanged = !!snap && snap.boardId !== currentBoardId;

  return (
    <div
      data-chapter-roster={chapter.id}
      className="mt-2.5 overflow-hidden rounded-[10px] border"
      style={{ borderColor: 'var(--rd-border)', background: 'var(--rd-card)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] font-semibold"
        style={{ color: 'var(--rd-sub)' }}
        title="本章名单：生成大纲/正文时按此名单限制出场人物"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Users className="h-3.5 w-3.5 opacity-70" />
        本章名单
        {snap ? (
          <span className="font-normal opacity-80">
            {grouped.present.length} 在场 · {grouped.mentioned.length} 提及
          </span>
        ) : (
          <span className="font-normal opacity-70">未记录</span>
        )}
        <span className="flex-1" />
        {issues.length > 0 && (
          <span
            className="flex items-center gap-0.5 whitespace-nowrap rounded-full border border-amber-300/70 bg-amber-50/70 px-1.5 py-0.5 text-[10.5px] font-normal text-amber-700"
            title={issues.map((c) => snapshotIssueLabel(c)).join('；')}
          >
            <AlertTriangle className="h-3 w-3" />
            有变化
          </span>
        )}
      </button>

      {open && (
        <div className="border-t px-3 py-2.5" style={{ borderColor: 'var(--rd-border)' }}>
          {!snap ? (
            <div className="space-y-2 text-[12px] leading-relaxed" style={{ color: 'var(--rd-sub)' }}>
              {currentRegion ? (
                <div>区域已绑定。区域内人物会自动成为本章名单；移动人物、切换状态或调整区域后，本章场景会在画布上自动记录，无需手动采集。</div>
              ) : (
                <>
                  <div>本章还没有区域。先在画布上圈出本章舞台；进入区域的人物会自动成为本章名单。</div>
                  {!readonly && (
                    <button
                      type="button"
                      onClick={drawRegion}
                      className="rounded-[8px] border px-2.5 py-1.5 text-[12px] font-medium"
                      style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}
                    >
                      在画布上画区域
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: 'var(--rd-sub)' }}>
                <span>来源：{sourceLabel}</span>
                <span>·</span>
                <span>{SOURCE_TEXT[snap.source] ?? '手动记录'}</span>
                <span>·</span>
                <span>{timeText(snap.updatedAt)}</span>
                {sourceChanged && <span className="font-medium text-amber-600">（非当前画布）</span>}
              </div>

              {issues.length > 0 && (
                <div className="rounded-[8px] border border-amber-300/60 bg-amber-50/60 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
                  {issues.map((c) => snapshotIssueLabel(c)).join('；')}
                  {stale && stale.missingCount > 0 ? `（${stale.missingCount} 条资料缺失）` : ''}
                  。切回本章时会按记录的位置、所属环境和状态还原。
                </div>
              )}

              {count === 0 && (
                <div className="text-[12px] leading-relaxed" style={{ color: 'var(--rd-sub)' }}>
                  区域里还没有人物。把人物移入本章区域后，名单与位置会自动记录。
                </div>
              )}

              {(['present', 'mentioned'] as const).map((role) => {
                const list = role === 'present' ? grouped.present : grouped.mentioned;
                if (!list.length) return null;
                return (
                  <div key={role}>
                    <div className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--rd-sub)' }}>
                      {role === 'present' ? '在场（可行动/说话）' : '仅提及（不得现场行动）'}
                    </div>
                    <div className="space-y-1">
                      {list.map((e) => {
                        const r = resolved.get(e.characterId);
                        const node = r?.ok ? r.node : r && !r.ok ? r.node : undefined;
                        const name = r?.ok ? r.name : e.nameAtCapture;
                        const state = r?.ok ? r.state : undefined;
                        const stateLabel = state?.label ?? e.stateLabelAtCapture;
                        const path =
                          r?.ok && sourceBoard
                            ? envPathForCharacter(r.node, boardNodes)
                            : e.envPathAtCapture;
                        const missing = r && !r.ok ? r.error : null;
                        const changed = r?.ok ? r.stateChanged : false;
                        return (
                          <div
                            key={e.characterId}
                            data-snapshot-character={e.characterId}
                            className="flex items-start gap-1.5 rounded-[8px] border px-2 py-1.5"
                            style={{ borderColor: 'var(--rd-border)' }}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1 text-[12px] font-medium">
                                <span className="truncate" title={e.nameAtCapture !== name ? `采集时：${e.nameAtCapture}` : undefined}>
                                  {name}
                                </span>
                                {e.origin === 'manual' && (
                                  <span className="rounded-full border px-1 text-[9.5px] font-normal opacity-70" style={{ borderColor: 'var(--rd-border)' }} title="旧版手动添加的名单条目；新版名单随区域自动更新">
                                    旧名单
                                  </span>
                                )}
                                {missing && (
                                  <span className="rounded-full bg-rose-100 px-1 text-[9.5px] font-normal text-rose-700" title="快照引用的资料已从画布移除，生成时不会猜测补全">
                                    {missing === 'missing-state'
                                      ? '状态缺失'
                                      : missing === 'missing-character'
                                        ? '人物缺失'
                                        : missing === 'ambiguous-character'
                                          ? '跨卷同名歧义'
                                          : '来源画布缺失'}
                                  </span>
                                )}
                                {changed && (
                                  <span className="rounded-full bg-amber-100 px-1 text-[9.5px] font-normal text-amber-700" title="快照记录后该状态属性被修改；生成时解析当前内容">
                                    状态已修改
                                  </span>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-x-1.5 text-[10.5px]" style={{ color: 'var(--rd-sub)' }}>
                                <span className="rounded border px-1" style={{ borderColor: 'var(--rd-border)' }} title={node ? '本章场景记录的当前状态；切回本章时恢复' : undefined}>
                                  {stateLabel}
                                </span>
                                <span className="min-w-0 truncate" title={path || '未归属环境'}>
                                  {path || '未归属环境'}
                                </span>
                              </div>
                            </div>
                            <button
                              type="button"
                              data-timeline-open={e.characterId}
                              onClick={() => setTimelineId(e.characterId)}
                              className="shrink-0 rounded p-0.5 opacity-50 transition hover:bg-slate-500/10 hover:opacity-100"
                              style={{ color: 'var(--rd-sub)' }}
                              title="查看该人物在全部章节快照中的出场记录（只读）"
                              aria-label={`查看 ${name} 的人物时间轴`}
                            >
                              <History className="h-3.5 w-3.5" />
                            </button>
                            <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--rd-sub)' }}>
                              {e.role === 'present' ? '在场' : '仅提及'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              <div className="border-t pt-2 text-[10.5px] leading-relaxed" style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}>
                名单随章节区域自动更新；切换章节会还原本章人物的位置、所属环境和当前状态。全 {chapters.length} 章共享同一套快照记录。
              </div>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2" style={{ borderColor: 'var(--rd-border)' }}>
            <button
              type="button"
              data-cross-board-search-roster
              onClick={() => setSearchOpen(true)}
              className="flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[11.5px]"
              style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}
              title="按人名搜索全部画布人物，可定位或查看人物时间轴"
            >
              <Search className="h-3 w-3" />
              跨卷查人
            </button>
            <span className="text-[10.5px]" style={{ color: 'var(--rd-sub)' }}>
              同名人物按卷/画布分开显示
            </span>
          </div>
        </div>
      )}
      <ChapterDiffPanel chapter={chapter} />
      {timelineId && <CharacterTimelineDialog characterId={timelineId} onClose={() => setTimelineId(null)} />}
      {searchOpen && <CharacterSearchDialog onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
