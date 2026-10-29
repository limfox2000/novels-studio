/** 🏷 推演定义库编辑器（最小可用版）：标签 / 反应 / 关系 / 时间 + JSON 导入导出。
 *
 *  **内核零内容**：这里不预置任何题材定义。新作品打开即空，作者自己定义。
 *  写动作全部走 store（upsertSchemaTag / upsertSchemaReaction / upsertSchemaRelationDef / setSimTime /
 *  replaceSimSchema），由 simSchema.inspectSimSchema 校验并级联清洗实例；编辑器只负责表单与提示。
 *  E2E 钩子：data-schema-*。 */
import { useMemo, useState } from 'react';
import { Plus, RefreshCw, Trash2, Upload, Download, AlertTriangle, Check } from 'lucide-react';
import { useStudioStore } from '../../stores/studioStore';
import {
  SIM_TAG_CAP,
  SIM_REACTION_CAP,
  SIM_RELATION_DEF_CAP,
  indexSimSchema,
  validateSimSchema,
} from '../../stores/simSchema';
import type {
  SimReactionDef,
  SimRelationDef,
  SimStanceKind,
  SimTagDef,
  SimTagRole,
  SimTagScope,
  SimTimePhase,
} from '../../types/sim';

const inputCls =
  'h-6 rounded-md border border-slate-200 bg-white px-1.5 text-[11.5px] text-slate-600 outline-none focus:border-brand-400';
const numCls = `${inputCls} w-14 tabular-nums`;
const selectCls = `${inputCls} pr-0.5`;
const smallBtn =
  'rounded-md border border-slate-200 px-1.5 py-0.5 text-[10.5px] text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40';

const SCOPES: SimTagScope[] = ['character', 'env'];
const ROLES: SimTagRole[] = ['trait', 'need', 'emotion', 'affordance', 'narrative'];
const ROLE_LABEL: Record<SimTagRole, string> = {
  trait: '人物标签',
  need: '需求',
  emotion: '情绪',
  affordance: '环境交互',
  narrative: '环境叙事',
};
const STANCE_LABEL: Record<SimStanceKind | 'none', string> = {
  none: '无立场',
  approach: '靠近',
  avoid: '避开',
  talk: '交谈',
};

const numOrUndef = (v: string): number | undefined => {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const strOrUndef = (v: string): string | undefined => (v.trim() ? v.trim() : undefined);

interface EditProps {
  onOpenWorld: () => void;
  schemaEmpty: boolean;
}

export function SimSchemaEditor({ onOpenWorld, schemaEmpty }: EditProps) {
  const schema = useStudioStore((s) => s.simSchema);
  const index = useMemo(() => indexSimSchema(schema), [schema]);
  const issues = useMemo(() => validateSimSchema(schema), [schema]);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonMsg, setJsonMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const exportJson = () => {
    const text = useStudioStore.getState().exportSimSchema();
    setJsonText(text);
    setJsonOpen(true);
    setJsonMsg({ ok: true, text: '已导出到下方文本框（可直接复制）。' });
  };

  const importJson = () => {
    const r = useStudioStore.getState().replaceSimSchema(jsonText);
    const parts = [
      r.ok ? '导入完成。' : '导入有错误：',
      ...r.errors,
      ...(r.warnings.length ? [`警告：${r.warnings.join('；')}`] : []),
      ...(r.dropped ? [`已丢弃 ${r.dropped} 条无效定义。`] : []),
    ];
    setJsonMsg({ ok: r.ok, text: parts.join(' ') });
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(jsonText);
      setJsonMsg({ ok: true, text: '已复制到剪贴板。' });
    } catch {
      setJsonMsg({ ok: false, text: '复制失败：请手动全选文本框内容。' });
    }
  };

  return (
    <div className="space-y-3" data-schema-editor>
      {/* 概览 */}
      <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[12.5px] font-semibold text-slate-700">作品定义库</h3>
          <span className="text-[11px] text-slate-400">
            标签 {schema.tags.length}/{SIM_TAG_CAP} · 反应 {schema.reactions.length}/{SIM_REACTION_CAP} · 关系定义{' '}
            {schema.relations.length}/{SIM_RELATION_DEF_CAP}
          </span>
          <span className="flex-1" />
          <button type="button" data-schema-export className={smallBtn} onClick={exportJson}>
            <Download className="mr-0.5 inline h-3 w-3" /> 导出 JSON
          </button>
          <button
            type="button"
            data-schema-import-open
            className={smallBtn}
            onClick={() => {
              setJsonOpen((v) => !v);
              setJsonMsg(null);
            }}
          >
            <Upload className="mr-0.5 inline h-3 w-3" /> 导入 JSON
          </button>
          <button
            type="button"
            data-schema-sync
            className={smallBtn}
            title="把定义库里新增的需求补进所有人物档案（只补缺，不覆盖）"
            onClick={() => {
              const n = useStudioStore.getState().syncSchemaToProfiles();
              setJsonMsg({ ok: true, text: n ? `已为人物档案补充 ${n} 个需求实例。` : '所有人物档案都已有这些需求。' });
            }}
          >
            <RefreshCw className="mr-0.5 inline h-3 w-3" /> 同步需求到档案
          </button>
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">
          引擎只会消费这里定义的东西。空定义库 = 人物只走动/张望；删除定义会级联清理人物/环境/关系上的引用。
        </p>
        {schemaEmpty && (
          <p className="mt-1.5 rounded-lg bg-brand-50 px-2 py-1.5 text-[11.5px] leading-relaxed text-brand-700" data-schema-empty>
            还没有任何定义。可以：① 在下面逐个新增标签；② 用「导入 JSON」粘贴一份完整定义库。
            定义完成后去「世界模型」给环境挂环境标签、去「人物档案」给人物挂人物标签。
            <button type="button" onClick={onOpenWorld} className="ml-1 font-medium underline">
              去世界模型 →
            </button>
          </p>
        )}
        {issues.length > 0 && (
          <div className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700" data-schema-issues>
            <div className="flex items-center gap-1 font-medium">
              <AlertTriangle className="h-3 w-3" /> 校验提示（{issues.length}）
            </div>
            <ul className="mt-0.5 list-inside list-disc">
              {issues.slice(0, 8).map((t, i) => (
                <li key={i}>{t}</li>
              ))}
              {issues.length > 8 && <li>…还有 {issues.length - 8} 条</li>}
            </ul>
          </div>
        )}
      </section>

      {/* JSON 弹层（内联） */}
      {jsonOpen && (
        <section className="rounded-xl border border-brand-200 bg-brand-50/30 p-3" data-schema-json-panel>
          <div className="flex items-center gap-2">
            <h3 className="text-[12.5px] font-semibold text-slate-700">定义库 JSON</h3>
            <span className="flex-1" />
            <button type="button" className={smallBtn} onClick={copyJson}>
              复制
            </button>
            <button type="button" data-schema-apply className={`${smallBtn} text-brand-700`} onClick={importJson}>
              应用导入
            </button>
            <button type="button" className={smallBtn} onClick={() => setJsonOpen(false)}>
              收起
            </button>
          </div>
          <textarea
            data-schema-json
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            spellCheck={false}
            placeholder='{"tags":[],"reactions":[],"relations":[]}'
            className="mt-1.5 h-40 w-full resize-y rounded-lg border border-slate-200 bg-white p-2 font-mono text-[11px] leading-relaxed text-slate-700 outline-none focus:border-brand-400"
          />
          {jsonMsg && (
            <p
              data-schema-result
              className={`mt-1 flex items-start gap-1 rounded-lg px-2 py-1 text-[11px] leading-relaxed ${
                jsonMsg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
              }`}
            >
              {jsonMsg.ok ? <Check className="mt-0.5 h-3 w-3 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />}
              <span>{jsonMsg.text}</span>
            </p>
          )}
        </section>
      )}

      <TagsSection />
      <ReactionsSection />
      <RelationDefsSection />
      <TimeSection />
    </div>
  );
}

// ── 标签 ──

interface TagDraft {
  id: string;
  name: string;
  icon: string;
  desc: string;
  scope: SimTagScope;
  role: SimTagRole;
  visibility: 'always' | 'near' | 'concealed';
  revokeWalk: boolean;
  fly: boolean;
  flyMult: string;
  needInitial: string;
  needGrowth: string;
  needThreshold: string;
  needEmergency: string;
  rNovelty: string;
  rObserve: string;
  rSocial: string;
  emoInitial: string;
  emoDecay: string;
  emoBreak: string;
  emoClear: string;
  emoStance: SimStanceKind | 'none';
  affNeedId: string;
  affRelief: string;
  affDuration: string;
  affUses: string;
  affPhases: string[];
  narrText: string;
}

function draftOf(def: SimTagDef): TagDraft {
  return {
    id: def.id,
    name: def.name,
    icon: def.icon ?? '',
    desc: def.desc ?? '',
    scope: def.scope,
    role: def.role,
    visibility: def.visibility ?? 'always',
    revokeWalk: !!def.revokes?.includes('move:walk'),
    fly: def.grantsMove?.mode === 'fly',
    flyMult: def.grantsMove ? String(def.grantsMove.speedMultiplier) : '1.5',
    needInitial: String(def.need?.initial ?? 0),
    needGrowth: String(def.need?.growth ?? 1),
    needThreshold: String(def.need?.threshold ?? 50),
    needEmergency: String(def.need?.emergency ?? 90),
    rNovelty: def.need?.relievers?.novelty !== undefined ? String(def.need.relievers.novelty) : '',
    rObserve: def.need?.relievers?.observe !== undefined ? String(def.need.relievers.observe) : '',
    rSocial: def.need?.relievers?.social !== undefined ? String(def.need.relievers.social) : '',
    emoInitial: String(def.emotion?.initial ?? 0),
    emoDecay: String(def.emotion?.decay ?? 1),
    emoBreak: String(def.emotion?.breakThreshold ?? 60),
    emoClear: String(def.emotion?.clearThreshold ?? 30),
    emoStance: def.emotion?.stance ?? 'none',
    affNeedId: def.affordance?.needId ?? '',
    affRelief: String(def.affordance?.relief ?? 40),
    affDuration: String(def.affordance?.duration ?? 2),
    affUses: def.affordance?.uses !== undefined ? String(def.affordance.uses) : '',
    affPhases: def.affordance?.activePhases ?? [],
    narrText: def.narrative?.discoverText ?? '',
  };
}

function buildTag(d: TagDraft): SimTagDef {
  const base: SimTagDef = {
    id: d.id.trim(),
    name: d.name.trim() || d.id.trim(),
    scope: d.scope,
    role: d.role,
    ...(strOrUndef(d.icon) ? { icon: d.icon.trim() } : {}),
    ...(strOrUndef(d.desc) ? { desc: d.desc.trim() } : {}),
  };
  if (d.role === 'trait') {
    base.visibility = d.visibility;
    const revokes = d.revokeWalk ? ['move:walk'] : [];
    if (revokes.length) base.revokes = revokes;
    if (d.fly) base.grantsMove = { mode: 'fly', speedMultiplier: Math.max(0.1, Number(d.flyMult) || 1) };
  } else if (d.role === 'need') {
    const relievers: Record<string, number> = {};
    for (const [k, v] of [
      ['novelty', d.rNovelty],
      ['observe', d.rObserve],
      ['social', d.rSocial],
    ] as const) {
      const n = numOrUndef(v);
      if (n !== undefined) relievers[k] = n;
    }
    base.need = {
      initial: Number(d.needInitial) || 0,
      growth: Number(d.needGrowth) || 0,
      threshold: Number(d.needThreshold) || 0,
      emergency: Number(d.needEmergency) || 0,
      ...(Object.keys(relievers).length ? { relievers } : {}),
    };
  } else if (d.role === 'emotion') {
    base.emotion = {
      initial: Number(d.emoInitial) || 0,
      decay: Number(d.emoDecay) || 0,
      breakThreshold: Number(d.emoBreak) || 0,
      clearThreshold: Number(d.emoClear) || 0,
      stance: d.emoStance,
    };
  } else if (d.role === 'affordance') {
    const uses = numOrUndef(d.affUses);
    base.affordance = {
      needId: d.affNeedId,
      relief: Number(d.affRelief) || 0,
      duration: Number(d.affDuration) || 1,
      ...(uses !== undefined ? { uses } : {}),
      ...(d.affPhases.length ? { activePhases: [...d.affPhases] } : {}),
    };
  } else if (d.role === 'narrative') {
    base.narrative = { ...(strOrUndef(d.narrText) ? { discoverText: d.narrText.trim() } : {}) };
  }
  return base;
}

function TagsSection() {
  const schema = useStudioStore((s) => s.simSchema);
  const index = useMemo(() => indexSimSchema(schema), [schema]);
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newScope, setNewScope] = useState<SimTagScope>('character');
  const [newRole, setNewRole] = useState<SimTagRole>('trait');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const add = () => {
    const id = newId.trim();
    if (!id) return setMsg({ ok: false, text: '需要先填 id（字母/数字/_ /:，不含空格）。' });
    if (schema.tags.some((t) => t.id === id)) return setMsg({ ok: false, text: `id「${id}」已存在，请换一个。` });
    const d: TagDraft = {
      ...draftOf({ id, name: newName.trim() || id, scope: newScope, role: newRole }),
      id,
      name: newName.trim() || id,
      scope: newScope,
      role: newRole,
    };
    const r = useStudioStore.getState().upsertSchemaTag(buildTag(d));
    setMsg(r.ok ? { ok: true, text: `已新增「${newName.trim() || id}」。` } : { ok: false, text: r.errors.join('；') });
    if (r.ok) {
      setNewId('');
      setNewName('');
      setAdding(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 p-3" data-schema-tags>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-slate-700">
          标签定义 <span className="font-normal text-slate-400">（人物标签 / 需求 / 情绪 / 环境交互 / 环境叙事）</span>
        </h3>
        <span className="flex-1" />
        <button type="button" data-schema-add-tag className={smallBtn} onClick={() => setAdding((v) => !v)}>
          <Plus className="mr-0.5 inline h-3 w-3" /> 新增标签
        </button>
      </div>

      {adding && (
        <div className="mt-2 flex flex-wrap items-end gap-1.5 rounded-lg bg-brand-50/40 p-2" data-schema-add-tag-form>
          <label className="text-[10.5px] text-slate-500">
            id
            <br />
            <input
              data-schema-new-id
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              placeholder="hunger"
              className={inputCls}
            />
          </label>
          <label className="text-[10.5px] text-slate-500">
            名称
            <br />
            <input
              data-schema-new-name
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="饥饿"
              className={inputCls}
            />
          </label>
          <label className="text-[10.5px] text-slate-500">
            载体
            <br />
            <select
              data-schema-new-scope
              value={newScope}
              onChange={(e) => {
                const scope = e.target.value as SimTagScope;
                setNewScope(scope);
                if (scope === 'env') setNewRole('affordance');
                else if (newRole === 'affordance' || newRole === 'narrative') setNewRole('trait');
              }}
              className={selectCls}
            >
              <option value="character">人物</option>
              <option value="env">环境</option>
            </select>
          </label>
          <label className="text-[10.5px] text-slate-500">
            角色
            <br />
            <select
              data-schema-new-role
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as SimTagRole)}
              className={selectCls}
            >
              {(newScope === 'env' ? (['affordance', 'narrative'] as SimTagRole[]) : (['trait', 'need', 'emotion'] as SimTagRole[])).map(
                (r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ),
              )}
            </select>
          </label>
          <button type="button" data-schema-new-save className={`${smallBtn} text-brand-700`} onClick={add}>
            添加
          </button>
        </div>
      )}
      {msg && (
        <p className={`mt-1 text-[11px] ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`} data-schema-tag-msg>
          {msg.text}
        </p>
      )}

      {schema.tags.length === 0 ? (
        <p className="mt-1.5 text-[11.5px] text-slate-400">还没有标签定义。</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {schema.tags.map((def) => (
            <TagRow key={def.id} def={def} index={index} />
          ))}
        </div>
      )}
    </section>
  );
}

function TagRow({ def, index }: { def: SimTagDef; index: ReturnType<typeof indexSimSchema> }) {
  const [d, setD] = useState<TagDraft>(() => draftOf(def));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof TagDraft>(k: K, v: TagDraft[K]) => setD((cur) => ({ ...cur, [k]: v }));
  const save = () => {
    const r = useStudioStore.getState().upsertSchemaTag(buildTag(d));
    setMsg(r.ok ? { ok: true, text: '已保存' } : { ok: false, text: r.errors.join('；') });
  };
  const remove = () => {
    if (!window.confirm(`删除标签「${def.name}」？人物/环境/关系上的该标签及引用它的反应会一并清理。`)) return;
    useStudioStore.getState().deleteSchemaTag(def.id);
  };
  const phaseOptions = index.time.phases;

  return (
    <div className="rounded-lg bg-slate-50/70 p-2" data-schema-tag-row={def.id}>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          data-schema-tag-icon
          value={d.icon}
          onChange={(e) => set('icon', e.target.value)}
          placeholder="图标"
          className={`${inputCls} w-10 text-center`}
        />
        <input
          data-schema-tag-name
          value={d.name}
          onChange={(e) => set('name', e.target.value)}
          className={`${inputCls} w-24`}
          title="显示名"
        />
        <span className="rounded bg-slate-200/60 px-1 py-0.5 font-mono text-[10px] text-slate-500" title="定义 id（引擎引用）">
          {def.id}
        </span>
        <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] text-slate-500 ring-1 ring-slate-200">
          {def.scope === 'env' ? '环境' : '人物'} · {ROLE_LABEL[def.role]}
        </span>
        <input
          data-schema-tag-desc
          value={d.desc}
          onChange={(e) => set('desc', e.target.value)}
          placeholder="说明（可选）"
          className={`${inputCls} min-w-0 flex-1`}
        />
        <button type="button" data-schema-tag-save className={smallBtn} onClick={save}>
          保存
        </button>
        <button type="button" data-schema-tag-delete className={`${smallBtn} text-rose-600`} onClick={remove} title="删除定义">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {msg && (
        <p className={`mt-0.5 text-[10.5px] ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`} data-schema-tag-row-msg>
          {msg.text}
        </p>
      )}

      {def.role === 'trait' && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-500">
          <label className="flex items-center gap-1">
            可见性
            <select
              data-schema-trait-visibility
              value={d.visibility}
              onChange={(e) => set('visibility', e.target.value as TagDraft['visibility'])}
              className={selectCls}
            >
              <option value="always">总是可见</option>
              <option value="near">靠近可见</option>
              <option value="concealed">隐藏（靠近/张望可见）</option>
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              data-schema-trait-revoke-walk
              checked={d.revokeWalk}
              onChange={(e) => set('revokeWalk', e.target.checked)}
              className="h-3 w-3 accent-brand-600"
            />
            撤销步行
          </label>
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              data-schema-trait-fly
              checked={d.fly}
              onChange={(e) => set('fly', e.target.checked)}
              className="h-3 w-3 accent-brand-600"
            />
            授予飞行 ×
            <input
              data-schema-trait-fly-mult
              value={d.flyMult}
              onChange={(e) => set('flyMult', e.target.value)}
              disabled={!d.fly}
              className={numCls}
            />
          </label>
        </div>
      )}

      {def.role === 'need' && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-500">
          {(
            [
              ['初值', 'needInitial'],
              ['增长/拍', 'needGrowth'],
              ['阈值', 'needThreshold'],
              ['紧急', 'needEmergency'],
            ] as const
          ).map(([label, key]) => (
            <label key={key} className="flex items-center gap-1">
              {label}
              <input
                data-schema-need={key}
                value={d[key]}
                onChange={(e) => set(key, e.target.value)}
                className={numCls}
              />
            </label>
          ))}
          <span className="mx-1 text-slate-300">|</span>
          {(
            [
              ['张望缓解', 'rObserve'],
              ['新鲜缓解', 'rNovelty'],
              ['社交缓解', 'rSocial'],
            ] as const
          ).map(([label, key]) => (
            <label key={key} className="flex items-center gap-1">
              {label}
              <input
                data-schema-reliever={key}
                value={d[key]}
                onChange={(e) => set(key, e.target.value)}
                placeholder="—"
                className={numCls}
              />
            </label>
          ))}
        </div>
      )}

      {def.role === 'emotion' && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-500">
          {(
            [
              ['初值', 'emoInitial'],
              ['衰减/拍', 'emoDecay'],
              ['崩溃阈值', 'emoBreak'],
              ['消退阈值', 'emoClear'],
            ] as const
          ).map(([label, key]) => (
            <label key={key} className="flex items-center gap-1">
              {label}
              <input
                data-schema-emotion={key}
                value={d[key]}
                onChange={(e) => set(key, e.target.value)}
                className={numCls}
              />
            </label>
          ))}
          <label className="flex items-center gap-1">
            默认立场
            <select
              data-schema-emotion-stance
              value={d.emoStance}
              onChange={(e) => set('emoStance', e.target.value as TagDraft['emoStance'])}
              className={selectCls}
            >
              {(['none', 'approach', 'avoid', 'talk'] as const).map((k) => (
                <option key={k} value={k}>
                  {STANCE_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {def.role === 'affordance' && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-500">
          <label className="flex items-center gap-1">
            满足需求
            <select
              data-schema-affordance-need
              value={d.affNeedId}
              onChange={(e) => set('affNeedId', e.target.value)}
              className={selectCls}
            >
              <option value="">（选择需求）</option>
              {index.needs.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
          {(
            [
              ['缓解', 'affRelief'],
              ['耗时', 'affDuration'],
              ['次数', 'affUses'],
            ] as const
          ).map(([label, key]) => (
            <label key={key} className="flex items-center gap-1">
              {label}
              <input
                data-schema-affordance={key}
                value={d[key]}
                onChange={(e) => set(key, e.target.value)}
                placeholder={key === 'affUses' ? '不限' : ''}
                className={numCls}
              />
            </label>
          ))}
          {phaseOptions.length > 1 && (
            <span className="flex flex-wrap items-center gap-1">
              可用时段
              {phaseOptions.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-0.5">
                  <input
                    type="checkbox"
                    data-schema-affordance-phase={p.id}
                    checked={d.affPhases.includes(p.id)}
                    onChange={(e) =>
                      set('affPhases', e.target.checked ? [...d.affPhases, p.id] : d.affPhases.filter((x) => x !== p.id))
                    }
                    className="h-3 w-3 accent-brand-600"
                  />
                  {p.name}
                </label>
              ))}
            </span>
          )}
        </div>
      )}

      {def.role === 'narrative' && (
        <div className="mt-1 flex items-center gap-1 text-[10.5px] text-slate-500">
          发现文案
          <input
            data-schema-narrative-text
            value={d.narrText}
            onChange={(e) => set('narrText', e.target.value)}
            placeholder="首次进入该环境时触发；可用 {env} 占位"
            className={`${inputCls} min-w-0 flex-1`}
          />
        </div>
      )}
    </div>
  );
}

// ── 反应 ──

function ReactionsSection() {
  const schema = useStudioStore((s) => s.simSchema);
  const index = useMemo(() => indexSimSchema(schema), [schema]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const add = () => {
    const n = schema.reactions.length + 1;
    const firstTrait = index.traits[0]?.id ?? '';
    if (!firstTrait) {
      setMsg({ ok: false, text: '先创建一个人物标签（trait），反应才有可观察的触发源。' });
      return;
    }
    const r = useStudioStore.getState().upsertSchemaReaction({
      id: `reaction_${n}`,
      triggerScope: 'actor',
      triggerTag: firstTrait,
      text: '注意到{target}的「{tag}」',
    });
    setMsg(r.ok ? { ok: true, text: '已新增反应规则。' } : { ok: false, text: r.errors.join('；') });
  };
  return (
    <section className="rounded-xl border border-slate-200 p-3" data-schema-reactions>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-slate-700">
          反应规则 <span className="font-normal text-slate-400">（观察到标签 → 情绪/需求变化 + 立场）</span>
        </h3>
        <span className="flex-1" />
        <button type="button" data-schema-add-reaction className={smallBtn} onClick={add}>
          <Plus className="mr-0.5 inline h-3 w-3" /> 新增反应
        </button>
      </div>
      {msg && <p className={`mt-1 text-[11px] ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`}>{msg.text}</p>}
      {schema.reactions.length === 0 ? (
        <p className="mt-1.5 text-[11.5px] text-slate-400">还没有反应规则。没有反应的标签只会被感知/记忆，不会改变人物状态。</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {schema.reactions.map((def) => (
            <ReactionRow key={def.id} def={def} index={index} />
          ))}
        </div>
      )}
    </section>
  );
}

function ReactionRow({ def, index }: { def: SimReactionDef; index: ReturnType<typeof indexSimSchema> }) {
  const [d, setD] = useState(() => ({
    triggerScope: def.triggerScope,
    triggerTag: def.triggerTag,
    selfTag: def.selfTag ?? '',
    emotionId: def.emotion?.defId ?? '',
    emotionDelta: def.emotion ? String(def.emotion.delta) : '',
    needId: def.need?.defId ?? '',
    needDelta: def.need ? String(def.need.delta) : '',
    stanceKind: def.stance?.kind ?? ('none' as SimStanceKind | 'none'),
    stanceEmotion: def.stance?.emotionRef ?? '',
    text: def.text ?? '',
    cooldown: def.cooldown !== undefined ? String(def.cooldown) : '',
    priority: def.priority !== undefined ? String(def.priority) : '',
  }));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((cur) => ({ ...cur, [k]: v }));
  const save = () => {
    const emotionDelta = numOrUndef(d.emotionDelta);
    const needDelta = numOrUndef(d.needDelta);
    const cooldown = numOrUndef(d.cooldown);
    const priority = numOrUndef(d.priority);
    const next: SimReactionDef = {
      id: def.id,
      triggerScope: d.triggerScope,
      triggerTag: d.triggerTag,
      ...(d.selfTag ? { selfTag: d.selfTag } : {}),
      ...(d.emotionId && emotionDelta !== undefined ? { emotion: { defId: d.emotionId, delta: emotionDelta } } : {}),
      ...(d.needId && needDelta !== undefined ? { need: { defId: d.needId, delta: needDelta } } : {}),
      ...(d.triggerScope === 'actor' && d.stanceKind !== 'none'
        ? { stance: { kind: d.stanceKind, ...(d.stanceEmotion ? { emotionRef: d.stanceEmotion } : {}) } }
        : {}),
      ...(strOrUndef(d.text) ? { text: d.text.trim() } : {}),
      ...(cooldown !== undefined ? { cooldown } : {}),
      ...(priority !== undefined ? { priority } : {}),
    };
    const r = useStudioStore.getState().upsertSchemaReaction(next);
    setMsg(r.ok ? { ok: true, text: '已保存' } : { ok: false, text: r.errors.join('；') });
  };
  const remove = () => {
    if (!window.confirm(`删除反应规则「${def.id}」？`)) return;
    useStudioStore.getState().deleteSchemaReaction(def.id);
  };
  const triggerOptions = d.triggerScope === 'env' ? index.envTags : [...index.traits, ...index.emotions];
  return (
    <div className="rounded-lg bg-slate-50/70 p-2" data-schema-reaction-row={def.id}>
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-500">
        <span className="font-mono text-[10px] text-slate-400">{def.id}</span>
        <select
          data-schema-reaction-scope
          value={d.triggerScope}
          onChange={(e) => {
            const scope = e.target.value as 'actor' | 'env';
            set('triggerScope', scope);
            set('triggerTag', '');
            if (scope === 'env') {
              set('stanceKind', 'none');
              set('selfTag', '');
            }
          }}
          className={selectCls}
        >
          <option value="actor">看到人物</option>
          <option value="env">看到环境</option>
        </select>
        <select
          data-schema-reaction-trigger
          value={d.triggerTag}
          onChange={(e) => set('triggerTag', e.target.value)}
          className={selectCls}
        >
          <option value="">（触发标签）</option>
          {triggerOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {d.triggerScope === 'actor' && (
          <label className="flex items-center gap-1">
            自身需有
            <select data-schema-reaction-self value={d.selfTag} onChange={(e) => set('selfTag', e.target.value)} className={selectCls}>
              <option value="">（不限）</option>
              {index.traits.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-500">
        <label className="flex items-center gap-1">
          情绪
          <select data-schema-reaction-emotion value={d.emotionId} onChange={(e) => set('emotionId', e.target.value)} className={selectCls}>
            <option value="">（无）</option>
            {index.emotions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Δ
          <input
            data-schema-reaction-emotion-delta
            value={d.emotionDelta}
            onChange={(e) => set('emotionDelta', e.target.value)}
            placeholder="+20"
            className={numCls}
          />
        </label>
        <span className="text-slate-300">|</span>
        <label className="flex items-center gap-1">
          需求
          <select data-schema-reaction-need value={d.needId} onChange={(e) => set('needId', e.target.value)} className={selectCls}>
            <option value="">（无）</option>
            {index.needs.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Δ
          <input
            data-schema-reaction-need-delta
            value={d.needDelta}
            onChange={(e) => set('needDelta', e.target.value)}
            placeholder="+10"
            className={numCls}
          />
        </label>
        {d.triggerScope === 'actor' && (
          <>
            <span className="text-slate-300">|</span>
            <label className="flex items-center gap-1">
              立场
              <select
                data-schema-reaction-stance
                value={d.stanceKind}
                onChange={(e) => set('stanceKind', e.target.value as typeof d.stanceKind)}
                className={selectCls}
              >
                {(['none', 'approach', 'avoid', 'talk'] as const).map((k) => (
                  <option key={k} value={k}>
                    {STANCE_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              由情绪门控
              <select
                data-schema-reaction-stance-emotion
                value={d.stanceEmotion}
                onChange={(e) => set('stanceEmotion', e.target.value)}
                className={selectCls}
              >
                <option value="">（不需要）</option>
                {index.emotions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="flex items-center gap-1">
          冷却
          <input
            data-schema-reaction-cooldown
            value={d.cooldown}
            onChange={(e) => set('cooldown', e.target.value)}
            placeholder="拍"
            className={numCls}
          />
        </label>
        <label className="flex items-center gap-1">
          优先级
          <input
            data-schema-reaction-priority
            value={d.priority}
            onChange={(e) => set('priority', e.target.value)}
            placeholder="0"
            className={numCls}
          />
        </label>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <input
          data-schema-reaction-text
          value={d.text}
          onChange={(e) => set('text', e.target.value)}
          placeholder="事件文案（可用 {target} / {env} / {tag}）"
          className={`${inputCls} min-w-0 flex-1`}
        />
        <button type="button" data-schema-reaction-save className={smallBtn} onClick={save}>
          保存
        </button>
        <button type="button" data-schema-reaction-delete className={`${smallBtn} text-rose-600`} onClick={remove}>
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {msg && (
        <p className={`mt-0.5 text-[10.5px] ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`} data-schema-reaction-msg>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ── 关系定义 ──

function RelationDefsSection() {
  const schema = useStudioStore((s) => s.simSchema);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const add = () => {
    const n = schema.relations.length + 1;
    const r = useStudioStore.getState().upsertSchemaRelationDef({
      id: `relation_${n}`,
      name: `关系${n}`,
      stance: 'talk',
      minValue: 0,
      maxValue: 100,
    });
    setMsg(r.ok ? { ok: true, text: '已新增关系定义。' } : { ok: false, text: r.errors.join('；') });
  };
  return (
    <section className="rounded-xl border border-slate-200 p-3" data-schema-relations>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-slate-700">
          关系定义 <span className="font-normal text-slate-400">（人物→人物；立场与好感门槛）</span>
        </h3>
        <span className="flex-1" />
        <button type="button" data-schema-add-relation className={smallBtn} onClick={add}>
          <Plus className="mr-0.5 inline h-3 w-3" /> 新增关系
        </button>
      </div>
      {msg && <p className={`mt-1 text-[11px] ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`}>{msg.text}</p>}
      {schema.relations.length === 0 ? (
        <p className="mt-1.5 text-[11.5px] text-slate-400">还没有关系定义。人物档案里的关系标签从这里来。</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {schema.relations.map((def) => (
            <RelationDefRow key={def.id} def={def} />
          ))}
        </div>
      )}
    </section>
  );
}

function RelationDefRow({ def }: { def: SimRelationDef }) {
  const [d, setD] = useState(() => ({
    name: def.name,
    icon: def.icon ?? '',
    desc: def.desc ?? '',
    stance: def.stance,
    priority: def.priority !== undefined ? String(def.priority) : '',
    minValue: def.minValue !== undefined ? String(def.minValue) : '',
    maxValue: def.maxValue !== undefined ? String(def.maxValue) : '',
    talkDuration: def.talkDuration !== undefined ? String(def.talkDuration) : '',
    talkDistance: def.talkDistance !== undefined ? String(def.talkDistance) : '',
  }));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((cur) => ({ ...cur, [k]: v }));
  const save = () => {
    const next: SimRelationDef = {
      id: def.id,
      name: d.name.trim() || def.id,
      stance: d.stance,
      ...(strOrUndef(d.icon) ? { icon: d.icon.trim() } : {}),
      ...(strOrUndef(d.desc) ? { desc: d.desc.trim() } : {}),
      ...(numOrUndef(d.priority) !== undefined ? { priority: numOrUndef(d.priority) } : {}),
      ...(numOrUndef(d.minValue) !== undefined ? { minValue: numOrUndef(d.minValue) } : {}),
      ...(numOrUndef(d.maxValue) !== undefined ? { maxValue: numOrUndef(d.maxValue) } : {}),
      ...(numOrUndef(d.talkDuration) !== undefined ? { talkDuration: numOrUndef(d.talkDuration) } : {}),
      ...(numOrUndef(d.talkDistance) !== undefined ? { talkDistance: numOrUndef(d.talkDistance) } : {}),
    };
    const r = useStudioStore.getState().upsertSchemaRelationDef(next);
    setMsg(r.ok ? { ok: true, text: '已保存' } : { ok: false, text: r.errors.join('；') });
  };
  const remove = () => {
    if (!window.confirm(`删除关系定义「${def.name}」？人物关系上的该标签会一并清理。`)) return;
    useStudioStore.getState().deleteSchemaRelationDef(def.id);
  };
  return (
    <div className="rounded-lg bg-slate-50/70 p-2" data-schema-relation-row={def.id}>
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-500">
        <span className="font-mono text-[10px] text-slate-400">{def.id}</span>
        <input data-schema-relation-icon value={d.icon} onChange={(e) => set('icon', e.target.value)} className={`${inputCls} w-9 text-center`} placeholder="图标" />
        <input data-schema-relation-name value={d.name} onChange={(e) => set('name', e.target.value)} className={`${inputCls} w-24`} />
        <select data-schema-relation-stance value={d.stance} onChange={(e) => set('stance', e.target.value as typeof d.stance)} className={selectCls}>
          {(['none', 'approach', 'avoid', 'talk'] as const).map((k) => (
            <option key={k} value={k}>
              {STANCE_LABEL[k]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          好感 ≥
          <input data-schema-relation-min value={d.minValue} onChange={(e) => set('minValue', e.target.value)} placeholder="0" className={numCls} />
        </label>
        <label className="flex items-center gap-1">
          ≤
          <input data-schema-relation-max value={d.maxValue} onChange={(e) => set('maxValue', e.target.value)} placeholder="100" className={numCls} />
        </label>
        <label className="flex items-center gap-1">
          交谈耗时
          <input data-schema-relation-talk-duration value={d.talkDuration} onChange={(e) => set('talkDuration', e.target.value)} placeholder="2" className={numCls} />
        </label>
        <label className="flex items-center gap-1">
          交谈距离
          <input data-schema-relation-talk-distance value={d.talkDistance} onChange={(e) => set('talkDistance', e.target.value)} placeholder="110" className={numCls} />
        </label>
        <label className="flex items-center gap-1">
          优先级
          <input data-schema-relation-priority value={d.priority} onChange={(e) => set('priority', e.target.value)} placeholder="0" className={numCls} />
        </label>
        <button type="button" data-schema-relation-save className={smallBtn} onClick={save}>
          保存
        </button>
        <button type="button" data-schema-relation-delete className={`${smallBtn} text-rose-600`} onClick={remove}>
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          data-schema-relation-desc
          value={d.desc}
          onChange={(e) => set('desc', e.target.value)}
          placeholder="说明（可选）"
          className={`${inputCls} min-w-0 flex-1`}
        />
      </div>
      {msg && (
        <p className={`mt-0.5 text-[10.5px] ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`} data-schema-relation-msg>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ── 时间 ──

function TimeSection() {
  const schema = useStudioStore((s) => s.simSchema);
  const index = useMemo(() => indexSimSchema(schema), [schema]);
  const [ticksPerDay, setTicksPerDay] = useState(() => String(index.time.ticksPerDay));
  const [phases, setPhases] = useState<SimTimePhase[]>(() => index.time.phases.map((p) => ({ ...p })));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const setPhase = (i: number, patch: Partial<SimTimePhase>) =>
    setPhases((cur) => cur.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const save = () => {
    const ticks = Math.max(1, Math.round(Number(ticksPerDay) || 0));
    if (phases.length === 0) {
      useStudioStore.getState().setSimTime(undefined);
      setMsg({ ok: true, text: '已恢复单相「全天」。' });
      return;
    }
    const clean = phases
      .filter((p) => p.id.trim() && p.name.trim())
      .map((p) => ({
        id: p.id.trim(),
        name: p.name.trim(),
        from: Math.min(0.99, Math.max(0, Number(p.from) || 0)),
        to: Math.min(1, Math.max(0.01, Number(p.to) || 0)),
      }));
    useStudioStore.getState().setSimTime({ ticksPerDay: ticks, phases: clean });
    setMsg({ ok: true, text: '已保存时间维度（下次开始推演生效）。' });
  };
  const reset = () => {
    useStudioStore.getState().setSimTime(undefined);
    setTicksPerDay('120');
    setPhases([{ id: 'always', name: '全天', from: 0, to: 1 }]);
    setMsg({ ok: true, text: '已恢复单相「全天」。' });
  };
  return (
    <section className="rounded-xl border border-slate-200 p-3" data-schema-time>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-slate-700">
          时间维度 <span className="font-normal text-slate-400">（一天多少拍 + 相位；环境交互可按相位门控）</span>
        </h3>
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-[10.5px] text-slate-500">
          一天
          <input
            data-schema-ticks-per-day
            value={ticksPerDay}
            onChange={(e) => setTicksPerDay(e.target.value)}
            className={numCls}
          />
          拍
        </label>
        <button type="button" data-schema-time-add className={smallBtn} onClick={() => setPhases((cur) => [...cur, { id: `phase_${cur.length + 1}`, name: `时段${cur.length + 1}`, from: 0, to: 1 }])}>
          <Plus className="mr-0.5 inline h-3 w-3" /> 新增相位
        </button>
        <button type="button" data-schema-time-save className={`${smallBtn} text-brand-700`} onClick={save}>
          保存
        </button>
        <button type="button" data-schema-time-reset className={smallBtn} onClick={reset}>
          恢复全天
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        from / to 用 0-1 的当天进度表示（半开区间 [from, to)）；缺省单相「全天」不引入任何题材。
      </p>
      {phases.length === 0 ? (
        <p className="mt-1.5 text-[11.5px] text-slate-400">当前为单相「全天」。</p>
      ) : (
        <div className="mt-2 space-y-1">
          {phases.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-50/70 p-2 text-[10.5px] text-slate-500" data-schema-phase-row={p.id}>
              <input data-schema-phase-id value={p.id} onChange={(e) => setPhase(i, { id: e.target.value })} className={`${inputCls} w-20 font-mono`} />
              <input data-schema-phase-name value={p.name} onChange={(e) => setPhase(i, { name: e.target.value })} className={`${inputCls} w-20`} />
              <label className="flex items-center gap-1">
                从
                <input data-schema-phase-from value={p.from} onChange={(e) => setPhase(i, { from: Number(e.target.value) })} className={numCls} />
              </label>
              <label className="flex items-center gap-1">
                到
                <input data-schema-phase-to value={p.to} onChange={(e) => setPhase(i, { to: Number(e.target.value) })} className={numCls} />
              </label>
              <button
                type="button"
                data-schema-phase-delete
                className={`${smallBtn} text-rose-600`}
                onClick={() => setPhases((cur) => cur.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {msg && (
        <p className={`mt-1 text-[10.5px] ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`} data-schema-time-msg>
          {msg.text}
        </p>
      )}
    </section>
  );
}
