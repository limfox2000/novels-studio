/** 🎬 推演面板（设计文档 §12.2 / §19.12）：
 * 「世界模型」= 舞台现状 + 时钟 + 通道（门/路径）+ 环境标签 + 引擎接入状态；
 * 「人物档案」= 基础能力 + 标签 + 需求 + 情绪 + 有向关系（全部读作品级定义库）；
 * 「设计」= 作品级定义库编辑器（标签/需求/情绪/交互/叙事/反应/关系/时间）。
 *
 *  **内核零内容**：面板里不出现任何内置题材标签——schema 为空时只给空态引导。
 *  推演档案与人物档案物理分离（姓名/状态/形象仍在人物库）；修改在**下次开始推演**生效。 */
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Film, X } from 'lucide-react';
import { useStudioStore } from '../../stores/studioStore';
import { STAGE_BOARD_ID } from '../../stores/boardOps';
import { useSimSessionStore } from '../../stores/simSessionStore';
import {
  SIM_CAPABILITY_DEFAULTS,
  SIM_CAPABILITY_RANGES,
  SIM_OBSERVE_BASE,
  observeTicks,
} from '../../stores/simProfiles';
import { SIM_BEHAVIOR_LABELS, resolveSimMovement } from '../../engines/simRunner';
import { indexSimSchema, relationTagsOf, relationValueOf, traitIdsOf } from '../../stores/simSchema';
import { buildSimWorld } from '../../engines/simWorld';
import { SimSchemaEditor } from './SimSchemaEditor';
import type { SimCapabilities } from '../../types/sim';

type TabKey = 'world' | 'profiles' | 'design';

const CAP_LABEL: Record<keyof SimCapabilities, { name: string; hint: string }> = {
  speed: { name: '速度', hint: '每拍移动的最大像素；跑得快=同样的故事时间走得更远' },
  perception: { name: '感知范围', hint: 'px：决定能看到谁/多远的环境；也是靠近发现隐藏标签的半径' },
  observation: { name: '观察力', hint: '张望耗时 = 基准 / (0.5 + 观察力/100)，越高越快；张望会主动发现隐藏标签' },
};

/** 通用滑杆行（值 + 范围 + 单位），dataKey 供 E2E 定位 */
function SlideRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  dataKey,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  dataKey: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className={`block ${disabled ? 'opacity-40' : ''}`} title={hint}>
      <span className="flex items-baseline justify-between gap-2 text-[11.5px]">
        <span className="text-slate-500">{label}</span>
        <span className="tabular-nums font-medium text-slate-700">
          {value}
          {unit ? ` ${unit}` : ''}
        </span>
      </span>
      <input
        type="range"
        data-sim-field={dataKey}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-0.5 h-1.5 w-full cursor-pointer accent-brand-600"
      />
    </label>
  );
}

const tagLabel = (def: { icon?: string; name: string }) => `${def.icon ? `${def.icon} ` : ''}${def.name}`;

export function SimPlayPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>('world');
  const characters = useStudioStore((s) => s.characters);
  const simProfiles = useStudioStore((s) => s.simProfiles);
  const relations = useStudioStore((s) => s.relations);
  const boards = useStudioStore((s) => s.boards);
  const schema = useStudioStore((s) => s.simSchema);
  const session = useSimSessionStore((s) => s.session);
  const index = useMemo(() => indexSimSchema(schema), [schema]);
  const stageBoard = boards[STAGE_BOARD_ID];
  const stageChars = useMemo(
    () =>
      (stageBoard?.nodes ?? [])
        .filter((n) => n.data.kind === 'character')
        .map((n) => (n.data.kind === 'character' ? n.data.characterId : ''))
        .filter(Boolean),
    [stageBoard],
  );
  const stageEnvs = useMemo(
    () => (stageBoard?.nodes ?? []).filter((n) => n.data.kind === 'environment'),
    [stageBoard],
  );
  const world = useMemo(() => (stageBoard ? buildSimWorld(stageBoard) : { envs: [], portals: [], mode: 'degraded' as const }), [stageBoard]);
  const library = useMemo(() => Object.values(characters), [characters]);
  const [selectedId, setSelectedId] = useState<string>(stageChars[0] ?? library[0]?.id ?? '');
  const selected = characters[selectedId];
  const profile = selected ? simProfiles[selected.id] : undefined;
  const actor = session?.actors.find((a) => a.characterId === selectedId);

  const capsRange = Object.values(simProfiles);
  const rangeOf = (key: keyof SimCapabilities) => {
    if (!capsRange.length) return `${SIM_CAPABILITY_DEFAULTS[key]}`;
    const vals = capsRange.map((p) => p.capabilities[key]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return min === max ? `${min}` : `${min} ~ ${max}`;
  };

  const schemaEmpty = !index.tagIds.length && !index.relationDefs.length;
  const knownTags = session
    ? session.actors.reduce(
        (sum, a) =>
          sum +
          Object.values(a.knowledge.envs).reduce((n, m) => n + Object.keys(m).length, 0) +
          Object.values(a.knowledge.actors).reduce((n, m) => n + Object.keys(m).length, 0),
        0,
      )
    : 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-3 backdrop-blur-[1px] sm:p-4"
      data-sim-play-panel
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="推演档案"
        className="nv-in flex h-[min(780px,calc(100vh-1.5rem))] w-full max-w-4xl flex-col overflow-hidden rounded-[16px] border border-slate-200/80 bg-white shadow-panel"
      >
        {/* 头部 */}
        <div className="flex shrink-0 items-start gap-2.5 px-4 pb-2 pt-4">
          <span className="mt-0.5 shrink-0 text-slate-500">
            <Film className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-6 text-slate-800">推演档案</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-slate-500">
              与人物档案分离：姓名/状态/形象仍在人物库，这里只有<b>基础能力 / 标签 / 需求 / 情绪 / 关系</b>，
              以及作品级的<b>定义库</b>。改动在下次「开始推演」生效。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            title="关闭推演面板"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab */}
        <div className="flex shrink-0 gap-1 px-4 pb-2" data-sim-play-tabs>
          {(
            [
              ['world', '世界模型'],
              ['profiles', '人物档案'],
              ['design', '设计 · 定义库'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              data-sim-play-tab={key}
              onClick={() => setTab(key)}
              className={`rounded-full border px-3 py-1 text-[12px] transition ${
                tab === key
                  ? 'border-brand-500/40 bg-brand-50 font-medium text-brand-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-slate-100">
          {tab === 'world' ? (
            <div className="space-y-3 p-4" data-sim-world-tab>
              {/* 舞台现状 + 时钟 */}
              <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                <h3 className="text-[12.5px] font-semibold text-slate-700">舞台现状</h3>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-5">
                  <Stat label="环境" value={`${stageEnvs.length}`} />
                  <Stat label="人物放置" value={`${stageChars.length}`} />
                  <Stat label="通道(门)" value={`${world.portals.length}`} />
                  <Stat label="推演中" value={session ? `第 ${session.tick} 拍` : '未开始'} />
                  <Stat
                    label="时钟"
                    value={
                      session
                        ? `第 ${session.clock.day + 1} 天 · ${session.clock.phaseName}`
                        : `每 ${index.time.ticksPerDay} 拍/天`
                    }
                  />
                </div>
                <p
                  className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11.5px] leading-relaxed text-amber-700"
                  data-sim-topology
                >
                  {world.portals.length === 0 ? (
                    <>
                      拓扑模式：<b>降级直连</b>——舞台上还没有通道；父子环境天然连通，同父环境直连（人物可穿墙）。
                      连一条「环境 ↔ 环境」的线即可启用显式拓扑。
                    </>
                  ) : (
                    <>
                      拓扑模式：<b>显式通道</b>——跨环境只走 {world.portals.length} 条通道（门/路径），父子环境内部自由移动；
                      锁闭的通道不可通过。
                    </>
                  )}
                </p>
                <p className="mt-1 text-[11px] text-slate-400" data-sim-clock={session?.clock.phaseId ?? ''}>
                  {session
                    ? `时钟：第 ${session.clock.day + 1} 天 · ${session.clock.phaseName}（tick ${session.clock.tick}，一天 ${
                        session.index.time.ticksPerDay
                      } 拍）`
                    : `时间维度来自定义库（缺省单相「全天」，${index.time.ticksPerDay} 拍/天）`}
                </p>
              </section>

              {/* 🚪 通道列表 */}
              <section className="rounded-xl border border-slate-200 p-3" data-sim-portals>
                <h3 className="text-[12.5px] font-semibold text-slate-700">
                  通道 <span className="font-normal text-slate-400">（画布环境之间的连线 · 门/路径）</span>
                </h3>
                {world.portals.length === 0 ? (
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-400">
                    还没有通道。在舞台画布上从一个环境节点的连接点拖到另一个环境节点即可建通道；连线可点选后删除。
                  </p>
                ) : (
                  <div className="mt-2 space-y-1">
                    {world.portals.map((p) => {
                      const from = stageEnvs.find((n) => n.id === p.from);
                      const to = stageEnvs.find((n) => n.id === p.to);
                      const name = (n: typeof from) =>
                        n && n.data.kind === 'environment' ? n.data.name || '未命名环境' : '未知环境';
                      return (
                        <div
                          key={p.id}
                          data-sim-portal-row={p.id}
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-slate-50/70 px-2 py-1.5 text-[12px]"
                        >
                          <span className="min-w-0 flex-1 truncate text-slate-700">
                            {name(from)} ↔ {name(to)}
                            {p.name ? <span className="ml-1 text-[11px] text-slate-400">（{p.name}）</span> : null}
                            {p.oneWay ? <span className="ml-1 text-[10.5px] text-amber-600">单向</span> : null}
                            {p.traverseCost ? (
                              <span className="ml-1 text-[10.5px] text-slate-400">耗时 {p.traverseCost} 拍</span>
                            ) : null}
                          </span>
                          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-500">
                            <input
                              type="checkbox"
                              data-sim-portal-lock={p.id}
                              checked={p.locked}
                              onChange={(e) =>
                                useStudioStore.getState().toggleSimPortalLock(STAGE_BOARD_ID, p.id, e.target.checked)
                              }
                              className="h-3 w-3 accent-brand-600"
                            />
                            锁闭
                          </label>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* 🏷 环境标签（来自定义库） */}
              <section className="rounded-xl border border-slate-200 p-3" data-sim-env-tags>
                <h3 className="text-[12.5px] font-semibold text-slate-700">
                  环境标签 <span className="font-normal text-slate-400">（来自定义库 · 下次开始推演生效）</span>
                </h3>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-slate-400">
                  给环境挂上定义库里的环境标签：交互（affordance）让引擎知道这里能满足哪项需求，叙事标签只产出发现文案。
                </p>
                {index.envTags.length === 0 ? (
                  <EmptyHint text="定义库还没有环境标签。先到「设计 · 定义库」创建环境标签（角色：交互 / 叙事）。" onGo={() => setTab('design')} />
                ) : stageEnvs.length === 0 ? (
                  <p className="mt-2 text-[11.5px] text-slate-400">舞台上还没有环境。先「＋环境」再挂标签。</p>
                ) : (
                  <div className="mt-2 space-y-1">
                    {stageEnvs.map((n) => {
                      if (n.data.kind !== 'environment') return null;
                      const envName = n.data.name || '未命名环境';
                      const tags = n.data.tags ?? [];
                      return (
                        <div
                          key={n.id}
                          data-sim-env-row={n.id}
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-slate-50/70 px-2 py-1.5"
                        >
                          <span className="min-w-0 flex-1 truncate text-[12px] text-slate-700">
                            {envName}
                            <span className="ml-1 text-[10.5px] text-slate-400">{n.data.etype}</span>
                          </span>
                          {index.envTags.map((def) => {
                            const disabled = !tags.includes(def.id) && tags.length >= 4;
                            return (
                              <label
                                key={def.id}
                                className={`flex items-center gap-1 text-[11px] ${
                                  disabled ? 'cursor-not-allowed text-slate-300' : 'cursor-pointer text-slate-500'
                                }`}
                                title={def.desc || `${def.role} · ${def.name}`}
                              >
                                <input
                                  type="checkbox"
                                  data-sim-env-tag={`${n.id}:${def.id}`}
                                  checked={tags.includes(def.id)}
                                  disabled={disabled}
                                  onChange={(e) =>
                                    useStudioStore
                                      .getState()
                                      .toggleEnvironmentTag(STAGE_BOARD_ID, n.id, def.id, e.target.checked)
                                  }
                                  className="h-3 w-3 accent-brand-600"
                                />
                                {tagLabel(def)}
                              </label>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* 世界模型默认常量 */}
              <section className="rounded-xl border border-slate-200 p-3">
                <h3 className="text-[12.5px] font-semibold text-slate-700">
                  世界模型默认常量 <span className="font-normal text-slate-400">（L0；人物档案未覆盖时取这些值）</span>
                </h3>
                <ul className="mt-1.5 space-y-1 text-[12px] text-slate-500">
                  <li>
                    移动速度 <b className="text-slate-700">{SIM_CAPABILITY_DEFAULTS.speed}</b> px/拍 · 感知范围{' '}
                    <b className="text-slate-700">{SIM_CAPABILITY_DEFAULTS.perception}</b> px · 观察力{' '}
                    <b className="text-slate-700">{SIM_CAPABILITY_DEFAULTS.observation}</b>
                  </li>
                  <li>
                    张望基准耗时 <b className="text-slate-700">{SIM_OBSERVE_BASE}</b> 拍（实际 = 基准 / (0.5 + 观察力/100)，最少 1 拍）
                  </li>
                  <li>需求/情绪/标签参数见「人物档案」页：每位人物一份实例，可单独调整。</li>
                </ul>
              </section>

              {/* 当前人物实际值 */}
              <section className="rounded-xl border border-slate-200 p-3">
                <h3 className="text-[12.5px] font-semibold text-slate-700">人物实际值区间</h3>
                <div className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
                  <Stat label="速度" value={rangeOf('speed')} unit="px/拍" />
                  <Stat label="感知范围" value={rangeOf('perception')} unit="px" />
                  <Stat label="观察力" value={rangeOf('observation')} />
                </div>
                <p className="mt-2 text-[11.5px] leading-relaxed text-slate-400">
                  共 {library.length} 人 · 舞台上 {stageChars.length} 人参与推演。档案缺失的人物自动按默认值兜底。
                </p>
              </section>

              {/* 认知统计 + 接入状态 */}
              <section className="rounded-xl border border-slate-200 p-3">
                <h3 className="text-[12.5px] font-semibold text-slate-700">引擎接入状态</h3>
                <div className="mt-1.5 grid gap-1 text-[11.5px] leading-relaxed sm:grid-cols-2">
                  <p className="text-emerald-700">
                    ✓ 已接入：移动（步行/飞行/撤销） · 需求增长/阈值/紧急 · affordance（相位/次数） ·
                    情绪衰减与反应 · 感知可见性/认知过期 · 有向关系立场 · 通道寻路（锁闭/单向/耗时） · 时间相位
                  </p>
                  <p className="text-slate-400">
                    预留：状态覆盖 · affordance 占用排队 · 叙事化与剧情脚本 · 定义市场
                    {session ? ` · 本拍认知 ${knownTags} 条` : ''}
                  </p>
                </div>
              </section>
            </div>
          ) : tab === 'profiles' ? (
            <div className="flex min-h-full" data-sim-profiles-tab>
              {/* 人物列表 */}
              <div className="w-full shrink-0 border-r border-slate-100 md:w-[240px]">
                <div className="px-2 py-2" data-sim-profile-list>
                  {library.length === 0 ? (
                    <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-slate-400">
                      人物库还是空的。先在画布「＋人物」创建人物——创建时会自动建立推演档案。
                    </p>
                  ) : (
                    library.map((c) => {
                      const onStage = stageChars.includes(c.id);
                      const active = c.id === selectedId;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          data-sim-profile-row={c.id}
                          onClick={() => setSelectedId(c.id)}
                          className={`mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition ${
                            active ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate">{c.name || '未命名'}</span>
                          {onStage && (
                            <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 text-[10px] text-emerald-700">舞台</span>
                          )}
                          {!simProfiles[c.id] && (
                            <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-700">缺档案</span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* 档案详情 */}
              <div className="min-w-0 flex-1 p-3.5">
                {!selected || !profile ? (
                  <div className="flex h-full items-center justify-center text-center text-[13px] leading-relaxed text-slate-400">
                    选择左侧人物查看/调整推演档案。
                  </div>
                ) : (
                  <div className="space-y-3" data-sim-profile-detail={selected.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-semibold text-slate-800">{selected.name || '未命名'}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] text-slate-500" title="创建人物时自动建立的推演档案">
                        推演档案 · 自动创建
                      </span>
                      {actor && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] text-emerald-700">
                          推演中 · {SIM_BEHAVIOR_LABELS[actor.behavior]}
                        </span>
                      )}
                      <span className="flex-1" />
                      <button
                        type="button"
                        data-sim-profile-reset
                        onClick={() => useStudioStore.getState().resetSimProfile(selected.id)}
                        className="rounded-lg border border-slate-200 px-2 py-1 text-[11.5px] text-slate-500 transition hover:bg-slate-50"
                        title="恢复默认：能力取世界模型默认，标签清空，需求全部启用并回定义默认参数"
                      >
                        恢复默认
                      </button>
                    </div>

                    {/* 基础能力 */}
                    <section className="rounded-xl border border-slate-200 p-3">
                      <h3 className="text-[12.5px] font-semibold text-slate-700">
                        基础能力 <span className="font-normal text-slate-400">（世界模型原生，固定三项）</span>
                      </h3>
                      <div className="mt-2 space-y-2">
                        {(Object.keys(CAP_LABEL) as (keyof SimCapabilities)[]).map((key) => {
                          const r = SIM_CAPABILITY_RANGES[key];
                          return (
                            <SlideRow
                              key={key}
                              label={CAP_LABEL[key].name}
                              hint={CAP_LABEL[key].hint}
                              value={profile.capabilities[key]}
                              min={r.min}
                              max={r.max}
                              step={r.step}
                              unit={r.unit}
                              dataKey={`cap:${key}`}
                              onChange={(v) =>
                                useStudioStore
                                  .getState()
                                  .updateSimProfileCapabilities(selected.id, { [key]: v } as Partial<SimCapabilities>)
                              }
                            />
                          );
                        })}
                      </div>
                      <p className="mt-1.5 text-[11px] text-slate-400">
                        张望耗时 ≈ <b className="text-slate-600">{observeTicks(profile.capabilities.observation)}</b> 拍（由观察力推算）
                      </p>
                    </section>

                    {/* 🏷 人物标签（来自定义库） */}
                    <section className="rounded-xl border border-slate-200 p-3" data-sim-profile-tags>
                      <h3 className="text-[12.5px] font-semibold text-slate-700">
                        人物标签 <span className="font-normal text-slate-400">（trait / emotion · 来自定义库）</span>
                      </h3>
                      {index.traits.length === 0 && index.emotions.length === 0 ? (
                        <EmptyHint text="定义库还没有人物标签或情绪。先到「设计 · 定义库」创建。" onGo={() => setTab('design')} />
                      ) : (
                        <>
                          <div className="mt-2 grid gap-1 sm:grid-cols-2">
                            {[...index.traits, ...index.emotions].map((def) => {
                              const on = (profile.tags ?? []).some((t) => t.defId === def.id);
                              const capped = !on && (profile.tags ?? []).length >= 8;
                              return (
                                <label
                                  key={def.id}
                                  className={`flex items-start gap-1.5 rounded-lg bg-slate-50/70 px-2 py-1 text-[11.5px] ${
                                    capped ? 'cursor-not-allowed opacity-40' : 'cursor-pointer text-slate-600'
                                  }`}
                                  title={def.desc || def.role}
                                >
                                  <input
                                    type="checkbox"
                                    data-sim-tag-toggle={def.id}
                                    checked={on}
                                    disabled={capped}
                                    onChange={(e) =>
                                      useStudioStore.getState().toggleSimProfileTag(selected.id, def.id, e.target.checked)
                                    }
                                    className="mt-0.5 h-3 w-3 shrink-0 accent-brand-600"
                                  />
                                  <span className="min-w-0">
                                    <span className="font-medium text-slate-700">{tagLabel(def)}</span>
                                    <span className="block leading-snug text-slate-400">{def.desc || def.role}</span>
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                            <span>
                              移动模式：
                              <b className="text-slate-600" data-sim-move-mode>
                                {(() => {
                                  const mv = resolveSimMovement(traitIdsOf(profile.tags, index), profile.capabilities.speed, index);
                                  return !mv.movable
                                    ? '不可移动（撤销 walk）'
                                    : mv.mode === 'fly'
                                      ? `飞行（${mv.speed}px/拍）`
                                      : `步行（${mv.speed}px/拍）`;
                                })()}
                              </b>
                            </span>
                            {actor &&
                              index.emotions.slice(0, 4).map((def) => (
                                <span
                                  key={def.id}
                                  className="rounded-full bg-white px-1.5 text-[10.5px] tabular-nums text-slate-600 ring-1 ring-slate-200"
                                  data-sim-emotion-live={def.id}
                                >
                                  {tagLabel(def)} {Math.round(actor.emotions[def.id] ?? 0)}
                                </span>
                              ))}
                          </div>
                        </>
                      )}
                    </section>

                    {/* 需求实例 */}
                    <section className="rounded-xl border border-slate-200 p-3" data-sim-needs>
                      <h3 className="text-[12.5px] font-semibold text-slate-700">
                        需求 <span className="font-normal text-slate-400">（定义库 · 逐人物实例）</span>
                      </h3>
                      {index.needs.length === 0 ? (
                        <EmptyHint text="定义库还没有需求。先到「设计 · 定义库」创建需求，再给环境挂交互来满足它。" onGo={() => setTab('design')} />
                      ) : (
                        <div className="mt-2 space-y-2.5">
                          {index.needs.map((def) => {
                            const inst = profile.needs.find((n) => n.defId === def.id);
                            if (!inst) return null;
                            const p = def.need!;
                            const live = actor?.needs[def.id];
                            const growth = inst.growthPerTick ?? p.growth;
                            const threshold = inst.threshold ?? p.threshold;
                            const emergency = inst.emergency ?? p.emergency;
                            const initial = inst.intensity ?? p.initial;
                            return (
                              <div key={def.id} className="rounded-lg bg-slate-50/70 p-2" data-sim-need={def.id}>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[12px] font-medium text-slate-700">{tagLabel(def)}</span>
                                  <span className="text-[10.5px] text-slate-400">
                                    缓解：{[
                                      index.affordances.some((a) => a.affordance?.needId === def.id) ? '交互' : '',
                                      p.relievers?.observe ? '张望' : '',
                                      p.relievers?.novelty ? '新鲜环境' : '',
                                      p.relievers?.social ? '社交' : '',
                                    ]
                                      .filter(Boolean)
                                      .join(' / ') || '无'}
                                  </span>
                                  <span className="flex-1" />
                                  {live !== undefined && (
                                    <span
                                      data-sim-need-live={def.id}
                                      className={`rounded-full px-1.5 text-[10.5px] tabular-nums ring-1 ${
                                        live >= threshold
                                          ? 'bg-amber-50 text-amber-700 ring-amber-200'
                                          : 'bg-white text-slate-500 ring-slate-200'
                                      }`}
                                      title="推演中的需求当前值（达到阈值即触发对应动作）"
                                    >
                                      当前 {live.toFixed(1)} / 阈值 {threshold}
                                    </span>
                                  )}
                                  <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-500">
                                    <input
                                      type="checkbox"
                                      data-sim-need-enabled={def.id}
                                      checked={inst.enabled}
                                      onChange={(e) =>
                                        useStudioStore
                                          .getState()
                                          .updateSimNeed(selected.id, def.id, { enabled: e.target.checked })
                                      }
                                      className="h-3 w-3 accent-brand-600"
                                    />
                                    启用
                                  </label>
                                </div>
                                {def.desc && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{def.desc}</p>}
                                <div className={`mt-1 grid grid-cols-4 gap-2 ${inst.enabled ? '' : 'opacity-40'}`}>
                                  <SlideRow
                                    label="初值"
                                    value={initial}
                                    min={0}
                                    max={100}
                                    step={1}
                                    dataKey={`need:${def.id}:intensity`}
                                    disabled={!inst.enabled}
                                    onChange={(v) => useStudioStore.getState().updateSimNeed(selected.id, def.id, { intensity: v })}
                                  />
                                  <SlideRow
                                    label="增长/拍"
                                    value={growth}
                                    min={0}
                                    max={5}
                                    step={0.1}
                                    dataKey={`need:${def.id}:growth`}
                                    disabled={!inst.enabled}
                                    onChange={(v) =>
                                      useStudioStore.getState().updateSimNeed(selected.id, def.id, { growthPerTick: v })
                                    }
                                  />
                                  <SlideRow
                                    label="触发阈值"
                                    value={threshold}
                                    min={0}
                                    max={100}
                                    step={1}
                                    dataKey={`need:${def.id}:threshold`}
                                    disabled={!inst.enabled}
                                    onChange={(v) => useStudioStore.getState().updateSimNeed(selected.id, def.id, { threshold: v })}
                                  />
                                  <SlideRow
                                    label="紧急阈值"
                                    value={emergency}
                                    min={0}
                                    max={100}
                                    step={1}
                                    dataKey={`need:${def.id}:emergency`}
                                    disabled={!inst.enabled}
                                    onChange={(v) => useStudioStore.getState().updateSimNeed(selected.id, def.id, { emergency: v })}
                                  />
                                </div>
                                {live !== undefined && (
                                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-200" title="需求当前值（相对 100）">
                                    <div
                                      className={`h-full rounded-full transition-[width] ${
                                        live >= emergency ? 'bg-rose-500' : live >= threshold ? 'bg-amber-500' : 'bg-brand-500'
                                      }`}
                                      style={{ width: `${Math.min(100, live)}%` }}
                                    />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>

                    {/* 🔗 关系（有向多标签 + 数值） */}
                    <section className="rounded-xl border border-slate-200 p-3" data-sim-relations>
                      <h3 className="text-[12.5px] font-semibold text-slate-700">
                        关系 <span className="font-normal text-slate-400">（有向：{selected.name || '本人'} → 对方 · 下次开始推演生效）</span>
                      </h3>
                      {index.relationDefs.length === 0 ? (
                        <EmptyHint text="定义库还没有关系类型。先到「设计 · 定义库」创建关系（立场：靠近 / 避开 / 交谈）。" onGo={() => setTab('design')} />
                      ) : library.filter((c) => c.id !== selected.id).length === 0 ? (
                        <p className="mt-1.5 text-[11.5px] text-slate-400">人物库还没有其他人。关系只用于多人同场推演。</p>
                      ) : (
                        <div className="mt-2 space-y-1.5">
                          {library
                            .filter((c) => c.id !== selected.id)
                            .map((other) => {
                              const tags = relationTagsOf(relations, selected.id, other.id);
                              const value = relationValueOf(relations, selected.id, other.id);
                              const setTags = (next: string[]) =>
                                useStudioStore.getState().setSimRelation(selected.id, other.id, next, value);
                              return (
                                <div
                                  key={other.id}
                                  data-sim-relation-row={other.id}
                                  className="rounded-lg bg-slate-50/70 px-2 py-1.5 text-[12px]"
                                >
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="min-w-0 flex-1 truncate text-slate-700">{other.name || '未命名'}</span>
                                    {index.relationDefs.map((def) => {
                                      const on = tags.includes(def.id);
                                      const capped = !on && tags.length >= 3;
                                      return (
                                        <button
                                          key={def.id}
                                          type="button"
                                          data-sim-relation-tag={`${other.id}:${def.id}`}
                                          disabled={capped}
                                          onClick={() => setTags(on ? tags.filter((t) => t !== def.id) : [...tags, def.id])}
                                          className={`rounded-full border px-1.5 py-0.5 text-[10.5px] transition ${
                                            on
                                              ? 'border-brand-500/40 bg-brand-50 text-brand-700'
                                              : capped
                                                ? 'cursor-not-allowed border-slate-200 text-slate-300'
                                                : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                                          }`}
                                          title={def.desc || `立场：${def.stance}`}
                                        >
                                          {tagLabel(def)}
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <div className="mt-1 flex items-center gap-2">
                                    <span className="w-8 shrink-0 text-[10.5px] text-slate-400">好感</span>
                                    <input
                                      type="range"
                                      data-sim-relation-value={other.id}
                                      value={value}
                                      min={0}
                                      max={100}
                                      step={1}
                                      disabled={tags.length === 0}
                                      onChange={(e) =>
                                        useStudioStore
                                          .getState()
                                          .setSimRelation(selected.id, other.id, tags, Number(e.target.value))
                                      }
                                      className="h-1.5 flex-1 cursor-pointer accent-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                                    />
                                    <span className="w-8 shrink-0 text-right text-[10.5px] tabular-nums text-slate-500">
                                      {tags.length ? value : '—'}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      )}
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                        关系是作品级有向数据（随作品存档），与画布连线无关。立场与门槛由定义库决定；
                        {selected.name || '本人'} 对别人的看法不影响别人对 {selected.name || '本人'} 的看法。
                      </p>
                    </section>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="p-4" data-sim-design-tab>
              <SimSchemaEditor
                onOpenWorld={() => setTab('world')}
                schemaEmpty={schemaEmpty}
              />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-lg bg-white px-2 py-1.5 ring-1 ring-slate-200/70">
      <div className="text-[10.5px] text-slate-400">{label}</div>
      <div className="truncate text-[13px] font-semibold tabular-nums text-slate-700" title={value}>
        {value}
        {unit ? <span className="ml-0.5 text-[10px] font-normal text-slate-400">{unit}</span> : null}
      </div>
    </div>
  );
}

function EmptyHint({ text, onGo }: { text: string; onGo: () => void }) {
  return (
    <div className="mt-2 rounded-lg bg-slate-50 px-2 py-1.5 text-[11.5px] leading-relaxed text-slate-400" data-sim-empty>
      {text}{' '}
      <button type="button" onClick={onGo} className="font-medium text-brand-600 hover:underline">
        去设计页 →
      </button>
    </div>
  );
}
