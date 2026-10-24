/** 🎭 本章名单 / 📸 章节快照面板（R2/R3）：
 *  - 无区域：引导绘制；有区域无快照：一键采集；
 *  - 有快照：按「在场 / 仅提及」分组，显示解析后的当前名/状态/环境路径与缺失、未同步状态；
 *  - 大纲管理器可编辑（切换角色/状态、移除、手动添加、刷新/清除）；
 *  - 正文管理器只读摘要，编辑入口在大纲面板。
 *
 *  只读快照引用，不复制人物属性；修改画布状态会反映到历史章，面板用指纹差异提示“未同步”。 */
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  ChevronDown,
  ChevronRight,
  History,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X,
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
import type {
  CastRole,
  ChapterSnapshotEntry,
  CharacterData,
  SimChapter,
  SimNodeType,
} from '../../types/sim';
import { beginChapterRegion } from './chapterRegionActions';
import { ChapterDiffPanel } from './ChapterDiffPanel';
import { CharacterSearchDialog } from './CharacterSearchDialog';
import { CharacterTimelineDialog } from './CharacterTimelineDialog';

const ERROR_TEXT: Record<string, string> = {
  'chapter-not-found': '章节不存在',
  'board-not-found': '快照来源画布不存在',
  'region-not-found': '本章还没有区域，请先在画布上绘制',
  'snapshot-not-found': '本章还没有快照',
  'character-not-found': '人物不存在',
  'state-not-found': '状态不存在',
  'entry-not-found': '名单条目不存在',
};

const SOURCE_TEXT: Record<string, string> = {
  manual: '手动记录',
  'auto-outline': '生成大纲时自动记录',
  'auto-content': '生成正文时自动记录',
};

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
  const [addId, setAddId] = useState('');
  const [timelineId, setTimelineId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    setAddId('');
  }, [chapter.id]);

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

  const addable = useMemo(() => {
    if (!sourceBoard) return [] as (SimNodeType & { data: CharacterData })[];
    const used = new Set((snap?.entries ?? []).map((e) => e.characterId));
    return sourceBoard.nodes
      .filter(
        (n): n is SimNodeType & { data: CharacterData } =>
          n.data.kind === 'character' && !used.has(n.id),
      )
      .sort((a, b) => (a.data.name || '未命名').localeCompare(b.data.name || '未命名', 'zh-Hans-CN'));
  }, [sourceBoard, snap]);

  const fail = (error: string) => window.alert(ERROR_TEXT[error] ?? '操作失败');

  const drawRegion = () => {
    if (readonly) return;
    const r = beginChapterRegion(chapter.id);
    if (!r.ok) {
      window.alert(r.message);
      return;
    }
    onRequestClose?.();
  };

  const capture = () => {
    if (readonly) return;
    const r = useStudioStore.getState().captureChapterSnapshot(chapter.id);
    if (!r.ok) fail(r.error);
  };

  const recapture = () => {
    if (readonly) return;
    const label = currentBoard ? boardLabel(currentBoard, volumes) : '当前画布';
    if (!window.confirm(`把本章名单重新采集到「${label}」？当前快照的自动名单与人工覆盖会被替换。`)) return;
    const r = useStudioStore.getState().captureChapterSnapshot(chapter.id);
    if (!r.ok) fail(r.error);
  };

  const refresh = () => {
    if (readonly) return;
    if (!window.confirm('刷新本章快照？会重新采集区域名单并更新人物状态标签；手动词条与人工改过的角色/状态会保留。')) return;
    const r = useStudioStore.getState().refreshChapterSnapshot(chapter.id);
    if (!r.ok) fail(r.error);
  };

  const clear = () => {
    if (readonly) return;
    if (!window.confirm('清除本章快照？区域与画布人物不会删除，只移除名单记录。')) return;
    const r = useStudioStore.getState().clearChapterSnapshot(chapter.id);
    if (!r.ok) fail(r.error);
  };

  const add = () => {
    if (!addId) return;
    const r = useStudioStore.getState().addSnapshotEntry(chapter.id, addId);
    if (!r.ok) fail(r.error);
    else setAddId('');
  };

  const count = snap?.entries.length ?? 0;
  const issues = stale?.codes ?? [];
  const sourceChanged = !!snap && snap.boardId !== currentBoardId;

  const roleButton = (e: ChapterSnapshotEntry, role: CastRole) => {
    const active = e.role === role;
    return (
      <button
        key={role}
        type="button"
        data-snapshot-role={role}
        disabled={readonly}
        onClick={() => {
          if (active) return;
          const r = useStudioStore.getState().updateSnapshotEntry(chapter.id, e.characterId, { role });
          if (!r.ok) fail(r.error);
        }}
        className="rounded-full border px-1.5 py-0.5 text-[10.5px] leading-4 transition disabled:cursor-default"
        style={
          active
            ? {
                borderColor: 'var(--rd-accent)',
                background: 'var(--rd-accent-soft)',
                color: 'var(--rd-accent)',
                fontWeight: 600,
              }
            : { borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }
        }
        title={role === 'present' ? '在本章现场：可行动/说话/被直接描写' : '只在本章被提及：不得到场行动'}
      >
        {roleText(role)}
      </button>
    );
  };

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
            未同步
          </span>
        )}
      </button>

      {open && (
        <div className="border-t px-3 py-2.5" style={{ borderColor: 'var(--rd-border)' }}>
          {!snap ? (
            <div className="space-y-2 text-[12px] leading-relaxed" style={{ color: 'var(--rd-sub)' }}>
              {currentRegion ? (
                <>
                  <div>区域已绑定。采集后，本章生成大纲/正文会以名单为准：场内人物可行动，边缘人物默认仅提及。</div>
                  {!readonly && (
                    <button
                      type="button"
                      onClick={capture}
                      className="flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium"
                      style={{ background: 'var(--rd-accent)', color: 'var(--rd-accent-ink)' }}
                    >
                      <Camera className="h-3.5 w-3.5" />
                      采集本章名单
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div>本章还没有区域。先在画布上圈出本章舞台，再采集名单。</div>
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
                  。快照不会自动刷新。
                </div>
              )}

              {count === 0 && (
                <div className="text-[12px] leading-relaxed" style={{ color: 'var(--rd-sub)' }}>
                  区域里还没有人物。可继续在画布放入人物后刷新，或从下方手动添加提及人物。
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
                                  <span className="rounded-full border px-1 text-[9.5px] font-normal opacity-70" style={{ borderColor: 'var(--rd-border)' }}>
                                    手动
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
                                {node && !readonly ? (
                                  <select
                                    data-snapshot-state
                                    value={e.stateId}
                                    onChange={(ev) => {
                                      const rr = useStudioStore
                                        .getState()
                                        .updateSnapshotEntry(chapter.id, e.characterId, { stateId: ev.target.value });
                                      if (!rr.ok) fail(rr.error);
                                    }}
                                    className="max-w-[9rem] rounded border bg-transparent px-1 py-0.5 text-[10.5px]"
                                    style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}
                                    title="快照使用的状态（不改变人物当前状态）"
                                  >
                                    {!node.data.states.some((st) => st.id === e.stateId) && (
                                      <option value={e.stateId}>{stateLabel}（缺失）</option>
                                    )}
                                    {node.data.states.map((st) => (
                                      <option key={st.id} value={st.id}>
                                        {st.label}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="rounded border px-1" style={{ borderColor: 'var(--rd-border)' }}>
                                    {stateLabel}
                                  </span>
                                )}
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
                            {!readonly && (
                              <div className="flex shrink-0 items-center gap-2">
                                <div className="flex items-center gap-0.5">
                                  {roleButton(e, 'present')}
                                  {roleButton(e, 'mentioned')}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const rr = useStudioStore.getState().removeSnapshotEntry(chapter.id, e.characterId);
                                    if (!rr.ok) fail(rr.error);
                                  }}
                                  className="rounded p-0.5 opacity-50 transition hover:bg-rose-500/10 hover:text-rose-500 hover:opacity-100"
                                  style={{ color: 'var(--rd-sub)' }}
                                  title="从本章名单移除（不影响画布人物）"
                                  aria-label={`从名单移除 ${name}`}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            )}
                            {readonly && (
                              <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--rd-sub)' }}>
                                {roleText(e.role)}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {!readonly && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <select
                    data-snapshot-add
                    value={addId}
                    onChange={(ev) => setAddId(ev.target.value)}
                    className="min-w-0 flex-1 rounded-[8px] border px-2 py-1 text-[11.5px]"
                    style={{ borderColor: 'var(--rd-border)', background: 'var(--rd-card)', color: 'var(--rd-text)' }}
                    title="手动添加名单外人物（默认仅提及）"
                    disabled={!sourceBoard || !addable.length}
                  >
                    <option value="">
                      {!sourceBoard
                        ? '来源画布已删除，无法添加'
                        : addable.length
                          ? '手动添加人物（默认仅提及）…'
                          : '画布上没有可添加的人物'}
                    </option>
                    {addable.map((n) => {
                      const st = n.data.states.find((x) => x.id === n.data.activeStateId) ?? n.data.states[0];
                      return (
                        <option key={n.id} value={n.id}>
                          {(n.data.name || '未命名') + (st ? `（${st.label}）` : '')}
                        </option>
                      );
                    })}
                  </select>
                  <button
                    type="button"
                    disabled={!addId}
                    onClick={add}
                    className="flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[11.5px] disabled:opacity-40"
                    style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}
                  >
                    <Plus className="h-3 w-3" />
                    添加
                  </button>
                </div>
              )}

              {!readonly && (
                <div className="flex flex-wrap items-center gap-1.5 border-t pt-2" style={{ borderColor: 'var(--rd-border)' }}>
                  {sourceRegion && sourceBoard && (
                    <button
                      type="button"
                      onClick={refresh}
                      className="flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[11.5px]"
                      style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}
                      title="重新采集自动名单与几何；手动词条、人工角色/状态覆盖保留"
                    >
                      <RefreshCw className="h-3 w-3" />
                      刷新快照
                    </button>
                  )}
                  {sourceChanged && currentRegion && (
                    <button
                      type="button"
                      onClick={recapture}
                      className="flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[11.5px]"
                      style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}
                      title="用本章当前画布的区域与人物重新记录快照"
                    >
                      <Camera className="h-3 w-3" />
                      重新采集到当前画布
                    </button>
                  )}
                  {!sourceRegion && currentRegion && (
                    <button
                      type="button"
                      onClick={recapture}
                      className="flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[11.5px]"
                      style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}
                    >
                      <Camera className="h-3 w-3" />
                      重新采集
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={clear}
                    className="flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[11.5px] hover:border-rose-300 hover:text-rose-600"
                    style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}
                    title="清除本章快照（区域与人物保留）"
                  >
                    <Trash2 className="h-3 w-3" />
                    清除快照
                  </button>
                </div>
              )}

              {readonly && (
                <div className="text-[10.5px]" style={{ color: 'var(--rd-sub)' }}>
                  编辑名单请到「大纲」管理器。全 {chapters.length} 章共享同一份快照记录。
                </div>
              )}
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
