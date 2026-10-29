/** 🎬 舞台推演控制条：只在舞台画布（STAGE_BOARD_ID）显示，浮在画布底部中央。
 *
 *  MVP 能力：开始/暂停/继续/单步/重置 + 速度 + 在场人物行为气泡 + 最近事件。
 *  人物在画布上的移动由 StudioPage 投影渲染，本组件只做控制与观战。
 *  完整设计（欲望库、推演档案、通道寻路、叙事化）见 docs/剧情推演模拟器设计.md。 */
import { useState } from 'react';
import { Film, Pause, Play, RotateCcw, SkipForward, SlidersHorizontal } from 'lucide-react';
import { useSimSessionStore, SIM_SPEED_OPTIONS } from '../../stores/simSessionStore';
import { SIM_BEHAVIOR_LABELS, type SimBehavior } from '../../engines/simRunner';
import { EMOTION_FEAR, EMOTION_JOY } from '../../stores/simTags';
import { SimPlayPanel } from './SimPlayPanel';

/** 行为 → 气泡配色（与人物节点上的行为 chip 共用语义） */
export const SIM_BEHAVIOR_STYLE: Record<SimBehavior, { chip: string; dot: string; icon: string }> = {
  idle: { chip: 'bg-slate-100 text-slate-500 ring-slate-200', dot: '#94a3b8', icon: '⏸' },
  move: { chip: 'bg-sky-50 text-sky-700 ring-sky-200', dot: '#0ea5e9', icon: '🚶' },
  observe: { chip: 'bg-violet-50 text-violet-700 ring-violet-200', dot: '#8b5cf6', icon: '👀' },
  rest: { chip: 'bg-amber-50 text-amber-700 ring-amber-200', dot: '#f59e0b', icon: '🛋' },
  eat: { chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: '#10b981', icon: '🍽' },
  talk: { chip: 'bg-pink-50 text-pink-700 ring-pink-200', dot: '#ec4899', icon: '💬' },
  avoid: { chip: 'bg-rose-50 text-rose-700 ring-rose-200', dot: '#f43f5e', icon: '🏃' },
};

export function StageSimBar() {
  const session = useSimSessionStore((s) => s.session);
  const running = useSimSessionStore((s) => s.running);
  const error = useSimSessionStore((s) => s.error);
  const intervalMs = useSimSessionStore((s) => s.intervalMs);
  const store = useSimSessionStore.getState();
  const [panelOpen, setPanelOpen] = useState(false);

  const started = !!session;
  const actors = session?.actors ?? [];
  const events = session?.events.slice(-6).slice().reverse() ?? [];

  return (
    <div
      data-sim-panel
      className="absolute bottom-4 left-1/2 z-20 w-[min(680px,calc(100vw-24px))] -translate-x-1/2 rounded-xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur"
    >
      {/* 头部：标题 + 拍数 + 控制 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
        <span className="flex shrink-0 items-center gap-1 text-[13px] font-semibold text-slate-700">
          <Film className="h-4 w-4 text-brand-600" />
          推演
        </span>
        <span className="shrink-0 text-[12px] text-slate-400 tabular-nums" data-sim-tick>
          {started ? `第 ${session!.tick} 拍` : '未开始'}
        </span>
        <span className="shrink-0 text-[12px] text-slate-400" data-sim-actor-count>
          {actors.length ? `${actors.length} 人在场` : '舞台上无人物'}
        </span>
        <button
          type="button"
          data-sim-open-profile
          onClick={() => setPanelOpen(true)}
          className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-600 transition hover:bg-slate-50"
          title="查看世界模型常量与每个人物的推演档案"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          推演档案
        </button>
        <span className="flex-1" />
        <label className="flex shrink-0 items-center gap-1 text-[12px] text-slate-500" title="每拍间隔">
          速度
          <select
            data-sim-speed
            value={intervalMs}
            onChange={(e) => store.setIntervalMs(Number(e.target.value) as (typeof SIM_SPEED_OPTIONS)[number])}
            className="cursor-pointer rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[12px] text-slate-600 focus:outline-none"
          >
            {SIM_SPEED_OPTIONS.map((ms) => (
              <option key={ms} value={ms}>
                {(1000 / ms).toFixed(ms === 2000 ? 1 : 0)} 拍/秒
              </option>
            ))}
          </select>
        </label>
        {!started || !running ? (
          <button
            data-sim-start
            onClick={() => (started ? store.resume() : store.start())}
            className="flex h-7 shrink-0 items-center gap-1 rounded-lg bg-brand-600 px-2.5 text-[12px] font-medium text-white transition hover:bg-brand-700"
            title={started ? '继续推演' : '按当前舞台的摆放开始推演'}
          >
            <Play className="h-3.5 w-3.5" />
            {started ? '继续' : '开始推演'}
          </button>
        ) : (
          <button
            data-sim-pause
            onClick={() => store.pause()}
            className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-600 transition hover:bg-slate-50"
            title="暂停推演（人物停在原地，可继续）"
          >
            <Pause className="h-3.5 w-3.5" />
            暂停
          </button>
        )}
        <button
          data-sim-step
          onClick={() => store.stepOnce()}
          disabled={running}
          className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          title="暂停态下手动推进一拍"
        >
          <SkipForward className="h-3.5 w-3.5" />
          单步
        </button>
        <button
          data-sim-reset
          onClick={() => store.reset()}
          disabled={!started}
          className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          title="重置：清空会话，人物回到摆放位置"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          重置
        </button>
      </div>

      {error && (
        <div className="border-b border-amber-100 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-700" data-sim-error>
          {error}
        </div>
      )}

      {/* 在场人物：一类一行状态 chip（行为 + 所在环境） */}
      {actors.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-3 py-1.5">
          {actors.map((a) => {
            const style = SIM_BEHAVIOR_STYLE[a.behavior];
            const envName = a.envId ? session!.envs.find((e) => e.id === a.envId)?.name : '';
            const fear = a.emotions[EMOTION_FEAR] ?? 0;
            const joy = a.emotions[EMOTION_JOY] ?? 0;
            const hunger = a.desires['builtin:hunger'] ?? 0;
            return (
              <span
                key={a.nodeId}
                data-sim-actor
                data-sim-character-id={a.characterId}
                data-sim-behavior={a.behavior}
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ring-1 ${style.chip}`}
                title={`${a.name}：${SIM_BEHAVIOR_LABELS[a.behavior]}${envName ? `（${envName}）` : ''} · 速度 ${a.speed}px/拍 · 观察力 ${a.profile.capabilities.observation} · 饥饿 ${hunger.toFixed(0)} · 恐惧 ${fear.toFixed(0)} · 喜悦 ${joy.toFixed(0)}${a.movable ? '' : ' · 不可移动'}`}
              >
                <span className="font-medium text-slate-700">{a.name}</span>
                <span>
                  {style.icon} {SIM_BEHAVIOR_LABELS[a.behavior]}
                </span>
                {envName && <span className="opacity-70">· {envName}</span>}
                {fear >= 30 && (
                  <span data-sim-emotion="fear" title={`恐惧 ${fear.toFixed(0)}`}>
                    😨
                  </span>
                )}
                {joy >= 30 && (
                  <span data-sim-emotion="joy" title={`喜悦 ${joy.toFixed(0)}`}>
                    😊
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* 最近事件 */}
      <div className="max-h-[96px] overflow-y-auto px-3 py-1.5" data-sim-events>
        {events.length === 0 ? (
          <p className="text-[12px] text-slate-400">
            把环境与人物放到舞台上，点「开始推演」——人物会自己走动、张望、休息。
          </p>
        ) : (
          <ul className="space-y-0.5">
            {events.map((ev) => (
              <li key={ev.id} className="truncate text-[12px] text-slate-500" data-sim-event>
                <span className="mr-1 tabular-nums text-slate-300">{ev.tick}</span>
                <span className="mr-1 text-slate-400">{ev.actorName}</span>
                {ev.text}
              </li>
            ))}
          </ul>
        )}
      </div>

      {panelOpen && <SimPlayPanel onClose={() => setPanelOpen(false)} />}
    </div>
  );
}
