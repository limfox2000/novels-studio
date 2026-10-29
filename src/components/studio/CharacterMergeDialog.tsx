/** 🔀 合并人物（v3 人物库 · 简单版）：把若干人物并入一个主人物。
 *  - 主人物保留身份（人名/性别）与全部状态；其余人物的状态逐个追加（标签冲突加「（N）」，ID 冲突重映射）；
 *  - 其余人物的画布放置改指主人物（同板重复保留首个，C4）；章节快照引用一并改写；
 *  - 结果不可自动撤销（可手动从主人物再拆），确认前给出受影响放置/章节计数与状态改名预览。 */
import { useMemo, useState } from 'react';
import { GitMerge, Plus, Trash2 } from 'lucide-react';
import { useStudioStore } from '../../stores/studioStore';
import { normalizeCharacterName } from '../../stores/characterSearch';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import type { WorkCharacter } from '../../types/sim';

export function CharacterMergeDialog({ initialIds, onClose }: { initialIds: string[]; onClose: () => void }) {
  const characters = useStudioStore((s) => s.characters);
  const boards = useStudioStore((s) => s.boards);
  const chapters = useStudioStore((s) => s.chapters);
  const [members, setMembers] = useState<string[]>(() => initialIds.filter((id) => !!characters[id]));
  const [primaryId, setPrimaryId] = useState<string>(() => initialIds.find((id) => !!characters[id]) ?? '');

  const memberChars = useMemo(
    () => members.map((id) => characters[id]).filter((c): c is WorkCharacter => !!c),
    [members, characters],
  );
  const primary = characters[primaryId];
  const others = memberChars.filter((c) => c.id !== primaryId);

  // 预览：状态追加与标签改名（近似 store 的去重规则——首个冲突加「（2）」）
  const preview = useMemo(() => {
    if (!primary || !others.length) return null;
    const usedLabels = new Set(primary.states.map((st) => st.label));
    const renamed: Array<{ name: string; from: string; to: string }> = [];
    let appended = 0;
    for (const o of others) {
      for (const st of o.states) {
        appended++;
        let label = st.label.replace(/\s+/g, ' ').trim() || '状态';
        let n = 2;
        while (usedLabels.has(label)) {
          label = `${label}（${n++}）`;
        }
        usedLabels.add(label);
        if (label !== st.label) renamed.push({ name: o.name || '未命名', from: st.label, to: label });
      }
    }
    const placementCount = others.reduce(
      (n, o) =>
        n +
        Object.values(boards).filter((b) =>
          b.nodes.some((x) => x.data.kind === 'character' && x.data.characterId === o.id),
        ).length,
      0,
    );
    const otherIds = new Set(others.map((o) => o.id));
    const chapterCount = chapters.filter((c) => c.snapshot?.entries.some((e) => otherIds.has(e.characterId))).length;
    return { appended, renamed, placementCount, chapterCount };
  }, [primary, others, boards, chapters]);

  const addable = Object.values(characters).filter((c) => !members.includes(c.id));

  const confirm = () => {
    if (!primary || !others.length) return;
    const names = others.map((o) => `「${o.name || '未命名'}」`).join('、');
    const impact = preview?.chapterCount
      ? `\n\n${preview.chapterCount} 个章节的名单快照引用会改写到主人物（状态引用按重映射对应）。`
      : '';
    if (!window.confirm(`把 ${names} 并入「${primary.name || '未命名'}」？其余人物将从人物库移除（其状态全部追加到主人物），放置与快照引用一并改写。此操作不可自动撤销。${impact}`)) return;
    useStudioStore.getState().mergeCharacters(primaryId, others.map((o) => o.id));
    onClose();
  };

  return (
    <Dialog
      title="合并人物"
      subtitle="同一人物的多条库记录（同名/误建）合并为一条：选一个主人物保留身份，其余人物的状态全部追加进去。画布放置与章节快照引用自动改写，不会丢章。"
      icon={<GitMerge />}
      width="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="soft" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" icon={<GitMerge />} onClick={confirm} disabled={!primary || !others.length}>
            合并（{others.length + (primary ? 1 : 0)} → 1）
          </Button>
        </>
      }
    >
      <div data-character-merge className="space-y-3">
        <div>
          <div className="mb-1 text-[12px] font-medium text-slate-500">主人物（保留身份：人名/性别）</div>
          <Select value={primaryId} onChange={(e) => setPrimaryId(e.target.value)} disabled={!memberChars.length}>
            {memberChars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || '未命名'}（{c.gender === 'female' ? '女' : '男'}，{c.states.length} 个状态）
              </option>
            ))}
          </Select>
        </div>

        <div>
          <div className="mb-1 text-[12px] font-medium text-slate-500">并入主人物（合并后从库中移除）</div>
          <div className="space-y-1">
            {others.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2 rounded-[8px] border px-2.5 py-1.5 text-[12px]"
                style={{ borderColor: 'var(--rd-border, #e2e8f0)' }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {c.name || '未命名'}
                  <span className="ml-1.5 text-[10.5px] text-slate-400">
                    {c.gender === 'female' ? '女' : '男'} · {c.states.length} 个状态
                    {normalizeCharacterName(c.name) === normalizeCharacterName(primary?.name ?? '') ? '' : '（与主人物不同名）'}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setMembers((m) => m.filter((id) => id !== c.id))}
                  className="flex shrink-0 items-center gap-1 rounded-[7px] border px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:bg-slate-50"
                  title="不合并此人物"
                >
                  <Trash2 className="h-3 w-3" />
                  移出
                </button>
              </div>
            ))}
            {!others.length && (
              <p className="rounded-[8px] border border-amber-200 bg-amber-50/60 px-2.5 py-2 text-[12px] text-amber-700">
                没有要并入的人物。可从下方添加，或取消合并。
              </p>
            )}
          </div>
          {addable.length > 0 && (
            <Select
              value=""
              onChange={(e) => {
                if (e.target.value) setMembers((m) => (m.includes(e.target.value) ? m : [...m, e.target.value]));
              }}
              className="mt-1.5"
              title="把人物库中的其它人物也并入主人物"
            >
              <option value="">＋ 添加要并入的人物…</option>
              {addable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || '未命名'}（{c.gender === 'female' ? '女' : '男'}，{c.states.length} 个状态）
                </option>
              ))}
            </Select>
          )}
        </div>

        {preview && (
          <div className="rounded-[10px] bg-slate-50 px-3 py-2.5 text-[12px] leading-relaxed text-slate-600">
            <p className="font-medium text-slate-700">合并预览</p>
            <p className="mt-1">
              「{primary.name || '未命名'}」保留现有 {primary.states.length} 个状态，追加{' '}
              <b data-merge-appended>{preview.appended}</b> 个状态；{preview.placementCount} 处画布放置改指主人物（同画布重复只保留一处）；
              {preview.chapterCount ? ` ${preview.chapterCount} 个章节的快照引用改写。` : ' 无章节快照引用需要改写。'}
            </p>
            {preview.renamed.length > 0 && (
              <p className="mt-1 text-amber-700">
                状态重名自动改名：
                {preview.renamed
                  .slice(0, 6)
                  .map((r) => `${r.name}「${r.from}」→「${r.to}」`)
                  .join('、')}
                {preview.renamed.length > 6 ? '…' : ''}
              </p>
            )}
            {others.some((o) => normalizeCharacterName(o.name) !== normalizeCharacterName(primary?.name ?? '')) && (
              <p className="mt-1 text-amber-700">注意：存在与主人物不同名的人物，合并后统一使用主人物的名字。</p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
