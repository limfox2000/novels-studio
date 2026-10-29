/** 📇 人物库面板（v3 · 作品级人物唯一性）：把「人物」从画布节点提升为作品级库记录后的统一管理入口。
 *  - 列表：姓名/性别/状态数/放置数/章节引用数；搜索按人名（忽略空格/大小写）；筛选 全部/已放置/未放置/疑似重复（同名多人）；
 *  - 详情：身份编辑（人名/性别，写库全局生效）、状态条与人物形象（复用 SimInspector 的库级组件）、
 *    使用位置（放置可定位/移除，可放置到当前画布）、章节引用列表（只读）；
 *  - 全局操作：新建人物（只建库不放置，C7）、删除人物（列受影响章节+二次确认）、合并（CharacterMergeDialog）；
 *  - 画布删节点只移除放置（C5），全局删除只发生在这里。 */
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BookUser,
  Crosshair,
  GitMerge,
  Link,
  MapPin,
  Mars,
  Search,
  Unlink,
  UserPlus,
  UserRound,
  Venus,
  X,
} from 'lucide-react';
import type { NodeChange } from '@xyflow/react';
import { useStudioStore } from '../../stores/studioStore';
import { boardLabel } from '../../stores/boardOps';
import { normalizeCharacterName } from '../../stores/characterSearch';
import { characterActiveState } from '../../stores/characterStates';
import { characterReferenceSummary, referenceChapterText } from '../../stores/snapshotRefs';
import { GENDER_STYLE } from './SimNodes';
import { CharacterAvatar } from './CharacterAvatar';
import { CharacterStateBar, CharacterImageSection } from './SimInspector';
import { CharacterMergeDialog } from './CharacterMergeDialog';
import type { CharacterGender, CharacterPlacementData, SimNodeType, WorkCharacter } from '../../types/sim';
import { genderOf } from '../../types/sim';

type Filter = 'all' | 'placed' | 'unplaced' | 'duplicate';

const FILTER_LABEL: Record<Filter, string> = {
  all: '全部',
  placed: '已放置',
  unplaced: '未放置',
  duplicate: '疑似重复',
};

/** 单个人物在全部画布的放置（boardId+nodeId；C4 一板至多一个） */
function placementsOf(characterId: string, boards: Record<string, { nodes: SimNodeType[] }>): Array<{ boardId: string; nodeId: string }> {
  const out: Array<{ boardId: string; nodeId: string }> = [];
  for (const [boardId, b] of Object.entries(boards)) {
    for (const n of b.nodes) {
      if (n.data.kind === 'character' && n.data.characterId === characterId) out.push({ boardId, nodeId: n.id });
    }
  }
  return out;
}

/** 显式切到目标画布并选中放置节点（与跨卷查人同一语义：不静默停留在当前画布） */
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

export function CharacterLibraryPanel({ onClose }: { onClose: () => void }) {
  const characters = useStudioStore((s) => s.characters);
  const boards = useStudioStore((s) => s.boards);
  const volumes = useStudioStore((s) => s.volumes);
  const chapters = useStudioStore((s) => s.chapters);
  const activeBoardId = useStudioStore((s) => s.activeBoardId);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mergeIds, setMergeIds] = useState<string[] | null>(null);

  const library = useMemo(() => Object.values(characters), [characters]);
  // 同名分组（规范化后同名、库 ID 不同）：疑似重复筛选与合并入口共用
  const nameGroups = useMemo(() => {
    const map = new Map<string, WorkCharacter[]>();
    for (const c of library) {
      const key = normalizeCharacterName(c.name);
      if (!key) continue;
      const list = map.get(key);
      if (list) list.push(c);
      else map.set(key, [c]);
    }
    return map;
  }, [library]);

  const rows = useMemo(() => {
    const q = normalizeCharacterName(query);
    return library
      .map((c) => {
        const placements = placementsOf(c.id, boards);
        const refs = characterReferenceSummary(chapters, c.id);
        const sameName = (nameGroups.get(normalizeCharacterName(c.name)) ?? []).filter((x) => x.id !== c.id);
        return { character: c, placements, refCount: refs.count, refs, duplicate: sameName.length > 0, sameNameIds: sameName.map((x) => x.id) };
      })
      .filter((r) => {
        if (q && !normalizeCharacterName(r.character.name).includes(q)) return false;
        if (filter === 'placed') return r.placements.length > 0;
        if (filter === 'unplaced') return r.placements.length === 0;
        if (filter === 'duplicate') return r.duplicate;
        return true;
      })
      .sort((a, b) => {
        const an = a.character.name.trim();
        const bn = b.character.name.trim();
        if (!an && bn) return 1;
        if (an && !bn) return -1;
        return an.localeCompare(bn, 'zh-Hans-CN');
      });
  }, [library, boards, chapters, nameGroups, query, filter]);

  const selected = selectedId ? (characters[selectedId] ?? null) : null;
  const selectedPlacements = useMemo(
    () => (selected ? placementsOf(selected.id, boards) : []),
    [selected, boards],
  );
  const selectedRefs = useMemo(
    () => (selected ? characterReferenceSummary(chapters, selected.id) : null),
    [selected, chapters],
  );
  // 详情里的「当前状态」：已放置在当前画布 → 该放置的 activeStateId；否则首项状态
  const activePlacementStateId = useMemo(() => {
    if (!selected) return undefined;
    const here = placementsOf(selected.id, boards).find((p) => p.boardId === activeBoardId);
    if (!here) return undefined;
    const node = boards[activeBoardId]?.nodes.find((n) => n.id === here.nodeId);
    return node && node.data.kind === 'character' ? node.data.activeStateId : undefined;
  }, [selected, boards, activeBoardId]);

  const createNew = () => {
    const characterId = useStudioStore.getState().createCharacter({});
    setSelectedId(characterId);
  };

  const deleteSelected = () => {
    if (!selected) return;
    const placementCount = selectedPlacements.length;
    const refs = selectedRefs;
    const impact = refs?.count
      ? `\n\n该人物被 ${refs.count} 章引用：${referenceChapterText(refs, 6)}；删除后这些章节的名单条目会显示「人物缺失」，生成时不会猜测补全。`
      : '';
    if (
      !window.confirm(
        `删除人物「${selected.name || '未命名'}」？将同时移除 ${placementCount} 处画布放置、${selected.states.length} 个状态及其全部形象图片，不可恢复。${impact}`,
      )
    )
      return;
    useStudioStore.getState().deleteCharacter(selected.id);
    setSelectedId(null);
  };

  const startMerge = () => {
    if (!selected) return;
    setMergeIds([selected.id, ...rows.find((r) => r.character.id === selected.id)?.sameNameIds ?? []]);
  };

  const selectedSameName = selected ? (nameGroups.get(normalizeCharacterName(selected.name)) ?? []).filter((c) => c.id !== selected.id) : [];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-3 backdrop-blur-[1px] sm:p-4"
      data-character-library
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="人物库"
        className="nv-in flex h-[min(760px,calc(100vh-1.5rem))] w-full max-w-5xl flex-col overflow-hidden rounded-[16px] border border-slate-200/80 bg-white shadow-panel"
      >
        {/* 头部 */}
        <div className="flex shrink-0 items-start gap-2.5 px-4 pb-3 pt-4">
          <span className="mt-0.5 shrink-0 text-slate-500 [&>svg]:h-4 [&>svg]:w-4">
            <BookUser />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-6 text-slate-800">人物库</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-slate-500">
              作品级人物唯一：人物设定属作品，画布上只是放置。这里改一处，全部画布同步生效；画布删节点只移除放置。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            title="关闭人物库"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 主体：列表 | 详情（移动端单列互斥显示） */}
        <div className="flex min-h-0 flex-1 border-t border-slate-100">
          {/* 列表 */}
          <div className={`min-h-0 w-full flex-col border-r border-slate-100 md:flex md:w-[288px] md:shrink-0 ${selected ? 'hidden' : 'flex'}`}>
            <div className="shrink-0 space-y-2 px-3 pt-3">
              <label className="flex items-center gap-1.5 rounded-[10px] border border-slate-200 px-2.5 py-1.5">
                <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <input
                  data-library-search
                  value={query}
                  maxLength={40}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜人名（忽略空格/大小写）"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-slate-700 outline-none placeholder:text-slate-300"
                />
              </label>
              <div className="flex gap-1" data-library-filter>
                {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`flex-1 rounded-full border px-1.5 py-1 text-[11.5px] transition ${
                      filter === f
                        ? 'border-brand-500/40 bg-brand-50 font-medium text-brand-700'
                        : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    {FILTER_LABEL[f]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                data-library-create
                onClick={createNew}
                className="flex w-full items-center justify-center gap-1 rounded-[10px] border border-dashed border-slate-300 py-1.5 text-[12.5px] text-slate-500 transition hover:border-brand-400 hover:bg-brand-50/50 hover:text-brand-700"
                title="新建人物：只建库记录不放置（可稍后放到任意画布）"
              >
                <UserPlus className="h-3.5 w-3.5" />
                新建人物
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2" data-library-list>
              {rows.length === 0 ? (
                <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-slate-400">
                  {library.length === 0
                    ? '人物库还是空的。可在画布「＋人物」、编辑室对话落人物设定，或在这里新建。'
                    : '没有符合条件的人物。'}
                </p>
              ) : (
                rows.map(({ character: c, placements, refCount, duplicate }) => {
                  const gs = GENDER_STYLE[genderOf(c.gender)];
                  const active = c.id === selectedId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      data-library-row={c.id}
                      data-row-placed={placements.length > 0 ? '1' : undefined}
                      data-row-duplicate={duplicate ? '1' : undefined}
                      onClick={() => setSelectedId(c.id)}
                      className={`mb-1 flex w-full items-center gap-2 rounded-[10px] border px-2 py-1.5 text-left transition ${
                        active
                          ? 'border-brand-500/40 bg-brand-50'
                          : 'border-transparent hover:bg-slate-50'
                      }`}
                    >
                      <CharacterAvatar image={c.states[0]?.image} gender={genderOf(c.gender)} stateId={c.states[0]?.id} size={30} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1">
                          <span className={`truncate text-[13px] ${active ? 'font-medium text-brand-800' : 'text-slate-700'}`}>
                            {c.name || '未命名'}
                          </span>
                          <span className={`shrink-0 rounded-full bg-slate-100 px-1 text-[9.5px] ${gs.text}`}>
                            {gs.label}
                          </span>
                          {duplicate && (
                            <span className="shrink-0 rounded-full bg-amber-100 px-1 text-[9.5px] text-amber-700" title="人物库中存在同名人物">
                              同名
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1 text-[10.5px] text-slate-400">
                          <span>{c.states.length} 状态</span>
                          <span>·</span>
                          <span>{placements.length ? `${placements.length} 处放置` : '未放置'}</span>
                          {refCount > 0 && (
                            <>
                              <span>·</span>
                              <span>{refCount} 章引用</span>
                            </>
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <div className="shrink-0 border-t border-slate-100 px-3 py-2 text-[10.5px] text-slate-400">
              共 {library.length} 人 · 放置 {Object.values(boards).reduce((n, b) => n + b.nodes.filter((x) => x.data.kind === 'character').length, 0)} 处
            </div>
          </div>

          {/* 详情 */}
          <div className={`min-h-0 w-full flex-1 flex-col overflow-y-auto md:flex md:w-auto ${selected ? 'flex' : 'hidden'}`}>
            {!selected ? (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] leading-relaxed text-slate-400">
                从左侧选择一个人物查看/编辑。
              </div>
            ) : (
              <div className="space-y-3 p-3.5">
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="text-[12px] text-slate-400 transition hover:text-slate-600 md:hidden"
                >
                  ← 返回列表
                </button>
                {/* 身份：人名/性别（写库，全部画布生效） */}
                <div className="flex items-start gap-3">
                  <CharacterAvatar
                    image={characterActiveState(selected, activePlacementStateId).image}
                    gender={genderOf(selected.gender)}
                    stateId={characterActiveState(selected, activePlacementStateId).id}
                    size={44}
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <label className="block">
                      <span className="mb-1 block text-[12px] font-medium text-slate-500">人名</span>
                      <input
                        data-library-name
                        value={selected.name}
                        maxLength={12}
                        onChange={(e) => useStudioStore.getState().updateCharacter(selected.id, { name: e.target.value })}
                        placeholder="人名"
                        className="h-9 w-full rounded-[10px] border border-slate-200 px-3 text-[13px] text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-brand-400 focus:ring-4 focus:ring-brand-500/10"
                      />
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-[12px] font-medium text-slate-500">性别</span>
                      <div className="flex gap-1">
                        {(['male', 'female'] as CharacterGender[]).map((g) => {
                          const gs = GENDER_STYLE[g];
                          const active = genderOf(selected.gender) === g;
                          return (
                            <button
                              key={g}
                              type="button"
                              onClick={() => useStudioStore.getState().updateCharacter(selected.id, { gender: g })}
                              title={`性别：${gs.label}（写库，全部画布放置同步生效；决定节点配色）`}
                              className={`flex items-center gap-1 rounded-[8px] border px-3 py-1.5 text-[12px] transition ${
                                active
                                  ? `${gs.capsule} border-transparent font-medium text-white`
                                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                              }`}
                            >
                              {g === 'male' ? <Mars className="h-3.5 w-3.5" /> : <Venus className="h-3.5 w-3.5" />}
                              {gs.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 状态条 + 状态属性/人物形象：复用 SimInspector 的库级组件 */}
                <div className="rounded-[12px] border border-slate-200 p-3">
                  <CharacterStateBar
                    characterId={selected.id}
                    character={selected}
                    activeStateId={activePlacementStateId}
                  />
                  <CharacterImageSection
                    characterId={selected.id}
                    state={characterActiveState(selected, activePlacementStateId)}
                    gender={genderOf(selected.gender)}
                  />
                </div>

                {/* 使用位置：放置可定位/移除；未放在当前画布可一键放置 */}
                <div className="rounded-[12px] border border-slate-200 p-3" data-library-placements>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-slate-600">
                    <MapPin className="h-3.5 w-3.5 text-slate-400" />
                    使用位置（画布放置）
                  </div>
                  {selectedPlacements.length === 0 ? (
                    <p className="text-[12px] leading-relaxed text-slate-400">
                      未放置到任何画布（人物可以只存在于库中）。放置到当前画布后才会出现在章节场景里。
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {selectedPlacements.map((p) => {
                        const b = boards[p.boardId];
                        const label = b ? boardLabel(b, volumes) : '已删除的画布';
                        const here = p.boardId === activeBoardId;
                        return (
                          <div
                            key={p.nodeId}
                            className="flex items-center gap-1.5 rounded-[8px] bg-slate-500/5 px-2 py-1 text-[11.5px] text-slate-500"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {label}
                              {here ? '（当前画布）' : ''}
                            </span>
                            <button
                              type="button"
                              data-library-locate={p.nodeId}
                              onClick={() => {
                                if (locatePlacement(p.boardId, p.nodeId)) onClose();
                              }}
                              className="flex shrink-0 items-center gap-1 rounded-[7px] border border-slate-200 px-1.5 py-0.5 text-[10.5px] transition hover:bg-white"
                              title={`切到「${label}」并选中该人物`}
                            >
                              <Crosshair className="h-3 w-3" />
                              定位
                            </button>
                            <button
                              type="button"
                              data-library-unlink={p.nodeId}
                              onClick={() => useStudioStore.getState().unlinkPlacement(p.boardId, p.nodeId)}
                              className="flex shrink-0 items-center gap-1 rounded-[7px] border border-slate-200 px-1.5 py-0.5 text-[10.5px] transition hover:bg-white"
                              title={`从「${label}」移除放置（人物与形象保留在库中，其它画布不受影响）`}
                            >
                              <Unlink className="h-3 w-3" />
                              移除
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {!selectedPlacements.some((p) => p.boardId === activeBoardId) && (
                    <button
                      type="button"
                      data-library-place-here
                      onClick={() => useStudioStore.getState().linkPlacement(activeBoardId, selected.id)}
                      className="mt-2 flex items-center gap-1 rounded-[8px] border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 transition hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-700"
                      title="把该人物放置到当前画布（视口中心；同一画布重复放置会复用已有放置）"
                    >
                      <Link className="h-3.5 w-3.5" />
                      放置到当前画布
                    </button>
                  )}
                </div>

                {/* 章节引用（只读） */}
                <div className="rounded-[12px] border border-slate-200 p-3" data-library-refs>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-slate-600">
                    <UserRound className="h-3.5 w-3.5 text-slate-400" />
                    章节引用（名单快照）
                  </div>
                  {selectedRefs?.count ? (
                    <>
                      <p className="text-[11.5px] leading-relaxed text-slate-500">
                        被 {selectedRefs.count} 章引用（按人物当前状态解析；修改状态属性会影响这些历史章的生成内容）。
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {selectedRefs.chapters.map((c) => (
                          <span
                            key={c.chapterId}
                            className="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] text-slate-500"
                            title={`采集时状态：${c.stateLabelAtCapture}`}
                          >
                            {c.title}
                          </span>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="text-[12px] text-slate-400">暂无章节引用。</p>
                  )}
                </div>

                {/* 全局操作 */}
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    data-library-merge
                    onClick={startMerge}
                    disabled={selectedSameName.length === 0}
                    className={`flex items-center gap-1 rounded-[8px] border px-2.5 py-1.5 text-[12px] transition ${
                      selectedSameName.length
                        ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                        : 'cursor-not-allowed border-slate-200 text-slate-300'
                    }`}
                    title={
                      selectedSameName.length
                        ? `与 ${selectedSameName.length} 个同名人物合并（主人物保留身份，其余状态追加）`
                        : '人物库中没有与该人物同名的人物可合并'
                    }
                  >
                    <GitMerge className="h-3.5 w-3.5" />
                    合并同名{selectedSameName.length ? `（${selectedSameName.length}）` : ''}
                  </button>
                  <button
                    type="button"
                    data-library-delete
                    onClick={deleteSelected}
                    className="flex items-center gap-1 rounded-[8px] border border-rose-200 px-2.5 py-1.5 text-[12px] text-rose-600 transition hover:bg-rose-50"
                    title="全局删除：移除库记录、全部画布放置与形象图片（先确认章节引用）"
                  >
                    <X className="h-3.5 w-3.5" />
                    删除人物
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {mergeIds && <CharacterMergeDialog initialIds={mergeIds} onClose={() => setMergeIds(null)} />}
    </div>,
    document.body,
  );
}
