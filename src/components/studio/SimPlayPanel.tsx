/** 🎬 推演面板（设计文档 §12.2）：世界模型（只读现状）+ 人物推演档案（逐人物数值）。
 *
 *  用户在这里判断「基础世界模型的情况」：舞台拓扑模式、默认常量、每位人物实际能力，
 *  以及人物的欲望实例（初值/增长/阈值）与行为列表（启停/权重/耗时）。
 *  推演档案与人物档案物理分离（人物的姓名/状态/形象仍在人物库），修改在**下次开始推演**生效。
 *  完整版还会加「设计（定义库）/推演（事件时间轴/导演干预）/脚本」三个 tab，本版只做前两个。 */
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Film, X } from 'lucide-react';
import { useStudioStore } from '../../stores/studioStore';
import { STAGE_BOARD_ID } from '../../stores/boardOps';
import { useSimSessionStore } from '../../stores/simSessionStore';
import {
  SIM_BUILTIN_BEHAVIORS,
  SIM_BUILTIN_DESIRES,
  SIM_CAPABILITY_DEFAULTS,
  SIM_CAPABILITY_RANGES,
  SIM_OBSERVE_BASE,
  observeTicks,
} from '../../stores/simProfiles';
import { SIM_BEHAVIOR_LABELS } from '../../engines/simRunner';
import type { SimCapabilities } from '../../types/sim';

type TabKey = 'world' | 'profiles';

const CAP_LABEL: Record<keyof SimCapabilities, { name: string; hint: string }> = {
  speed: { name: '速度', hint: '每拍移动的最大像素；跑得快=同样的故事时间走得更远' },
  perception: { name: '感知范围', hint: 'px；预留——当前引擎尚未消费（互见/感知在后续切片接入）' },
  observation: { name: '观察力', hint: '张望耗时 = 基准 / (0.5 + 观察力/100)，越高越快' },
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

export function SimPlayPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>('world');
  const characters = useStudioStore((s) => s.characters);
  const simProfiles = useStudioStore((s) => s.simProfiles);
  const boards = useStudioStore((s) => s.boards);
  const session = useSimSessionStore((s) => s.session);
  const stageBoard = boards[STAGE_BOARD_ID];
  const stageChars = useMemo(
    () =>
      (stageBoard?.nodes ?? [])
        .filter((n) => n.data.kind === 'character')
        .map((n) => (n.data.kind === 'character' ? n.data.characterId : ''))
        .filter(Boolean),
    [stageBoard],
  );
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
        className="nv-in flex h-[min(760px,calc(100vh-1.5rem))] w-full max-w-4xl flex-col overflow-hidden rounded-[16px] border border-slate-200/80 bg-white shadow-panel"
      >
        {/* 头部 */}
        <div className="flex shrink-0 items-start gap-2.5 px-4 pb-2 pt-4">
          <span className="mt-0.5 shrink-0 text-slate-500">
            <Film className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-6 text-slate-800">推演档案</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-slate-500">
              与人物档案分离：姓名/状态/形象仍在人物库，这里只有<b>基础能力 / 欲望 / 行为</b>。
              改动在下次「开始推演」生效（推演中的会话按开始时的档案运行）。
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
              {/* 舞台现状 */}
              <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                <h3 className="text-[12.5px] font-semibold text-slate-700">舞台现状</h3>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
                  <Stat label="环境" value={`${stageBoard?.nodes.filter((n) => n.data.kind === 'environment').length ?? 0}`} />
                  <Stat label="人物放置" value={`${stageChars.length}`} />
                  <Stat label="通道(边)" value={`${stageBoard?.edges.length ?? 0}`} />
                  <Stat label="推演中" value={session ? `第 ${session.tick} 拍` : '未开始'} />
                </div>
                <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11.5px] leading-relaxed text-amber-700" data-sim-topology>
                  {(stageBoard?.edges.length ?? 0) === 0 ? (
                    <>
                      拓扑模式：<b>降级直连</b>——舞台上还没有通道（门/路径），人物直线移动、可穿过墙体。
                      通道绘制与图寻路在后续切片接入（设计文档 §5.2）。
                    </>
                  ) : (
                    <>
                      拓扑模式：舞台上有 {stageBoard?.edges.length} 条边；<b>通道语义尚未接入引擎</b>，当前仍按直线移动。
                    </>
                  )}
                </p>
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
                  <li>欲望/行为参数见「人物档案」页：每位人物一份实例，可单独调整。</li>
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

              {/* 接入状态：诚实列出预留项 */}
              <section className="rounded-xl border border-slate-200 p-3">
                <h3 className="text-[12.5px] font-semibold text-slate-700">引擎接入状态</h3>
                <div className="mt-1.5 grid gap-1 text-[11.5px] leading-relaxed sm:grid-cols-2">
                  <p className="text-emerald-700">
                    ✓ 已接入：移动速度 · 观察力→张望耗时 · 欲望初值/增长/阈值 · 行为启停/权重/耗时
                  </p>
                  <p className="text-slate-400">
                    预留：感知范围（互见） · 扩展属性 · 状态覆盖 · 通道寻路 · 交互与互斥 · 叙事化
                  </p>
                </div>
              </section>
            </div>
          ) : (
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
                    <div className="flex items-center gap-2">
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
                        title="恢复默认：能力取世界模型默认，欲望与行为全部启用并回默认参数"
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
                        张望耗时 ≈ <b className="text-slate-600">{observeTicks(profile.capabilities.observation)}</b> 拍（由观察力推算；
                        行为里可覆盖）
                      </p>
                    </section>

                    {/* 欲望实例 */}
                    <section className="rounded-xl border border-slate-200 p-3">
                      <h3 className="text-[12.5px] font-semibold text-slate-700">
                        欲望 <span className="font-normal text-slate-400">（内置定义 · 逐人物实例）</span>
                      </h3>
                      <div className="mt-2 space-y-2.5">
                        {SIM_BUILTIN_DESIRES.map((def) => {
                          const inst = profile.desires.find((d) => d.defId === def.id);
                          if (!inst) return null;
                          const live = actor?.desires[def.id];
                          const growth = inst.growthPerTick ?? def.growthPerTick;
                          const threshold = inst.threshold ?? def.threshold;
                          return (
                            <div key={def.id} className="rounded-lg bg-slate-50/70 p-2" data-sim-desire={def.id}>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[12px]">{def.icon}</span>
                                <span className="text-[12px] font-medium text-slate-700">{def.name}</span>
                                <span className="text-[10.5px] text-slate-400">{def.relief}</span>
                                <span className="flex-1" />
                                {live !== undefined && (
                                  <span
                                    data-sim-desire-live={def.id}
                                    className={`rounded-full px-1.5 text-[10.5px] tabular-nums ring-1 ${
                                      live >= threshold
                                        ? 'bg-amber-50 text-amber-700 ring-amber-200'
                                        : 'bg-white text-slate-500 ring-slate-200'
                                    }`}
                                    title="推演中的欲望当前值（达到阈值即触发对应行为）"
                                  >
                                    当前 {live.toFixed(1)} / 阈值 {threshold}
                                  </span>
                                )}
                                <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-500">
                                  <input
                                    type="checkbox"
                                    data-sim-desire-enabled={def.id}
                                    checked={inst.enabled}
                                    onChange={(e) =>
                                      useStudioStore.getState().updateSimDesire(selected.id, def.id, { enabled: e.target.checked })
                                    }
                                    className="h-3 w-3 accent-brand-600"
                                  />
                                  启用
                                </label>
                              </div>
                              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{def.desc}</p>
                              <div className={`mt-1 grid grid-cols-3 gap-2 ${inst.enabled ? '' : 'opacity-40'}`}>
                                <SlideRow
                                  label="初值"
                                  value={inst.intensity}
                                  min={0}
                                  max={100}
                                  step={1}
                                  dataKey={`desire:${def.id}:intensity`}
                                  disabled={!inst.enabled}
                                  onChange={(v) => useStudioStore.getState().updateSimDesire(selected.id, def.id, { intensity: v })}
                                />
                                <SlideRow
                                  label="增长/拍"
                                  value={growth}
                                  min={0}
                                  max={5}
                                  step={0.1}
                                  dataKey={`desire:${def.id}:growth`}
                                  disabled={!inst.enabled}
                                  onChange={(v) =>
                                    useStudioStore.getState().updateSimDesire(selected.id, def.id, { growthPerTick: v })
                                  }
                                />
                                <SlideRow
                                  label="触发阈值"
                                  value={threshold}
                                  min={0}
                                  max={100}
                                  step={1}
                                  dataKey={`desire:${def.id}:threshold`}
                                  disabled={!inst.enabled}
                                  onChange={(v) => useStudioStore.getState().updateSimDesire(selected.id, def.id, { threshold: v })}
                                />
                              </div>
                              {live !== undefined && (
                                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-200" title="欲望当前值（相对 100）">
                                  <div
                                    className={`h-full rounded-full transition-[width] ${
                                      live >= threshold ? 'bg-amber-500' : 'bg-brand-500'
                                    }`}
                                    style={{ width: `${Math.min(100, live)}%` }}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </section>

                    {/* 行为列表 */}
                    <section className="rounded-xl border border-slate-200 p-3">
                      <h3 className="text-[12.5px] font-semibold text-slate-700">
                        行为 <span className="font-normal text-slate-400">（内置定义 · 逐人物实例）</span>
                      </h3>
                      <div className="mt-2 space-y-1.5">
                        {SIM_BUILTIN_BEHAVIORS.map((def) => {
                          const inst = profile.behaviors.find((b) => b.defId === def.id);
                          if (!inst) return null;
                          const duration = inst.duration;
                          return (
                            <div
                              key={def.id}
                              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-slate-50/70 px-2 py-1.5"
                              data-sim-behavior-row={def.id}
                            >
                              <span className="text-[12px]">{def.icon}</span>
                              <span className="w-10 text-[12px] font-medium text-slate-700">{def.name}</span>
                              <span className="min-w-0 flex-1 basis-40 text-[11px] leading-snug text-slate-400">{def.desc}</span>
                              <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-500">
                                <input
                                  type="checkbox"
                                  data-sim-behavior-enabled={def.id}
                                  checked={inst.enabled}
                                  onChange={(e) =>
                                    useStudioStore.getState().updateSimBehavior(selected.id, def.id, { enabled: e.target.checked })
                                  }
                                  className="h-3 w-3 accent-brand-600"
                                />
                                启用
                              </label>
                              {def.weightEditable ? (
                                <label className={`flex items-center gap-1 text-[11px] text-slate-500 ${inst.enabled ? '' : 'opacity-40'}`}>
                                  权重
                                  <input
                                    type="number"
                                    data-sim-behavior-weight={def.id}
                                    value={inst.weight ?? def.weight}
                                    min={0}
                                    max={1}
                                    step={0.1}
                                    disabled={!inst.enabled}
                                    onChange={(e) =>
                                      useStudioStore
                                        .getState()
                                        .updateSimBehavior(selected.id, def.id, { weight: Number(e.target.value) })
                                    }
                                    className="h-6 w-14 rounded-md border border-slate-200 px-1 text-[11px] tabular-nums text-slate-600 outline-none focus:border-brand-400"
                                  />
                                </label>
                              ) : (
                                <span
                                  className="text-[11px] text-slate-400"
                                  title="当前引擎按欲望阈值/保底规则触发，权重为定义库预留字段"
                                >
                                  {def.trigger ?? '按规则触发'}
                                </span>
                              )}
                              {def.durationEditable && (
                                <label className={`flex items-center gap-1 text-[11px] text-slate-500 ${inst.enabled ? '' : 'opacity-40'}`}>
                                  耗时
                                  <input
                                    type="number"
                                    data-sim-behavior-duration={def.id}
                                    value={duration ?? (def.id === 'builtin:observe' ? observeTicks(profile.capabilities.observation) : def.duration ?? 1)}
                                    min={1}
                                    max={20}
                                    step={1}
                                    disabled={!inst.enabled}
                                    onChange={(e) =>
                                      useStudioStore
                                        .getState()
                                        .updateSimBehavior(selected.id, def.id, { duration: Number(e.target.value) })
                                    }
                                    className="h-6 w-12 rounded-md border border-slate-200 px-1 text-[11px] tabular-nums text-slate-600 outline-none focus:border-brand-400"
                                  />
                                  拍
                                </label>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <p className="mt-1.5 text-[11px] text-slate-400">
                        探索由「好奇达到阈值」触发、休息由「疲劳达到阈值」触发、张望按权重掷骰、走动为保底动作。
                      </p>
                    </section>
                  </div>
                )}
              </div>
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
