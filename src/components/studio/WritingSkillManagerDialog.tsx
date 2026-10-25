/** ✨ 写作技能库管理器：新建/编辑/删除可复用的正文写作说明。
 *  技能库全局保存在本机（nc2-writing-skills-v1）；作品章节只记录启用了哪些技能 ID。
 *  删除正被当前作品启用的技能时，会同时清掉各章节的引用（当前作品在内存里，其它存档载入时忽略旧 ID）。 */
import { useState } from 'react';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Field, Input, Textarea } from '../ui/Field';
import { useWritingSkillStore } from '../../stores/writingSkillStore';
import { useStudioStore } from '../../stores/studioStore';
import {
  WRITING_SKILL_CONTENT_MAX,
  WRITING_SKILL_DESC_MAX,
  WRITING_SKILL_LIBRARY_MAX,
  WRITING_SKILL_NAME_MAX,
  type WritingSkill,
} from '../../types/writingSkill';

type Form = { name: string; description: string; content: string };
const EMPTY: Form = { name: '', description: '', content: '' };

const CONTENT_PLACEHOLDER =
  '写花时先写颜色与形态，再写气味、触感与风中的姿态，最后让花的意象映照人物情绪；避免连续堆砌形容词。\n\n把可操作的写法写清楚，不要写剧情。';

function formOf(s: WritingSkill): Form {
  return { name: s.name, description: s.description, content: s.content };
}

export function WritingSkillManagerDialog({ onClose }: { onClose: () => void }) {
  const skills = useWritingSkillStore((s) => s.skills);
  const [selectedId, setSelectedId] = useState<string | null>(() => skills[0]?.id ?? null);
  const [creating, setCreating] = useState(() => skills.length === 0);
  const [form, setForm] = useState<Form>(() => (skills[0] ? formOf(skills[0]) : EMPTY));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const selected = selectedId ? skills.find((s) => s.id === selectedId) : undefined;
  const dirty = selected
    ? form.name !== selected.name || form.description !== selected.description || form.content !== selected.content
    : creating && !!(form.name.trim() || form.description.trim() || form.content.trim());
  const canSave = dirty && !!form.name.trim() && !!form.content.trim();

  const discardGuard = () =>
    !dirty || window.confirm('当前技能有未保存的修改，放弃这些修改？');

  const close = () => {
    if (discardGuard()) onClose();
  };

  const selectSkill = (id: string) => {
    if (id === selectedId && !creating) return;
    if (!discardGuard()) return;
    const s = useWritingSkillStore.getState().skills.find((x) => x.id === id);
    if (!s) return;
    setSelectedId(id);
    setCreating(false);
    setForm(formOf(s));
    setError('');
    setSaved('');
  };

  const startNew = () => {
    if (!discardGuard()) return;
    setSelectedId(null);
    setCreating(true);
    setForm(EMPTY);
    setError('');
    setSaved('');
  };

  const save = () => {
    if (!canSave) return;
    setError('');
    setSaved('');
    if (creating) {
      const r = useWritingSkillStore.getState().createSkill(form);
      if (!r.ok) return setError(r.error);
      const next = useWritingSkillStore.getState().skills.find((s) => s.id === r.id);
      setSelectedId(r.id);
      setCreating(false);
      if (next) setForm(formOf(next));
    } else {
      if (!selected) return setError('技能不存在（可能已在其它页面删除）');
      const r = useWritingSkillStore.getState().updateSkill(selected.id, form);
      if (!r.ok) return setError(r.error);
      const next = useWritingSkillStore.getState().skills.find((s) => s.id === selected.id);
      if (next) setForm(formOf(next));
    }
    setSaved('已保存');
  };

  const remove = (skill: WritingSkill) => {
    const refs = useStudioStore.getState().chapters.filter((c) => c.writingSkillIds?.includes(skill.id)).length;
    const tip = refs
      ? `删除技能「${skill.name}」？当前作品有 ${refs} 章正在启用，会同时从这些章节移除。`
      : `删除技能「${skill.name}」？不可恢复。`;
    if (!window.confirm(tip)) return;
    const wasSelected = selectedId === skill.id;
    useStudioStore.getState().removeWritingSkillReferences(skill.id);
    useWritingSkillStore.getState().deleteSkill(skill.id);
    setError('');
    setSaved('');
    if (wasSelected) {
      const next = useWritingSkillStore.getState().skills[0];
      setSelectedId(next?.id ?? null);
      setCreating(!next);
      setForm(next ? formOf(next) : EMPTY);
    }
  };

  return (
    <Dialog
      width="lg"
      title="写作技能库"
      subtitle="可复用的专项写作说明：只在章节正文生成时注入，不用于大纲/人物/环境生成。技能库保存在本机浏览器，作品存档只记录启用了哪些技能。"
      icon={<Sparkles />}
      onClose={close}
      footer={
        <>
          {saved && <span className="mr-1 text-[12px] text-emerald-600">✓ {saved}</span>}
          <Button size="sm" onClick={close}>
            关闭
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!canSave}>
            保存技能
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[12px] text-slate-500">
          {skills.length}/{WRITING_SKILL_LIBRARY_MAX} 个技能
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="soft" icon={<Plus />} onClick={startNew} data-skill-new>
          新建技能
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="w-full shrink-0 sm:w-[190px]">
          <div className="max-h-[190px] space-y-1 overflow-y-auto sm:max-h-[380px]">
            {skills.map((s) => {
              const on = !creating && selectedId === s.id;
              return (
                <div
                  key={s.id}
                  className={`flex items-center gap-0.5 rounded-[10px] border px-1 py-0.5 transition ${
                    on ? 'border-brand-200 bg-brand-50/70' : 'border-transparent hover:bg-slate-50'
                  }`}
                >
                  <button
                    onClick={() => selectSkill(s.id)}
                    data-skill-row={s.id}
                    className="min-w-0 flex-1 rounded-[8px] px-1.5 py-1 text-left"
                    title={s.description || s.content.slice(0, 80)}
                    aria-pressed={on}
                  >
                    <span className={`block truncate text-[12.5px] font-medium ${on ? 'text-brand-700' : 'text-slate-700'}`}>
                      {s.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                      {s.description || `${s.content.length} 字`}
                    </span>
                  </button>
                  <IconButton
                    icon={<Trash2 />}
                    title={`删除技能「${s.name}」`}
                    onClick={() => remove(s)}
                    className="h-6 w-6 text-slate-400 hover:text-rose-500"
                  />
                </div>
              );
            })}
            {!skills.length && (
              <p className="rounded-[10px] border border-dashed border-slate-200 px-2.5 py-3 text-[12px] leading-relaxed text-slate-400">
                还没有技能。新建一个，比如「花朵描写」。
              </p>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-2.5">
          <Field label="技能名称" counter={`${form.name.length}/${WRITING_SKILL_NAME_MAX}`}>
            <Input
              value={form.name}
              maxLength={WRITING_SKILL_NAME_MAX}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                setSaved('');
              }}
              placeholder="如：花朵描写"
            />
          </Field>
          <Field
            label="适用场景（可选）"
            counter={`${form.description.length}/${WRITING_SKILL_DESC_MAX}`}
            hint="帮助 AI 判断何时参考；不相关时它会忽略。"
          >
            <Input
              value={form.description}
              maxLength={WRITING_SKILL_DESC_MAX}
              onChange={(e) => {
                setForm({ ...form, description: e.target.value });
                setSaved('');
              }}
              placeholder="如：花朵、庭院、植物意象等"
            />
          </Field>
          <Field
            label="写作说明"
            counter={`${form.content.length}/${WRITING_SKILL_CONTENT_MAX}`}
            hint="这段说明会原样注入本章正文的 system prompt；写具体、可操作的写法，不写剧情。"
          >
            <Textarea
              value={form.content}
              maxLength={WRITING_SKILL_CONTENT_MAX}
              rows={9}
              onChange={(e) => {
                setForm({ ...form, content: e.target.value });
                setSaved('');
              }}
              placeholder={CONTENT_PLACEHOLDER}
            />
          </Field>
          {error && (
            <p className="rounded-[8px] border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12px] leading-relaxed text-rose-600">
              {error}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
