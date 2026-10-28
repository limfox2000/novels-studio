/** 🔎 编辑室·长文分析（轻量独立面板）：粘贴/导入原文 + 填写分析方向，按模型上下文分段，
 *  执行「全文分析 → 仿写对照修订 → 再生成再分析 → 最终报告」三轮。仅在编辑室与某位编辑单独对话时可用。
 *  不写入画布/对话/编辑记忆；全部状态只在本组件内存，关闭即丢弃。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  RotateCcw,
  ScanText,
  Sparkles,
  Square,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { useEditorRoomStore } from '../../stores/editorRoomStore';
import { useUiStore } from '../../stores/uiStore';
import { useWritingSkillStore } from '../../stores/writingSkillStore';
import { stopGeneration } from '../../shared/generation';
import type { Editor } from '../../engines/meetingEngine';
import {
  estimateLongTextPlan,
  LONG_TEXT_DIRECTION_MAX,
  LONG_TEXT_MAX_CHARS,
  LONG_TEXT_MAX_IMPORT_BYTES,
  LONG_TEXT_STAGE_LABELS,
  parseWritingSkillDraft,
  runLongTextAnalysis,
  type LongTextAnalysisPlan,
  type LongTextAnalysisProgress,
  type LongTextAnalysisStage,
  type LongTextAnalysisStats,
} from '../../engines/longTextAnalysis';

type Status = 'setup' | 'running' | 'stopping' | 'done' | 'stopped' | 'error';

const STEPS = [
  { phase: 1 as const, label: '全文分析', desc: '分段读取 → 按方向总结' },
  { phase: 2 as const, label: '仿写对照', desc: '仿写 → 校对 → 修订总结' },
  { phase: 3 as const, label: '再校验', desc: '再生成 → 再分析 → 报告' },
];

const ARTIFACT_ORDER: LongTextAnalysisStage[] = ['summary1', 'draft1', 'compare1', 'summary2', 'draft2', 'analysis2'];

export function LongTextAnalysisPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const engine = useEditorRoomStore((s) => s.settings.engine);
  const nCtx = useEditorRoomStore((s) => (s.settings.engine === 'private' ? (s.meta?.nCtx ?? 0) : 0));
  const generating = useUiStore((s) => s.generating);

  const [source, setSource] = useState('');
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState<Status>('setup');
  const [progress, setProgress] = useState<LongTextAnalysisProgress | null>(null);
  const [artifacts, setArtifacts] = useState<Partial<Record<LongTextAnalysisStage, string>>>({});
  const [plan, setPlan] = useState<LongTextAnalysisPlan | null>(null);
  const [stats, setStats] = useState<LongTextAnalysisStats | null>(null);
  const [error, setError] = useState('');
  const [importError, setImportError] = useState('');
  const [copied, setCopied] = useState(false);
  const [skillSaved, setSkillSaved] = useState('');
  const [skillError, setSkillError] = useState('');

  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const cancelledRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (runningRef.current) {
        cancelledRef.current = true;
        stopGeneration();
      }
    };
  }, []);

  const estimate = useMemo(
    () => estimateLongTextPlan({ textLength: source.length, direction, editor, nCtx }),
    [source.length, direction, editor, nCtx],
  );
  const busy = status === 'running' || status === 'stopping';
  const finalText = artifacts.final ?? '';
  const skillDraft = useMemo(() => (finalText ? parseWritingSkillDraft(finalText) : null), [finalText]);
  const tooLong = source.length > LONG_TEXT_MAX_CHARS;
  const canStart = !!source.trim() && !!direction.trim() && !tooLong && !busy && !generating;

  const run = async () => {
    if (!canStart || runningRef.current) return;
    runningRef.current = true;
    cancelledRef.current = false;
    setStatus('running');
    setError('');
    setImportError('');
    setArtifacts({});
    setPlan(null);
    setStats(null);
    setProgress(null);
    setCopied(false);
    setSkillSaved('');
    setSkillError('');
    const r = await runLongTextAnalysis({
      editor,
      text: source,
      direction,
      engine,
      nCtx,
      cancelled: () => cancelledRef.current,
      onProgress: (p) => {
        if (mountedRef.current) setProgress(p);
      },
      onStage: (stage, text) => {
        if (mountedRef.current) setArtifacts((a) => ({ ...a, [stage]: text }));
      },
    });
    runningRef.current = false;
    if (!mountedRef.current) return;
    setArtifacts(r.artifacts);
    setPlan(r.plan ?? null);
    setStats(r.stats ?? null);
    setError(r.error ?? '');
    setStatus(r.ok ? 'done' : r.stopped ? 'stopped' : 'error');
  };

  const stop = () => {
    cancelledRef.current = true;
    setStatus('stopping');
    stopGeneration();
  };

  const close = () => {
    if (busy && !window.confirm('分析进行中，关闭会停止并丢失当前进度，仍要关闭？')) return;
    cancelledRef.current = true;
    if (runningRef.current) stopGeneration();
    onClose();
  };

  const reset = () => {
    if (busy) return;
    setStatus('setup');
    setProgress(null);
    setArtifacts({});
    setPlan(null);
    setStats(null);
    setError('');
    setCopied(false);
    setSkillSaved('');
    setSkillError('');
  };

  /** 最终报告中的【写作技能】块 → 写作技能库（失败原因 inline 展示，重名等去管理器改名） */
  const saveSkill = () => {
    if (!skillDraft) return;
    setSkillError('');
    const r = useWritingSkillStore.getState().createSkill(skillDraft);
    if (!r.ok) {
      setSkillError(r.error);
      return;
    }
    setSkillSaved(`已存入技能库「${skillDraft.name}」，可在正文面板 ✨ 槽位启用`);
  };

  const copyResult = async () => {
    const text = finalText || artifacts.summary2 || artifacts.summary1 || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => mountedRef.current && setCopied(false), 1600);
    } catch {
      setError('复制失败，请手动选择文本复制');
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError('');
    if (file.size > LONG_TEXT_MAX_IMPORT_BYTES) {
      setImportError(`文件 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 2MB 上限`);
      return;
    }
    const okName = /\.(txt|md|markdown)$/i.test(file.name) || file.type.startsWith('text/');
    if (!okName) {
      setImportError('只支持 .txt / .md 纯文本文件');
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) {
        setImportError('文件内容为空');
        return;
      }
      if (text.length > LONG_TEXT_MAX_CHARS) {
        setImportError(`文件 ${text.length} 字，超过 ${LONG_TEXT_MAX_CHARS} 字上限`);
        return;
      }
      setSource(text);
      setStatus('setup');
      setArtifacts({});
      setError('');
    } catch {
      setImportError('读取文件失败，请确认是 UTF-8 纯文本');
    }
  };

  const resultView = status !== 'setup' && status !== 'running' && status !== 'stopping';
  const showArtifacts = resultView && Object.keys(artifacts).length > 0;

  return createPortal(
    <div
      data-testid="long-text-analysis"
      className="fixed bottom-2 left-2 right-2 top-[calc(var(--topbar-h)+10px)] z-[45] flex flex-col overflow-hidden rounded-[16px] border border-slate-200/80 bg-white shadow-panel lg:left-auto lg:right-[calc(560px_+_2rem)] lg:w-[min(32rem,calc(100vw_-_38rem))]"
    >
      <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-slate-100 px-3 py-2">
        <span className="flex items-center gap-1.5 whitespace-nowrap text-[14px] font-semibold text-slate-700">
          <ScanText className="h-4 w-4 text-slate-400" />
          长文分析
        </span>
        <span className="truncate rounded-full bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700">{editor.name}</span>
        <span className="flex-1" />
        {busy && (
          <span className="hidden items-center gap-1 whitespace-nowrap text-[12px] text-brand-600 sm:flex">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {progress ? `${progress.done}/${progress.total}` : '准备中'}
          </span>
        )}
        <IconButton icon={<X />} title="关闭长文分析" onClick={close} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!resultView && (
          <div className="space-y-3">
            <p className="rounded-[8px] bg-slate-50 px-2.5 py-2 text-[11.5px] leading-relaxed text-slate-500">
              使用「{editor.name}」的职责与记忆作为分析视角；分析过程与结果不会写入对话、画布或编辑记忆。
            </p>

            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[12px] font-medium text-slate-600">原文</span>
                <span className="text-[11px] tabular-nums text-slate-400">
                  {source.length}/{LONG_TEXT_MAX_CHARS} 字
                </span>
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="soft"
                  icon={<Upload />}
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  data-longtext-import
                >
                  导入文本
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.md,.markdown,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    void importFile(f);
                    e.target.value = '';
                  }}
                />
              </div>
              <textarea
                value={source}
                onChange={(e) => setSource(e.target.value)}
                aria-label="长文原文"
                data-longtext-source
                disabled={busy}
                spellCheck={false}
                placeholder="粘贴要分析的长篇原文，或从右侧导入 .txt / .md 文件…"
                className="h-[220px] w-full resize-y rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-2 text-[12.5px] leading-[1.75] text-slate-700 transition placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10 disabled:opacity-60"
              />
              {importError && (
                <p className="mt-1 flex items-start gap-1 text-[11.5px] text-rose-600">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  {importError}
                </p>
              )}
              {tooLong && !importError && (
                <p className="mt-1 text-[11.5px] text-rose-600">原文超过 {LONG_TEXT_MAX_CHARS} 字上限，请缩短后再分析。</p>
              )}
            </div>

            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[12px] font-medium text-slate-600">分析方向</span>
                <span className="text-[11px] tabular-nums text-slate-400">
                  {direction.length}/{LONG_TEXT_DIRECTION_MAX}
                </span>
              </div>
              <textarea
                value={direction}
                onChange={(e) => setDirection(e.target.value.slice(0, LONG_TEXT_DIRECTION_MAX))}
                aria-label="分析方向"
                data-longtext-direction
                disabled={busy}
                rows={3}
                placeholder={
                  '例如：重点分析战斗场面的节奏、视角与信息释放；哪些写法可以直接复用？\n也可要求整理成写作技能，如：把本文的战斗写法整理成一个全文写作 skill（方向含「技能/skill」时，最终报告会附可直接保存的技能块）'
                }
                className="w-full resize-none rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-2 text-[12.5px] leading-[1.7] text-slate-700 transition placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10 disabled:opacity-60"
              />
            </div>

            <div className="rounded-[8px] border border-slate-100 bg-slate-50/70 px-2.5 py-2 text-[11.5px] leading-relaxed text-slate-500">
              模型上下文：
              {estimate.ctxKnown ? `${Math.round(nCtx / 1024)}K` : engine === 'public' ? '公共模型安全预算' : '未读到'} · 每段约{' '}
              {estimate.chunkChars} 字 · 约{' '}
              {estimate.chunks} 段 / {estimate.totalCalls} 次调用
              <span className="mt-0.5 block text-[11px] text-slate-400">
                将执行三轮：全文分段分析 → 仿写对照修订 → 再生成再分析。长文会明显耗时。
              </span>
            </div>

            {error && (
              <div className="flex items-start gap-1.5 rounded-[8px] border border-rose-200 bg-rose-50 px-2.5 py-2 text-[12px] leading-relaxed text-rose-600">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            )}

            <div className="flex items-center gap-2 border-t border-slate-100 pt-2.5">
              <span className="flex-1 text-[11px] leading-relaxed text-slate-400">
                {!source.trim() ? '先填入原文' : !direction.trim() ? '再填写分析方向' : '准备好后开始，可随时停止'}
              </span>
              <Button variant="primary" icon={<ScanText />} onClick={() => void run()} disabled={!canStart}>
                开始分析
              </Button>
            </div>
          </div>
        )}

        {busy && (
          <div className="space-y-3">
            <div className="rounded-[10px] border border-slate-100 p-2.5">
              <div className="flex items-center gap-1">
                {STEPS.map((s, i) => {
                  const active = (progress?.phase ?? 1) === s.phase;
                  const completed = (progress?.phase ?? 1) > s.phase;
                  return (
                    <div key={s.phase} className="flex min-w-0 flex-1 items-center gap-1">
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                          completed
                            ? 'bg-emerald-500 text-white'
                            : active
                              ? 'bg-brand-600 text-white'
                              : 'bg-slate-100 text-slate-400'
                        }`}
                      >
                        {completed ? <Check className="h-3 w-3" /> : s.phase}
                      </span>
                      <span className={`truncate text-[11.5px] ${active ? 'font-medium text-brand-700' : 'text-slate-500'}`}>
                        {s.label}
                      </span>
                      {i < STEPS.length - 1 && <span className="ml-0.5 h-px min-w-2 flex-1 bg-slate-200" />}
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-500 transition-all"
                  style={{ width: `${Math.min(100, ((progress?.done ?? 0) / Math.max(1, progress?.total ?? 1)) * 100).toFixed(1)}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-slate-500">
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-brand-500" />
                <span className="min-w-0 flex-1 truncate">{progress?.detail ?? '准备模型与分段…'}</span>
                <span className="shrink-0 tabular-nums text-slate-400">
                  {progress?.done ?? 0}/{progress?.total ?? 1}
                </span>
              </div>
            </div>

            {progress?.stream && (
              <div>
                <div className="mb-1 text-[11px] font-medium text-slate-400">当前输出</div>
                <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-[8px] border border-slate-100 bg-slate-50 px-2.5 py-2 text-[12px] leading-[1.7] text-slate-600">
                  {progress.stream}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <span className="flex-1 text-[11px] text-slate-400">
                全程约 {progress?.total ?? estimate.totalCalls} 次模型调用；停止后保留已完成阶段。
              </span>
              <Button variant="danger" icon={<Square className="fill-current" />} onClick={stop} disabled={status === 'stopping'} data-longtext-stop>
                {status === 'stopping' ? '停止中…' : '停止'}
              </Button>
            </div>
          </div>
        )}

        {resultView && (
          <div className="space-y-3">
            {status === 'error' || status === 'stopped' ? (
              <div
                className={`flex items-start gap-1.5 rounded-[8px] border px-2.5 py-2 text-[12px] leading-relaxed ${
                  status === 'stopped' ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-rose-200 bg-rose-50 text-rose-600'
                }`}
                data-longtext-status={status}
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {status === 'stopped' ? '已停止。已完成的阶段仍可在下方查看。' : error || '分析失败'}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-[8px] border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-[12px] text-emerald-700" data-longtext-status="done">
                <Check className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">三轮分析完成</span>
                {finalText && (
                  <Button size="sm" variant="ghost" icon={copied ? <Check /> : <Copy />} onClick={() => void copyResult()}>
                    {copied ? '已复制' : '复制结果'}
                  </Button>
                )}
              </div>
            )}

            {finalText && (
              <section data-longtext-result>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[12px] font-semibold text-slate-600">最终分析结果</span>
                  <span className="flex-1" />
                  {skillDraft && (
                    <Button
                      size="sm"
                      variant="soft"
                      icon={<Sparkles />}
                      onClick={saveSkill}
                      disabled={!!skillSaved}
                      data-longtext-save-skill
                    >
                      {skillSaved ? '已保存' : '保存为写作技能'}
                    </Button>
                  )}
                </div>
                <div className="whitespace-pre-wrap rounded-[10px] border border-slate-100 bg-slate-50/70 px-3 py-2.5 text-[12.5px] leading-[1.8] text-slate-700">
                  {finalText}
                </div>
                {skillSaved && (
                  <p
                    className="mt-1 flex items-start gap-1 text-[11.5px] text-emerald-600"
                    data-longtext-skill-saved
                  >
                    <Check className="mt-0.5 h-3 w-3 shrink-0" />
                    {skillSaved}
                  </p>
                )}
                {skillError && (
                  <p className="mt-1 flex items-start gap-1 text-[11.5px] text-rose-600" data-longtext-skill-error>
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    {skillError}
                  </p>
                )}
              </section>
            )}

            {showArtifacts && (
              <section>
                <div className="mb-1 text-[12px] font-semibold text-slate-600">中间阶段</div>
                <div className="space-y-1">
                  {ARTIFACT_ORDER.map((stage) => {
                    const text = artifacts[stage];
                    if (!text) return null;
                    return (
                      <details key={stage} className="rounded-[8px] border border-slate-100 bg-white px-2 py-1.5" data-longtext-artifact={stage}>
                        <summary className="cursor-pointer select-none text-[12px] text-slate-600">
                          {LONG_TEXT_STAGE_LABELS[stage]} · {text.length} 字
                        </summary>
                        <div className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-slate-100 pt-1.5 text-[12px] leading-[1.7] text-slate-600">
                          {text}
                        </div>
                      </details>
                    );
                  })}
                </div>
              </section>
            )}

            {(plan || stats) && (
              <div className="rounded-[8px] bg-slate-50 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500" data-longtext-stats>
                {plan && (
                  <>
                    原文分 {plan.chunks} 段 · 每段约 {plan.chunkChars} 字 · 预计 {plan.totalCalls} 次调用
                  </>
                )}
                {stats && (
                  <>
                    {plan ? ' · ' : ''}实际 {stats.calls} 次 · 输入 {stats.promptTokens} / 输出 {stats.completionTokens} tokens ·{' '}
                    {(stats.elapsedMs / 1000).toFixed(1)} 秒
                  </>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 border-t border-slate-100 pt-2.5">
              <Button size="sm" variant="soft" icon={<RotateCcw />} onClick={reset}>
                重新分析
              </Button>
              <span className="flex-1" />
              <Button size="sm" onClick={close}>
                关闭
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
