/** 编辑部弹层：管理作家编辑名单（增删改、启停、从预设补充、记忆查看/手改）。
 *  v2.21 作家编辑：所有编辑都拥有全部 8 项生成能力的执行权（不再按模块限权）；
 *  v2.22 专业=擅长题材的描述式文本（如「善于科幻题材」「善于描写爱情故事」），不限定可执行范围；
 *  每位编辑有 轻量主记忆（通用协作偏好）+ 各能力技能记忆（记忆文件副本：模板骨架+出厂基线+调教沉淀，
 *  创建编辑时整套复制，执行该能力任务时整份注入）——在编辑室单独对话中按【更新记忆】协议按小节归类沉淀
 *  （主/技能双通道，模型自路由归属），也在此面板手动查看/修改（调教聊天归属不对时的纠正入口）。
 *  作品责编不在这里配置——创作台顶栏「责编」选择（随作品存档）。 */
import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Brain, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  EDITOR_MODULES,
  EDITOR_MODULE_DESC,
  EDITOR_PRESETS,
  useEditorialStore,
  type EditorInput,
  type EditorModule,
} from '../../stores/editorialStore';
import { type EditorStorage, SKILL_MEMORY_CAP } from '../../engines/meetingEngine';
import { isUntunedMemory, templateCraftSections } from '../../engines/memoryTemplates';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Field, Input, Textarea } from '../ui/Field';
import { Segmented } from '../ui/Segmented';
import { Switch } from '../ui/Switch';
import { Badge } from '../ui/Badge';

type Form = { name: string; specialty: string; persona: string; storage: EditorStorage };
const EMPTY: Form = { name: '', specialty: '', persona: '', storage: 'local' };

const STORAGE_LABEL: Record<EditorStorage, string> = { local: '临时', server: '正式' };

/** 记忆面板：主记忆 + 各能力技能记忆（可查看/手改；调教聊天的【更新记忆】沉淀自动写到这里） */
function MemoryPanel({ editorId, onClose }: { editorId: string; onClose: () => void }) {
  const localEditors = useEditorialStore((s) => s.localEditors);
  const serverEditors = useEditorialStore((s) => s.serverEditors);
  const e = useMemo(
    () => [...localEditors, ...serverEditors].find((x) => x.id === editorId),
    [localEditors, serverEditors, editorId],
  );
  const [main, setMain] = useState(e?.memory ?? '');
  const [skills, setSkills] = useState<Partial<Record<EditorModule, string>>>(() => ({ ...(e?.skills ?? {}) }));
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  if (!e) return null;
  const saveAll = async () => {
    if (busy) return;
    setBusy(true);
    const clean: Partial<Record<EditorModule, string>> = {};
    for (const m of EDITOR_MODULES) {
      const t = (skills[m] ?? '').trim();
      if (t) clean[m] = t;
    }
    await useEditorialStore.getState().updateEditor(editorId, { memory: main.trim(), skills: clean });
    setBusy(false);
    setSaved('已保存');
  };

  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-[10px] border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-700">{e.name} 的记忆</span>
        <Button size="sm" onClick={onClose}>
          收起
        </Button>
      </div>
      <p className="text-[12px] leading-relaxed text-slate-500">
        <b>主记忆</b>=通用协作偏好，每次对话常驻注入（上限 1200 字）；<b>技能记忆</b>=该能力的记忆文件副本（模板骨架
        +出厂基线+调教沉淀，执行对应任务时整份注入，上限 {SKILL_MEMORY_CAP} 字/项）。编辑室单独对话中按【更新记忆】协议按小节归类沉淀到此；也可在此手动查看与修改。
      </p>
      <Field label="主记忆（通用协作偏好）" counter={`${main.length}/1200`}>
        <Textarea
          value={main}
          maxLength={1200}
          rows={4}
          onChange={(ev) => setMain(ev.target.value)}
          placeholder="暂无主记忆——在编辑室与这位编辑对话，其按【更新记忆】协议沉淀的通用偏好会出现在这里"
        />
      </Field>
      {EDITOR_MODULES.map((m) => {
        const val = skills[m] ?? '';
        const tuned = !isUntunedMemory(m, val);
        return (
          <details key={m} className="rounded-[10px] border border-slate-200 bg-white px-2.5 py-1.5" open={tuned}>
            <summary className="flex cursor-pointer items-center justify-between text-[12px] text-slate-500">
              <span title={EDITOR_MODULE_DESC[m]}>【{m}】技能记忆{!tuned && <span className="ml-1 text-slate-400">（出厂基线）</span>}</span>
              <span className={val.length > SKILL_MEMORY_CAP ? 'text-rose-500' : 'text-slate-400'}>{val.length ? `${val.length}/${SKILL_MEMORY_CAP}` : '空'}</span>
            </summary>
            <Textarea
              value={val}
              maxLength={SKILL_MEMORY_CAP}
              rows={4}
              onChange={(ev) => setSkills({ ...skills, [m]: ev.target.value })}
              placeholder={`暂无——调教「${m}」相关做法时按小节归类沉淀到这里（## 小节名 + 每条一行）`}
              className="mt-1.5"
            />
            {!!tuned && <p className="mt-1 text-[11px] leading-relaxed text-slate-400">沉淀小节：{templateCraftSections(m).join(' / ')}</p>}
          </details>
        );
      })}
      <div className="flex items-center justify-end gap-2">
        {saved && <span className="text-[12px] text-emerald-600">✓ {saved}</span>}
        <Button variant="primary" size="sm" onClick={() => void saveAll()} disabled={busy}>
          {busy ? '保存中…' : '保存记忆'}
        </Button>
      </div>
    </div>
  );
}

export function EditorialDeptDialog({ onClose }: { onClose: () => void }) {
  const localEditors = useEditorialStore((s) => s.localEditors);
  const serverEditors = useEditorialStore((s) => s.serverEditors);
  const serverError = useEditorialStore((s) => s.serverError);
  const editors = useMemo(() => [...localEditors, ...serverEditors], [localEditors, serverEditors]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [memEditing, setMemEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);

  // 打开弹层即刷新正式编辑：serverEditors 只在内存缓存，避免列表过期或进站拉取失败后看不到正式编辑
  useEffect(() => {
    void useEditorialStore.getState().loadServerEditors();
  }, []);

  const startNew = () => {
    setForm(EMPTY);
    setEditing('new');
    setMemEditing(null);
  };
  const startEdit = (id: string) => {
    const e = editors.find((x) => x.id === id);
    if (!e) return;
    setForm({ name: e.name, specialty: e.specialty, persona: e.persona, storage: e.storage });
    setEditing(id);
    setMemEditing(null);
  };
  const save = async () => {
    const name = form.name.trim();
    if (!name || busy) return;
    // 不带 memory/skills：职责编辑不触碰记忆（记忆在对话中自行沉淀，或经记忆面板手改）
    const payload = { name, specialty: form.specialty, persona: form.persona.trim() };
    const store = useEditorialStore.getState();
    setBusy(true);
    const ok =
      editing === 'new'
        ? await store.addEditor({ ...payload, storage: form.storage } as EditorInput)
        : editing
          ? await store.updateEditor(editing, payload)
          : true;
    setBusy(false);
    if (ok) setEditing(null);
  };
  const remove = async (id: string, name: string) => {
    if (!window.confirm(`删除编辑「${name}」？（会议草稿中的勾选也会移除）`)) return;
    const ok = await useEditorialStore.getState().removeEditor(id);
    if (ok && editing === id) setEditing(null);
    if (ok && memEditing === id) setMemEditing(null);
  };
  const addPresets = async () => {
    const have = new Set(editors.map((e) => e.name));
    setBusy(true);
    for (const p of EDITOR_PRESETS) if (!have.has(p.name)) await useEditorialStore.getState().addEditor({ ...p, storage: 'local' });
    setBusy(false);
  };

  return (
    <Dialog
      onClose={onClose}
      icon={<BookOpen />}
      title="编辑部"
      scroll="inner"
      subtitle={
        <>
          管理作家编辑：每位编辑都拥有全部 8 项生成能力的执行权（可在编辑室单独对话中直接执行任何生成任务），专业=其
          <b>擅长题材</b>的描述（如「善于科幻题材」，不限定可执行能力）。每位编辑有<b>主记忆</b>（通用协作偏好）+
          <b>各能力技能记忆</b>（技法，按能力分别沉淀），在编辑室对话中自动进化，也可在此查看/手改。编辑跨作品共用；临时编辑只存本浏览器，正式编辑存服务器、跨设备可用。当前作品的责编在创作台顶栏选择。
        </>
      }
      footer={
        <>
          <Button variant="soft" icon={<Plus />} onClick={startNew}>
            新增编辑
          </Button>
          <Button onClick={() => void addPresets()} disabled={busy} title="补充名称不重复的预设编辑（存为临时编辑）">
            从预设补充
          </Button>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      {serverError && <div className="mb-2 text-[12px] text-rose-600">{serverError}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {editors.length === 0 && (
          <div className="py-6 text-center text-[13px] text-slate-400">还没有编辑，新增或从预设补充。</div>
        )}
        <div className="flex flex-col gap-1.5">
          {editors.map((e) => {
            const skillCount = EDITOR_MODULES.filter((m) => !isUntunedMemory(m, (e.skills ?? {})[m])).length;
            return (
              <div
                key={e.id}
                className={`flex items-center gap-2 rounded-[10px] border px-2.5 py-2 ${
                  editing === e.id ? 'border-brand-200 bg-brand-50/50' : memEditing === e.id ? 'border-slate-300 bg-slate-50' : 'border-slate-200'
                }`}
              >
                <Switch
                  checked={e.enabled}
                  onChange={(v) => void useEditorialStore.getState().updateEditor(e.id, { enabled: v })}
                  title="启用后可被勾选参加会议"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`truncate text-[13px] font-semibold ${e.enabled ? 'text-slate-700' : 'text-slate-400'}`}>
                      {e.name}
                    </span>
                    <Badge tone={e.storage === 'server' ? 'brand' : 'neutral'}>{STORAGE_LABEL[e.storage]}</Badge>
                  </div>
                  <div className="flex items-center gap-1.5 text-[12px] text-slate-400">
                    <span className="truncate">{e.specialty || '未填写题材'}</span>
                    {(e.memory?.trim() || skillCount > 0) && (
                      <span className="flex shrink-0 items-center gap-0.5 text-emerald-600" title="已有沉淀记忆">
                        <Brain className="h-3 w-3" />
                        {e.memory?.trim() ? 1 : 0}+{skillCount}
                      </span>
                    )}
                  </div>
                </div>
                <IconButton
                  icon={<Brain />}
                  title="查看/手改该编辑的主记忆与各能力技能记忆"
                  onClick={() => {
                    setMemEditing(memEditing === e.id ? null : e.id);
                    setEditing(null);
                  }}
                />
                <IconButton icon={<Pencil />} title="编辑资料" onClick={() => startEdit(e.id)} />
                <IconButton icon={<Trash2 />} title="删除编辑" onClick={() => void remove(e.id, e.name)} />
              </div>
            );
          })}
        </div>

        {editing && (
          <div className="mt-3 flex flex-col gap-2.5 rounded-[10px] border border-brand-200 bg-brand-50/40 p-3">
            <div className="text-[13px] font-semibold text-brand-700">{editing === 'new' ? '新增编辑' : '编辑资料'}</div>
            {editing === 'new' && (
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-slate-500">保存位置</span>
                <Segmented
                  value={form.storage}
                  onChange={(v) => setForm({ ...form, storage: v })}
                  options={[
                    { value: 'local', label: '临时（仅本浏览器）' },
                    { value: 'server', label: '正式（存服务器）' },
                  ]}
                />
              </div>
            )}
            <Field label="名称" counter={`${form.name.length}/12`}>
              <Input
                value={form.name}
                maxLength={12}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如：人物性格编辑"
              />
            </Field>
            <Field label="擅长题材（描述式，不限定可执行能力）" counter={`${form.specialty.length}/40`}>
              <Input
                value={form.specialty}
                maxLength={40}
                onChange={(e) => setForm({ ...form, specialty: e.target.value })}
                placeholder="例：善于科幻题材 / 善于描写爱情故事 / 擅长历史权谋"
              />
            </Field>
            <Field label="审视维度与风格" counter={`${form.persona.length}/800`}>
              <Textarea
                value={form.persona}
                maxLength={800}
                rows={4}
                onChange={(e) => setForm({ ...form, persona: e.target.value })}
                placeholder="这位编辑关注什么、怎样说话、给出什么样的建议（保持简短）"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setEditing(null)}>
                取消
              </Button>
              <Button size="sm" variant="primary" onClick={() => void save()} disabled={!form.name.trim() || busy}>
                {busy ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
        )}

        {memEditing && <MemoryPanel editorId={memEditing} onClose={() => setMemEditing(null)} />}
      </div>
    </Dialog>
  );
}
