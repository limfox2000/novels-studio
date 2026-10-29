/** 🔎 跨卷查人（P3 · v3 人物库）：按人名搜索**人物库**，每人一行（人物身份作品级）。
 *  行内列出该人物在全部画布的放置（逐放置定位）；未放置人物照常出现（可只存在于库中）。
 *  同名不同人（规范化后同名、库 ID 不同）照常分列，ambiguous 只做提示，绝不合并。
 *  结果可打开只读人物时间轴。搜索/定位不修改任何人物或快照数据。 */
import { useMemo, useState } from 'react';
import { History, LocateFixed, Search, UserRound } from 'lucide-react';
import { useStudioStore } from '../../stores/studioStore';
import { normalizeCharacterName, searchCharacters, type CharacterPlacementRef, type CharacterSearchHit } from '../../stores/characterSearch';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { CharacterTimelineDialog } from './CharacterTimelineDialog';
import type { NodeChange } from '@xyflow/react';
import type { SimNodeType } from '../../types/sim';

/** 显式切到目标画布并选中放置节点；不静默停留在当前画布 */
function locatePlacement(boardId: string, nodeId: string): boolean {
  const st = useStudioStore.getState();
  if (!st.boards[boardId]) return false;
  st.switchBoard(boardId);
  const after = useStudioStore.getState();
  const board = after.boards[boardId];
  if (!board || !board.nodes.some((n) => n.id === nodeId)) return false;
  const changes: NodeChange<SimNodeType>[] = board.nodes
    .filter((n) => n.selected && n.id !== nodeId)
    .map((n) => ({ type: 'select', id: n.id, selected: false }));
  const target = board.nodes.find((n) => n.id === nodeId);
  if (!target?.selected) changes.push({ type: 'select', id: nodeId, selected: true });
  if (changes.length) after.onNodesChange(changes);
  return true;
}

/** 单个放置行（定位按钮 + 所在画布与该放置的当前状态） */
function PlacementRow({ hit, p, onLocate }: { hit: CharacterSearchHit; p: CharacterPlacementRef; onLocate: (p: CharacterPlacementRef) => void }) {
  return (
    <div className="flex items-center gap-1.5 rounded-[8px] bg-slate-500/5 px-2 py-1 text-[10.5px]" style={{ color: 'var(--rd-sub)' }}>
      <span className="min-w-0 flex-1 truncate">
        {p.volumeTitle ? `${p.boardLabel}（${p.volumeTitle}）` : p.boardLabel}
        <span className="mx-1">·</span>
        当前状态：{p.activeStateLabel}
      </span>
      <button
        type="button"
        data-locate
        data-placement-board={p.boardId}
        data-placement-node={p.nodeId}
        onClick={() => onLocate(p)}
        className="flex shrink-0 items-center gap-1 rounded-[7px] border px-1.5 py-0.5 text-[10.5px] transition hover:bg-white"
        style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}
        title={`切换到「${p.boardLabel}」并选中「${hit.name}」`}
      >
        <LocateFixed className="h-3 w-3" />
        定位
      </button>
    </div>
  );
}

export function CharacterSearchDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [timelineId, setTimelineId] = useState<string | null>(null);
  const characters = useStudioStore((s) => s.characters);
  const boards = useStudioStore((s) => s.boards);
  const volumes = useStudioStore((s) => s.volumes);
  const chapters = useStudioStore((s) => s.chapters);
  const hits = useMemo(() => searchCharacters(characters, boards, volumes, chapters, query), [characters, boards, volumes, chapters, query]);
  const q = normalizeCharacterName(query);
  const ambiguousCount = hits.filter((h) => h.ambiguous).length;

  const locate = (p: CharacterPlacementRef) => {
    if (locatePlacement(p.boardId, p.nodeId)) onClose();
  };

  return (
    <>
      <Dialog
        title="跨卷查人"
        subtitle="按人名搜索作品人物库。每人一行，行内列出其全部画布放置；同名不同人不会合并；定位会明确切换到对应画布并选中人物。"
        icon={<Search />}
        width="md"
        onClose={onClose}
        footer={
          <Button size="sm" variant="secondary" onClick={onClose}>
            关闭
          </Button>
        }
      >
        <div data-character-search className="space-y-2">
          <label className="flex items-center gap-1.5 rounded-[10px] border px-2.5 py-1.5" style={{ borderColor: 'var(--rd-border)' }}>
            <Search className="h-3.5 w-3.5 shrink-0 opacity-60" style={{ color: 'var(--rd-sub)' }} />
            <input
              data-character-search-input
              autoFocus
              value={query}
              maxLength={40}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="输入人名，支持部分匹配（忽略空格/大小写）"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              style={{ color: 'var(--rd-text)' }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="shrink-0 rounded px-1 text-[11px] opacity-60 hover:opacity-100"
                style={{ color: 'var(--rd-sub)' }}
                title="清空搜索"
              >
                清空
              </button>
            )}
          </label>

          {!q ? (
            <div className="rounded-[10px] border px-3 py-3 text-[12px] leading-relaxed" style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}>
              输入人名后在作品人物库中查找。点击放置行的「定位」切到对应画布并选中；点击「时间轴」查看该人物在章节快照中的出场记录。
            </div>
          ) : hits.length === 0 ? (
            <div className="rounded-[10px] border px-3 py-3 text-[12px] leading-relaxed" style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}>
              没有匹配「{query.trim()}」的人物（人物库共 {Object.keys(characters).length} 人）。
            </div>
          ) : (
            <>
              <div className="text-[11px]" style={{ color: 'var(--rd-sub)' }}>
                共 {hits.length} 人{ambiguousCount ? `，其中 ${ambiguousCount} 人存在同名` : ''}
              </div>
              <div className="space-y-1.5">
                {hits.map((hit) => (
                  <div
                    key={hit.characterId}
                    data-search-hit={hit.characterId}
                    data-hit-ambiguous={hit.ambiguous ? '1' : undefined}
                    className="flex items-start gap-2 rounded-[10px] border px-2.5 py-2"
                    style={{ borderColor: hit.ambiguous ? 'rgb(253 230 138)' : 'var(--rd-border)', background: hit.ambiguous ? 'rgb(255 251 235 / 0.55)' : undefined }}
                  >
                    <UserRound className="mt-0.5 h-4 w-4 shrink-0 opacity-55" style={{ color: 'var(--rd-sub)' }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium" style={{ color: 'var(--rd-text)' }}>
                        <span className="truncate">{hit.name}</span>
                        <span className="text-[10.5px] font-normal opacity-65">{hit.gender === 'female' ? '女' : '男'}</span>
                        {!hit.placed && (
                          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-500">未放置</span>
                        )}
                        {hit.ambiguous && (
                          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-normal text-amber-700">
                            同名 {hit.sameNameCount} 人
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px]" style={{ color: 'var(--rd-sub)' }}>
                        <span>{hit.stateCount} 个状态</span>
                        <span>·</span>
                        <span>{hit.placed ? `${hit.placements.length} 处放置` : '未放置到画布'}</span>
                        <span>·</span>
                        <span>{hit.chapterRefs ? `被 ${hit.chapterRefs} 章引用` : '无章节引用'}</span>
                      </div>
                      {hit.placements.length > 0 && (
                        <div className="mt-1 space-y-1">
                          {hit.placements.map((p) => (
                            <PlacementRow key={p.nodeId} hit={hit} p={p} onLocate={locate} />
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        data-timeline-open={hit.characterId}
                        onClick={() => setTimelineId(hit.characterId)}
                        className="flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[11px] transition hover:bg-white"
                        style={{ borderColor: 'var(--rd-border)', color: 'var(--rd-sub)' }}
                        title="查看该人物在章节快照中的出现记录（只读）"
                      >
                        <History className="h-3 w-3" />
                        时间轴
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {ambiguousCount > 0 && (
                <div className="rounded-[10px] border border-amber-200 bg-amber-50/60 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800">
                  存在同名不同人（人物库中是多条记录）。修改/合并前请先核对放置与章节引用，确认是哪一位。
                </div>
              )}
            </>
          )}
        </div>
      </Dialog>
      {timelineId && <CharacterTimelineDialog characterId={timelineId} onClose={() => setTimelineId(null)} />}
    </>
  );
}
