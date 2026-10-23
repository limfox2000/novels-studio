/** 🪑 编辑会议视图（编辑室会议模式）：设置参会编辑/资料/轮数 → 底部提交诉求给总编辑 → 总编辑确定议题 → 轮流发言 → 总编辑小结 → 纪要；会中可插话。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorialStore, type MeetingDraft } from '../../stores/editorialStore';
import { MATERIAL_LABELS, type MaterialKey } from '../../engines/studioEngine';
import type { MeetingTurn } from '../../engines/meetingEngine';
import { useUiStore } from '../../stores/uiStore';
import { SimWriteButtons } from './SimWriteButtons';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { ClipboardList, Paperclip, Square, Target, Users } from 'lucide-react';

const MATERIAL_KEYS = Object.keys(MATERIAL_LABELS) as MaterialKey[];
const ROUND_OPTIONS = [2, 3, 4, 5, 6, 7, 8];

const STATUS_TEXT: Record<string, string> = {
  idle: '',
  running: '会议进行中…',
  done: '会议已结束，纪要已同步到对话页；纪要中的写入草稿需点击确认才会生效',
  stopped: '已停止（已生成的发言保留）',
  error: '',
};

function TurnCard({ turn, specialty }: { turn: MeetingTurn; specialty: string }) {
  if (turn.kind === 'intake') {
    return (
      <div className="rounded-[10px] border border-slate-200 border-l-[3px] border-l-brand-500 bg-white px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
          <Target className="h-3.5 w-3.5 text-brand-500" />
          议题与初始意见（总编辑）
        </div>
        <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.75] text-slate-700">{turn.text || '…'}</div>
      </div>
    );
  }
  if (turn.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-[14px] rounded-br-[4px] bg-brand-600 px-3.5 py-2 text-[13px] leading-[1.75] text-white"
        >
          <div className="mb-0.5 text-[12px] opacity-80">插话</div>
          {turn.text}
        </div>
      </div>
    );
  }
  if (turn.kind === 'minutes') {
    return (
      <div className="rounded-[10px] border border-slate-200 border-l-[3px] border-l-amber-400 bg-white px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
          <ClipboardList className="h-3.5 w-3.5 text-amber-500" />
          会议纪要
        </div>
        <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.75] text-slate-700">{turn.text || '…'}</div>
        <SimWriteButtons writes={turn.writes} />
      </div>
    );
  }
  const isHost = turn.kind === 'host';
  const silent = !!turn.noOpinion;
  return (
    <div
      className={`rounded-[10px] border px-3 py-2 ${
        isHost
          ? 'border-slate-200 bg-slate-50'
          : silent
            ? 'border-dashed border-slate-200 bg-white'
            : 'border-slate-200 bg-white'
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className={`text-[12px] font-semibold ${isHost ? 'text-slate-600' : silent ? 'text-slate-400' : 'text-slate-700'}`}>{turn.name}</span>
        {!isHost && specialty && (
          <span className="rounded-full bg-brand-50 px-1.5 py-px text-[12px] text-brand-600">{specialty}</span>
        )}
        {isHost && <span className="rounded-full bg-slate-200 px-1.5 py-px text-[12px] text-slate-500">整合</span>}
        {silent && <span className="rounded-full bg-slate-100 px-1.5 py-px text-[12px] text-slate-400">无意见，退出后续轮</span>}
      </div>
      <div className={`whitespace-pre-wrap break-words text-[13px] leading-[1.75] ${silent ? 'text-slate-400' : 'text-slate-700'}`}>
        {turn.text || '…'}
      </div>
    </div>
  );
}

export function MeetingView() {
  const localEditors = useEditorialStore((s) => s.localEditors);
  const serverEditors = useEditorialStore((s) => s.serverEditors);
  const draft = useEditorialStore((s) => s.draft);
  const status = useEditorialStore((s) => s.status);
  const topic = useEditorialStore((s) => s.topic);
  const turns = useEditorialStore((s) => s.turns);
  const error = useEditorialStore((s) => s.error);
  const routeChat = useEditorialStore((s) => s.routeChat);
  const generating = useUiStore((s) => s.generating);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const running = status === 'running';

  const editors = useMemo(() => [...localEditors, ...serverEditors], [localEditors, serverEditors]);
  const enabledEditors = useMemo(() => editors.filter((e) => e.enabled), [editors]);
  const specialtyById = useMemo(() => new Map(editors.map((e) => [e.id, e.specialty])), [editors]);

  useEffect(() => {
    void useEditorialStore.getState().loadServerEditors();
  }, []);
  const lastTurn = turns[turns.length - 1];
  const canInterject = running && !!lastTurn && lastTurn.kind !== 'minutes';
  const hasSelectedEditor = enabledEditors.some((e) => draft.editorIds.includes(e.id));
  const canSubmit = !running && !generating && !!input.trim() && hasSelectedEditor;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  const toggleEditor = (id: string) => {
    const has = draft.editorIds.includes(id);
    useEditorialStore.getState().setDraft({
      editorIds: has ? draft.editorIds.filter((x) => x !== id) : [...draft.editorIds, id],
    });
  };
  const toggleMaterial = (k: MaterialKey) => {
    const has = draft.materials.includes(k);
    useEditorialStore.getState().setDraft({
      materials: has ? draft.materials.filter((x) => x !== k) : [...draft.materials, k],
    });
  };
  const setDraft = (patch: Partial<MeetingDraft>) => useEditorialStore.getState().setDraft(patch);

  const submit = () => {
    const t = input.trim();
    if (!t) return;
    if (running) {
      if (!canInterject) return;
      useEditorialStore.getState().addRemark(t);
      setInput('');
      return;
    }
    if (!canSubmit) return;
    if (turns.length && !window.confirm('开始新会议将清空上一场的发言与纪要，继续？')) return;
    setInput('');
    void useEditorialStore.getState().startMeeting(t);
  };

  const chipCls = (on: boolean) =>
    `rounded-full border px-2.5 py-1 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
      on
        ? 'border-brand-600 bg-brand-600 text-white'
        : 'border-slate-200 bg-white text-slate-500 hover:border-brand-200 hover:text-brand-700'
    }`;

  const placeholder = running
    ? canInterject
      ? '插话：下一位编辑发言前会看到（Enter 发送）'
      : '会议进行中，纪要生成时不可插话'
    : '向总编辑提出诉求，如：第二卷主角动机站不住，帮我开会看看（Enter 提交）';

  const hint = error || STATUS_TEXT[status];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 设置区（会议中锁定） */}
      <div className="flex-shrink-0 space-y-2.5 border-b border-slate-100 px-3 py-2.5">
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-slate-500">
            <Users className="h-3.5 w-3.5" />
            参会编辑
            <span className="font-normal text-slate-400">按名单顺序发言，总编辑主持</span>
          </div>
          {enabledEditors.length ? (
            <div className="flex flex-wrap gap-1.5">
              {enabledEditors.map((e) => (
                <button key={e.id} onClick={() => toggleEditor(e.id)} disabled={running} className={chipCls(draft.editorIds.includes(e.id))} title={e.specialty}>
                  {e.storage === 'server' ? '☁ ' : ''}
                  {e.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="text-[12px] text-amber-600">编辑部暂无启用的编辑，请先在「编辑部」中添加。</div>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-slate-500">
            <Paperclip className="h-3.5 w-3.5" />
            项目资料
            <span className="font-normal text-slate-400">本次会议可见</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {MATERIAL_KEYS.map((k) => (
              <button key={k} onClick={() => toggleMaterial(k)} disabled={running} className={chipCls(draft.materials.includes(k))}>
                {MATERIAL_LABELS[k]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className="text-[12px] font-medium text-slate-500"
            title="最多轮数。第一轮全员表态；之后只有上一轮有意见的编辑继续，全员无意见即提前结束"
          >
            最多轮数
          </span>
          <div className="flex gap-1">
            {ROUND_OPTIONS.map((n) => (
              <button key={n} onClick={() => setDraft({ rounds: n })} disabled={running} className={chipCls(draft.rounds === n)}>
                {n}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          {running && (
            <Button
              variant="danger"
              size="sm"
              icon={<Square className="fill-current" />}
              onClick={() => useEditorialStore.getState().stopMeeting()}
              title="停止会议（保留已生成的发言）"
            >
              停止会议
            </Button>
          )}
        </div>
        {running && (
          <div className="flex items-center gap-2">
            <Switch checked={routeChat} onChange={(v) => useEditorialStore.getState().setRouteChat(v)} />
            <span className="text-[12px] text-slate-500">对话页发送的内容进入本次会议讨论（作为插话）</span>
          </div>
        )}
        {topic && (
          <div className="text-[12.5px] leading-relaxed text-slate-600">
            <span className="font-semibold text-brand-700">议题：</span>
            {topic}
          </div>
        )}
        {hint && (
          <div className={`text-[12px] leading-relaxed ${error ? 'text-rose-600' : status === 'done' ? 'text-emerald-600' : 'text-slate-400'}`}>
            {hint}
          </div>
        )}
      </div>

      {/* 发言记录 */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!turns.length && (
          <div className="py-8 text-center text-[12.5px] leading-relaxed text-slate-400">
            还没有会议。勾选参会编辑后，在下方向总编辑提出诉求，总编辑会确定议题并开会。
          </div>
        )}
        {turns.map((t, i) => {
          const showRound = t.round > 0 && t.kind !== 'minutes' && (i === 0 || turns[i - 1].round !== t.round);
          return (
            <div key={t.id} className="space-y-2">
              {showRound && (
                <div className="flex items-center gap-2 text-[12px] text-slate-400">
                  <span className="h-px flex-1 bg-slate-200" />
                  第 {t.round} 轮
                  <span className="h-px flex-1 bg-slate-200" />
                </div>
              )}
              <TurnCard turn={t} specialty={specialtyById.get(t.speakerId) ?? ''} />
            </div>
          );
        })}
      </div>

      {/* 底部：空闲时提交诉求，会中为插话 */}
      <div className="flex-shrink-0 border-t border-slate-100 px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={running ? !canInterject : generating}
            rows={2}
            placeholder={placeholder}
            className="min-w-0 flex-1 resize-none rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-2 text-[14px] leading-[1.7] text-slate-700 transition placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10 disabled:opacity-50"
          />
          <Button
            variant="primary"
            onClick={submit}
            disabled={running ? !canInterject || !input.trim() : !canSubmit}
            title={running ? '插话' : generating ? '已有生成任务进行中' : !hasSelectedEditor ? '请先勾选参会编辑' : '提交给总编辑'}
          >
            {running ? '插话' : '提交'}
          </Button>
        </div>
      </div>
    </div>
  );
}
