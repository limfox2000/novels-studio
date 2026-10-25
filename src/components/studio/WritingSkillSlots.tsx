/** ✨ 正文面板左上角的写作技能入口：空时收起为一个小按钮，启用后显示 1–3 个紧凑胶囊。
 *  技能启用记录按章保存（SimChapter.writingSkillIds）；技能库全局共享（writingSkillStore）。
 *  点击入口/胶囊/加号都打开同一个选择弹窗；管理技能库在弹窗页脚进入。 */
import { useState } from 'react';
import { Plus, Sparkles, X } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useStudioStore } from '../../stores/studioStore';
import { useWritingSkillStore } from '../../stores/writingSkillStore';
import { resolveWritingSkills } from '../../engines/writingSkills';
import { WRITING_SKILL_ACTIVE_MAX, sanitizeWritingSkillIds } from '../../types/writingSkill';
import type { SimChapter as Chapter } from '../../types/sim';
import { WritingSkillManagerDialog } from './WritingSkillManagerDialog';

export function WritingSkillSlots({ chapter }: { chapter: Chapter }) {
  const skills = useWritingSkillStore((s) => s.skills);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);

  const active = resolveWritingSkills(chapter.writingSkillIds, skills);

  const openManager = () => {
    setPickerOpen(false);
    setManagerOpen(true);
  };

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center gap-1" role="group" aria-label="本章写作技能槽位">
        {active.length === 0 ? (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex h-6 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[12px] transition hover:bg-[var(--rd-btn)]"
            style={{ color: 'var(--rd-sub)' }}
            title="写作技能：为本章正文附加可选的专项写作说明（管理技能库）"
            aria-label="写作技能：为本章正文附加可选的专项写作说明"
            data-writing-skills="empty"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span className="hidden md:inline">技能</span>
          </button>
        ) : (
          <>
            <div className="hidden min-w-0 items-center gap-1 md:flex">
              {active.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="max-w-[86px] truncate rounded-[8px] px-1.5 py-0.5 text-[11px] transition hover:opacity-80"
                  style={{ background: 'var(--rd-accent-soft)', color: 'var(--rd-accent)' }}
                  title={`写作技能：${s.name}（本章启用；点击调整）`}
                  data-skill-id={s.id}
                >
                  {s.name}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex h-6 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[11px] transition hover:bg-[var(--rd-btn)] md:hidden"
              style={{ background: 'var(--rd-accent-soft)', color: 'var(--rd-accent)' }}
              title="本章写作技能（点击调整）"
              aria-label={`本章写作技能 ${active.length}/${WRITING_SKILL_ACTIVE_MAX}`}
              data-writing-skills="compact"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {active.length}/{WRITING_SKILL_ACTIVE_MAX}
            </button>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] transition hover:bg-[var(--rd-btn)]"
              style={{ color: 'var(--rd-sub)' }}
              title="添加或调整本章写作技能"
              aria-label="添加或调整本章写作技能"
              data-writing-skills="add"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {pickerOpen && (
        <WritingSkillPicker
          chapter={chapter}
          onClose={() => setPickerOpen(false)}
          onManage={openManager}
        />
      )}
      {managerOpen && (
        <WritingSkillManagerDialog
          onClose={() => {
            setManagerOpen(false);
            // 从选择弹窗进入管理器：关闭后回到选择弹窗，方便把新建/编辑好的技能直接启用
            setPickerOpen(true);
          }}
        />
      )}
    </>
  );
}

function WritingSkillPicker({
  chapter,
  onClose,
  onManage,
}: {
  chapter: Chapter;
  onClose: () => void;
  onManage: () => void;
}) {
  const skills = useWritingSkillStore((s) => s.skills);
  const active = resolveWritingSkills(chapter.writingSkillIds, skills);
  const rawIds = sanitizeWritingSkillIds(chapter.writingSkillIds);
  const missing = Math.max(0, rawIds.length - active.length);
  const ids = active.map((s) => s.id);

  const write = (next: string[]) => useStudioStore.getState().setChapterWritingSkillIds(chapter.id, next);

  const toggle = (id: string) => {
    if (ids.includes(id)) {
      write(ids.filter((x) => x !== id));
      return;
    }
    if (ids.length >= WRITING_SKILL_ACTIVE_MAX) return;
    write([...ids, id]);
  };

  return (
    <Dialog
      width="sm"
      title="写作技能"
      subtitle={`仅用于本章正文生成；可选，最多同时启用 ${WRITING_SKILL_ACTIVE_MAX} 个。本章：${chapter.title || '未命名'}`}
      icon={<Sparkles />}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={onManage}>
            管理技能库
          </Button>
          <Button size="sm" variant="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      }
    >
      <div className="mb-1.5 flex items-center">
        <span className="text-[11px] text-slate-400">
          本章启用 {active.length}/{WRITING_SKILL_ACTIVE_MAX}
        </span>
        <span className="flex-1" />
        {active.length > 0 && (
          <button
            type="button"
            onClick={() => write([])}
            className="text-[11px] text-slate-400 transition hover:text-slate-600"
            title="清空本章启用的写作技能"
          >
            清空
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {Array.from({ length: WRITING_SKILL_ACTIVE_MAX }, (_, i) => {
          const s = active[i];
          return s ? (
            <div
              key={s.id}
              className="flex min-w-0 items-center gap-1 rounded-[8px] border border-brand-200 bg-brand-50/70 px-1.5 py-1"
              title={s.name}
              data-skill-slot={i}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-700">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-brand-700">{s.name}</span>
              <button
                type="button"
                onClick={() => write(ids.filter((x) => x !== s.id))}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-brand-500/70 transition hover:bg-brand-100 hover:text-brand-700"
                title={`移除技能「${s.name}」`}
                aria-label={`移除技能「${s.name}」`}
                data-skill-remove={s.id}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <div
              key={`empty-${i}`}
              className="flex items-center justify-center rounded-[8px] border border-dashed border-slate-200 py-1 text-[11px] text-slate-300"
            >
              空
            </div>
          );
        })}
      </div>

      {missing > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-600">
          本章有 {missing} 个已启用技能在技能库中不存在（可能已删除），生成时会忽略；新增/移除操作会清理旧引用。
        </p>
      )}

      <div className="mb-1 mt-3 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold tracking-[0.12em] text-slate-400">技能库</span>
        <span className="flex-1" />
        <span className="text-[11px] text-slate-400">点击启用 / 取消</span>
      </div>

      {skills.length ? (
        <div className="max-h-[300px] space-y-1 overflow-y-auto pr-0.5">
          {skills.map((s) => {
            const idx = ids.indexOf(s.id);
            const on = idx >= 0;
            const full = !on && ids.length >= WRITING_SKILL_ACTIVE_MAX;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => toggle(s.id)}
                disabled={full}
                aria-pressed={on}
                data-skill-option={s.id}
                title={
                  full
                    ? `最多启用 ${WRITING_SKILL_ACTIVE_MAX} 个，请先取消一个`
                    : s.description || s.content.slice(0, 80)
                }
                className={`flex w-full items-center gap-2 rounded-[10px] border px-2.5 py-2 text-left transition ${
                  on
                    ? 'border-brand-200 bg-brand-50/70'
                    : full
                      ? 'border-transparent opacity-45'
                      : 'border-transparent hover:bg-slate-50'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-slate-700">{s.name}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                    {s.description || s.content.slice(0, 50)}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{s.content.length} 字</span>
                {on && (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[10px] font-semibold text-white">
                    {idx + 1}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="rounded-[10px] border border-dashed border-slate-200 px-3 py-3">
          <p className="text-[12px] leading-relaxed text-slate-500">
            技能库还是空的。可以新建「花朵描写」这类专项说明，写清具体怎么描写，正文生成时按需参考。
          </p>
          <Button className="mt-2" size="sm" variant="soft" icon={<Plus />} onClick={onManage}>
            新建技能
          </Button>
        </div>
      )}
    </Dialog>
  );
}
