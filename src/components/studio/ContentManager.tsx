/** 📝 正文管理器（v2.11：与大纲管理器同形态的半页浮层——左侧章节竖列 + 右侧阅读区，阅读系统配色）。
 *  硬门槛（用户拍板）：本章在「📋 大纲」中生成了大纲，本章的「生成正文」才可点击（无大纲禁用+提示）。
 *  生成走 studioEngine.genChapterContent：📜全文规则 + 本章大纲 + 画布舞台 + 前情正文 → 流式写入；
 *  ✨ 写作技能（v2.33）：左上角可选扩展包，按章启用 0–3 个，仅注入本章正文；管理入口/槽位保持轻量。
 *  写手引擎（🏠 私有 / 🌐 公共）在「模型中心」统一设置，存 editorRoomStore settings.contentEngine，这里只读显示。
 *  正文阅读视图：宋体衬线 + 段首缩进两字符 + 宽行距；
 *  配色沿用阅读器四档主题（与大纲管理器/正文阅读器共用 nc2-reader-v1 偏好互通）；
 *  与全局生成互斥共用，关面板不中断生成。 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useStudioStore } from '../../stores/studioStore';
import { findChapterRegion } from '../../stores/chapterRegions';
import { snapshotIssueText } from '../../stores/chapterSnapshots';
import { useEditorRoomStore } from '../../stores/editorRoomStore';
import { useUiStore } from '../../stores/uiStore';
import { genChapterContent } from '../../engines/studioEngine';
import { stopGeneration } from '../../shared/generation';
import { useEditorialStore } from '../../stores/editorialStore';
import { useWritingSkillStore } from '../../stores/writingSkillStore';
import { resolveWritingSkills } from '../../engines/writingSkills';
import { WritingSkillSlots } from './WritingSkillSlots';
import { READER_PREF_KEY, READER_THEMES } from './readerThemes';
import { useActiveChapterId } from './useActiveChapter';
import { activateChapter } from './chapterSceneActions';
import type { SimChapter } from '../../types/sim';
import { BookOpen, ChevronDown, ChevronRight, Cpu, FileText, Loader2, Minus, Plus, RotateCcw, Sparkles, Square, SquareDashed, X } from 'lucide-react';

/** 大纲速览（正文上方的参考折叠条）：## 小标题/列表/段落 简化渲染 + **加粗** */
function fmt(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

function OutlinePeek({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5 text-[13px] leading-[1.9]" style={{ color: 'var(--rd-sub)' }}>
      {lines.map((raw, i) => {
        const line = raw.trim();
        if (!line) return <div key={i} className="h-1" />;
        if (/^#{1,3}\s*/.test(line)) {
          return (
            <div key={i} className="font-semibold" dangerouslySetInnerHTML={{ __html: fmt(line.replace(/^#{1,3}\s*/, '')) }} />
          );
        }
        const bullet = line.match(/^([-•*]|\d+[.、)])\s*(.*)$/);
        return (
          <div key={i} className="flex gap-1.5">
            <span className="mt-[0.62em] h-1 w-1 flex-shrink-0 rounded-full bg-current opacity-40" />
            <span className="min-w-0 flex-1" dangerouslySetInnerHTML={{ __html: fmt(bullet ? bullet[2] : line) }} />
          </div>
        );
      })}
    </div>
  );
}

/** 正文阅读视图（阅读优先）：空行分段（段内单换行保留）+ 段首缩进两字符，衬线宽行距，限宽约 40 字 */
function ContentView({ text, fontSize }: { text: string; fontSize: number }) {
  const clean = text.replace(/\n\n⏹ 已停止（部分内容已保留）$/, '');
  // 生成结果有的以空行分段、有的只用一个换行：含空行按空行分段（段内换行按软换行保留），否则回退按单换行
  const soft = /\n{2,}/.test(clean);
  const paragraphs = (soft ? clean.split(/\n{2,}/) : clean.split(/\n+/))
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <div
      className="reading mx-auto w-full"
      style={{ maxWidth: '40em', fontSize, lineHeight: 1.95, letterSpacing: '0.015em' }}
    >
      {paragraphs.map((p, i) => (
        <p key={i} style={{ textIndent: '2em', margin: '0 0 0.95em', whiteSpace: soft ? 'pre-line' : undefined }}>
          {p}
        </p>
      ))}
    </div>
  );
}

/** 章节状态点（正文管理器）：绿=正文已生成 / 黄=有大纲可生成 / 灰=无大纲（生成不可点） */
function ChapterDot({ c }: { c: SimChapter }) {
  const state = c.content.trim() ? 'emerald' : c.outline.trim() ? 'amber' : 'slate';
  const tip = c.content.trim() ? '正文已生成' : c.outline.trim() ? '有大纲，可生成正文' : '无大纲（先去「大纲」生成）';
  return (
    <span
      className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
        state === 'emerald' ? 'bg-emerald-400' : state === 'amber' ? 'bg-amber-400' : 'bg-slate-300'
      }`}
      title={tip}
    />
  );
}

const ENGINE_LABEL: Record<'private' | 'public', string> = { private: '私有模型', public: '公共模型' };

const MIN_FONT = 15;
const MAX_FONT = 22;

/** 读阅读器偏好（nc2-reader-v1）：字号 15–22，缺省 18 */
function readReaderPref(): { theme: string; font: number } {
  try {
    const p = JSON.parse(localStorage.getItem(READER_PREF_KEY) || '{}') as { theme?: string; font?: number };
    return {
      theme: p.theme && READER_THEMES.some((x) => x.key === p.theme) ? p.theme : 'sepia',
      font: Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(p.font ?? 18))),
    };
  } catch {
    return { theme: 'sepia', font: 18 };
  }
}

export function ContentManager({ onClose }: { onClose: () => void }) {
  const chapters = useStudioStore((s) => s.chapters);
  const boards = useStudioStore((s) => s.boards);
  const busyId = useStudioStore((s) => s.contentBusyId);
  const generating = useUiStore((s) => s.generating);
  const contentEngine = useEditorRoomStore((s) => s.settings.contentEngine);
  // 📐 当前章节与大纲管理器/画布区域高亮共用
  const selId = useActiveChapterId();
  const [peekOpen, setPeekOpen] = useState(false);
  const [stageNotice, setStageNotice] = useState('');
  // 阅读系统配色/字号：与正文阅读器/大纲管理器共用偏好（nc2-reader-v1），默认米黄 + 18px
  const [initialPref] = useState(readReaderPref);
  const [themeKey, setThemeKey] = useState(initialPref.theme);
  const [fontSize, setFontSize] = useState(initialPref.font);

  const selIdx = chapters.findIndex((c) => c.id === selId);
  const sel = selIdx >= 0 ? chapters[selIdx] : null;
  const selRegion = sel ? findChapterRegion(boards, sel.id) : null;
  const isBusy = !!sel && busyId === sel.id;
  // 硬门槛：本章大纲已生成 → 生成正文才可点击
  const canGen = !!sel && !!sel.outline.trim();
  const t = READER_THEMES.find((x) => x.key === themeKey) ?? READER_THEMES[0];

  // 主题/字号变更写回偏好（与正文阅读器、大纲管理器互通）
  useEffect(() => {
    try {
      localStorage.setItem(READER_PREF_KEY, JSON.stringify({ theme: themeKey, font: fontSize }));
    } catch {
      /* 隐私模式写不进去：本次会话内照常生效 */
    }
  }, [themeKey, fontSize]);

  const gen = async () => {
    if (!sel || !canGen || isBusy || generating) return;
    const st = useStudioStore.getState();
    const idx = st.chapters.findIndex((c) => c.id === sel.id);
    const latest = st.chapters[idx];
    const snap = latest?.snapshot;
    const snapBoard = snap ? st.boards[snap.boardId] : undefined;
    const staleText = snap
      ? snapshotIssueText(snap, snapBoard, snapBoard?.regions.find((r) => r.chapterId === sel.id))
      : '';
    st.updateChapter(sel.id, { content: '' });
    st.setContentBusy(sel.id);
    setPeekOpen(false);
    setStageNotice('');
    let lastFlush = 0;
    const engine = useEditorRoomStore.getState().settings.contentEngine;
    // 🏛 作品责任编辑：注入其职责与「正文生成」技能记忆（v2.21）
    const responsible = useEditorialStore.getState().getWorkResponsibleData('正文生成');
    // ✨ 写作技能（v2.33）：按本章槽位从全局技能库解析；生成开始即固定，生成中改槽位只影响下一次
    const writingSkills = resolveWritingSkills(
      latest?.writingSkillIds ?? [],
      useWritingSkillStore.getState().skills,
    );
    const r = await genChapterContent({
      chapterId: sel.id,
      chapter: { title: sel.title, requirement: sel.requirement, outline: sel.outline, volumeId: sel.volumeId },
      prevChapters: st.chapters.slice(Math.max(0, idx - 3), idx),
      engine,
      ...(responsible ? { responsible } : {}),
      ...(writingSkills.length ? { writingSkills } : {}),
      onDelta: (acc) => {
        const now = Date.now();
        if (now - lastFlush > 400) {
          lastFlush = now;
          useStudioStore.getState().updateChapter(sel.id, { content: acc });
        }
      },
    });
    const s2 = useStudioStore.getState();
    s2.setContentBusy(null);
    if (r.ok && r.content !== undefined) s2.updateChapter(sel.id, { content: r.content });
    else if (r.error && r.error !== '已停止') window.alert(`❌ 生成失败：${r.error}`);
    const notes: string[] = [];
    if (staleText) notes.push(`本章场景有变化（${staleText}）；本次仍按快照生成，缺失处不会猜测补全`);
    if (r.ok && r.stage) {
      if (r.stage.capturedNow) notes.push('已自动记录本章场景，后续生成将按区域名单约束');
      else if (r.stage.mode === 'legacy') notes.push('本章未记录快照，本次使用工作画布全部资料');
      for (const w of r.stage.warnings) if (!notes.some((n) => n.includes(w))) notes.push(w);
    }
    if (notes.length) setStageNotice(notes.join('；'));
  };

  // 阅读主题 → CSS 变量（子元素 Tailwind 任意值类取色）
  const themed = {
    background: t.bg,
    color: t.text,
    '--rd-card': t.card,
    '--rd-btn': t.btn,
    '--rd-btn-hover': t.btnHover,
    '--rd-border': t.border,
    '--rd-sub': t.sub,
    '--rd-accent': t.accent,
    '--rd-accent-soft': t.accentSoft,
    '--rd-accent-ink': t.accentInk,
    '--rd-scroll': t.scroll,
  } as CSSProperties;

  return (
    /* 半页左侧浮层（桌面 clamp 560~760px 宽，右侧留给编辑室）；手机端近全屏浮层 */
    <div
      className="fixed bottom-2 left-2 right-2 top-[calc(var(--topbar-h)+10px)] z-40 flex flex-col overflow-hidden rounded-[16px] border border-slate-200/80 shadow-panel sm:bottom-4 sm:right-auto sm:w-[clamp(640px,60vw,880px)]"
      style={themed}
    >
      {/* 头部：标题 + 写作技能（左上角，空时收起） + 引擎/配色/字号 + 关闭 */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b bg-[var(--rd-card)] px-3 py-2" style={{ borderColor: t.border }}>
        <span className="flex items-center gap-1.5 whitespace-nowrap text-[14px] font-semibold">
          <FileText className="h-4 w-4 opacity-70" />
          正文
        </span>
        <span className="hidden whitespace-nowrap text-[12px] sm:inline" style={{ color: t.sub }}>
          {chapters.reduce((a, c) => a + (c.content.trim() ? 1 : 0), 0)}/{chapters.length} 章成文
        </span>
        {sel && <WritingSkillSlots chapter={sel} />}
        <span className="flex-1" />
        {generating && (
          <span className="hidden items-center gap-1 whitespace-nowrap text-[12px] sm:flex" style={{ color: t.sub }}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            生成中
          </span>
        )}
        {/* 写手引擎在「模型中心」设置（v2.27），这里只给入口与当前引擎提示 */}
        <button
          onClick={() => useUiStore.getState().setModelCenterOpen(true)}
          title={`写手引擎：${ENGINE_LABEL[contentEngine]}（在模型中心修改）`}
          className="flex items-center gap-1 whitespace-nowrap rounded-[8px] border px-2 py-1 text-[12px] transition hover:opacity-80"
          style={{ borderColor: t.border, background: t.btn, color: t.text }}
        >
          <Cpu className="h-3.5 w-3.5 opacity-70" />
          模型中心
        </button>
        {/* 阅读配色（与正文阅读器互通） */}
        <span className="flex items-center gap-1">
          {READER_THEMES.map((th) => (
            <button
              key={th.key}
              onClick={() => setThemeKey(th.key)}
              title={`配色：${th.label}（与正文阅读器互通）`}
              aria-label={`配色：${th.label}`}
              className={`h-4 w-4 rounded-full border transition ${themeKey === th.key ? 'scale-110' : 'opacity-70 hover:opacity-100'}`}
              style={{ background: th.bg, borderColor: themeKey === th.key ? t.text : t.border }}
            />
          ))}
        </span>
        {/* 正文字号 A− / A+（写回阅读器偏好，与正文阅读器互通） */}
        <span className="flex items-center rounded-[8px]" style={{ background: t.btn }}>
          <button
            onClick={() => setFontSize((f) => Math.max(MIN_FONT, f - 1))}
            disabled={fontSize <= MIN_FONT}
            className="rounded-[8px] p-1 transition hover:bg-[var(--rd-btn-hover)] disabled:opacity-30"
            style={{ color: t.sub }}
            title="缩小正文字号"
            aria-label="缩小正文字号"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="w-5 text-center text-[11px] tabular-nums" style={{ color: t.sub }}>{fontSize}</span>
          <button
            onClick={() => setFontSize((f) => Math.min(MAX_FONT, f + 1))}
            disabled={fontSize >= MAX_FONT}
            className="rounded-[8px] p-1 transition hover:bg-[var(--rd-btn-hover)] disabled:opacity-30"
            style={{ color: t.sub }}
            title="放大正文字号"
            aria-label="放大正文字号"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </span>
        <button
          onClick={onClose}
          className="rounded-[8px] p-1 opacity-70 transition hover:bg-[var(--rd-btn)] hover:opacity-100"
          style={{ color: t.sub }}
          title="收起（生成继续）"
          aria-label="收起面板"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左侧章节竖列 */}
        <div className="flex w-[112px] flex-shrink-0 flex-col border-r bg-[var(--rd-card)] sm:w-[168px]" style={{ borderColor: t.border }}>
          <div className="px-3 pb-1 pt-3 text-[11px] font-semibold tracking-[0.14em]" style={{ color: t.sub }}>
            章节
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-1">
            {chapters.map((c, i) => (
              <button
                key={c.id}
                onClick={() => activateChapter(c.id)}
                className={`flex w-full items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-left text-[12.5px] transition ${
                  c.id === selId ? 'font-semibold' : 'hover:bg-[var(--rd-btn-hover)]'
                }`}
                style={c.id === selId ? { background: t.accentSoft, color: t.accent } : { color: t.sub }}
                title={c.content.trim() ? '正文已生成' : c.outline.trim() ? '有大纲，可生成正文' : '无大纲（先去「大纲」生成）'}
              >
                <ChapterDot c={c} />
                <span className="min-w-0 flex-1 truncate">
                  {i + 1}. {c.title || '未命名'}
                </span>
                {busyId === c.id && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />}
              </button>
            ))}
            {!chapters.length && (
              <div className="px-2 py-3 text-[12px] leading-relaxed" style={{ color: t.sub }}>
                还没有章节——先到「大纲」添加章节并生成大纲。
              </div>
            )}
          </div>
        </div>

        {/* 右侧阅读区 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <div className="mx-auto w-full" style={{ maxWidth: '40em' }}>
          {sel ? (
            <>
              {/* 章名（展示，编辑在大纲管理器） */}
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[18px] font-semibold">{sel.title || '未命名'}</span>
                {selRegion && (
                  <span
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[11px]"
                    style={{ borderColor: t.border, color: t.sub }}
                    title="本章已在画布上绑定区域（在大纲面板可定位或重画）"
                  >
                    <SquareDashed className="h-3 w-3" />
                    区域已绑定
                  </span>
                )}
                {!isBusy && sel.content.trim() && (
                  <span className="whitespace-nowrap text-[12px] tabular-nums" style={{ color: t.sub }}>{sel.content.length} 字</span>
                )}
              </div>
              {/* 本章大纲速览（折叠条：正文生成的依据；有大纲才显示） */}
              {sel.outline.trim() ? (
                <div className="mt-2.5 rounded-[10px] border" style={{ borderColor: t.border, background: t.card }}>
                  <button
                    onClick={() => setPeekOpen((v) => !v)}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] font-semibold"
                    style={{ color: t.sub }}
                    title="本章大纲（正文按此展开）"
                  >
                    {peekOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    <BookOpen className="h-3.5 w-3.5 opacity-70" />
                    本章大纲（{sel.outline.length} 字）
                    <span className="flex-1" />
                    <span className="text-[12px] font-normal opacity-70">正文生成依据</span>
                  </button>
                  {peekOpen && (
                    <div className="max-h-56 overflow-y-auto border-t px-3 py-2.5" style={{ borderColor: t.border }}>
                      <OutlinePeek text={sel.outline} />
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-2.5 rounded-[10px] border border-dashed px-3 py-2 text-[12.5px] leading-relaxed" style={{ borderColor: t.border, color: t.sub }}>
                  本章还没有大纲——正文生成的依据是大纲，请先到「大纲」为本章生成大纲。
                </div>
              )}
              {/* 本章名单不在正文生成面板展示：场景仍随画布自动同步，生成时按快照约束 */}
              {/* 生成行 */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {isBusy ? (
                  <button
                    onClick={stopGeneration}
                    className="flex items-center gap-1.5 rounded-[10px] bg-rose-500 px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-rose-600"
                    title="停止生成（保留已生成部分）"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                    停止
                  </button>
                ) : (
                  <button
                    onClick={() => void gen()}
                    disabled={!canGen || generating}
                    className="flex items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13px] font-medium transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ background: t.accent, color: t.accentInk }}
                    title={canGen ? '按本章大纲 + 全文规则 + 画布舞台 + 前情写正文' : '本章大纲未生成——先到「大纲」生成大纲后才能写正文'}
                  >
                    {sel.content.trim() ? <RotateCcw className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {sel.content.trim() ? '重新生成正文' : '生成正文'}
                  </button>
                )}
                {!canGen && !isBusy && (
                  <span className="text-[12px] leading-relaxed" style={{ color: t.sub }}>
                    生成正文前需先有本章大纲（去「大纲」生成）
                  </span>
                )}
                {canGen && !isBusy && !sel.content.trim() && (
                  <span className="text-[12px]" style={{ color: t.sub }}>按本章大纲写正文，{ENGINE_LABEL[contentEngine]}执笔</span>
                )}
              </div>
              {stageNotice && (
                <div className="mt-1.5 rounded-[8px] border border-amber-300/60 bg-amber-50/60 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber-800">
                  {stageNotice}
                </div>
              )}
              {/* 作品责编在顶栏选择（v2.21）：生成正文时注入其职责与「正文生成」技能记忆 */}
              {/* 正文阅读视图 */}
              <div className="mt-4">
                {sel.content.trim() ? (
                  <ContentView text={sel.content} fontSize={fontSize} />
                ) : (
                  <div
                    className="rounded-[10px] border border-dashed px-4 py-6 text-center text-[13px] leading-relaxed"
                    style={{ borderColor: t.border, color: t.sub }}
                  >
                    {sel.outline.trim()
                      ? '本章还没有正文——点「生成正文」，AI 按本章大纲把剧情展开成小说正文。'
                      : '先到「大纲」为本章生成大纲，这里才能生成正文。'}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-4 py-10">
              <div className="max-w-[26em] text-center">
                <FileText className="mx-auto h-6 w-6 opacity-40" />
                <p className="mt-3 text-[13px] leading-relaxed" style={{ color: t.sub }}>
                  还没有章节。流程：<b>在「大纲」添加章节并生成大纲</b> → 回到这里按大纲生成正文。
                  <br />
                  正文按本章大纲展开，参考全文规则、画布舞台与前情正文，保持剧情连贯。
                </p>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
