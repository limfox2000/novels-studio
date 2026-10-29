/** 📋 章节大纲管理器（v2.10b：章节竖列侧栏 + 阅读系统配色）。
 *  半页左侧浮层（右侧留给编辑室）：左侧章节竖列（状态点 绿=已生成/黄=已写需求/灰=空白），右侧阅读区
 *  （章名/📌本章需求/✨生成大纲/大纲阅读卡片）。配色沿用阅读器主题（readerThemes）
 *  的四档阅读主题（米黄/纸白/护眼/夜间），共用同一份偏好 nc2-reader-v1，头部小圆点可切换；
 *  大纲正文用宋体系衬线 + 宽行距，阅读优先。
 *  生成走 studioEngine.genChapterOutline：📜章节大纲规则 + 🎯全文目标 + 📚本章所属卷介绍（卷内各章统一方向，v2.17）+ 画布舞台 + 前情大纲 → 流式写入；
 *  章节大纲规则的编辑入口在本管理器内（📜 大纲规则，与全文规则分开各自编辑）；📚 卷的创建/编辑也在本管理器（📚 卷）。
 *  引擎/思考开关复用编辑室 ⚙ 设置；与编辑室共用全局生成互斥，关面板不中断生成。 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useStudioStore, volumeBoardId } from '../../stores/studioStore';
import { chapterBoardOf, findChapterRegion } from '../../stores/chapterRegions';
import { snapshotIssueText } from '../../stores/chapterSnapshots';
import { useEditorRoomStore } from '../../stores/editorRoomStore';
import { useUiStore } from '../../stores/uiStore';
import { DEFAULT_OUTLINE_RULES, genChapterOutline } from '../../engines/studioEngine';
import { useEditorialStore } from '../../stores/editorialStore';
import { stopGeneration } from '../../shared/generation';
import { READER_PREF_KEY, READER_THEMES } from './readerThemes';
import { useActiveChapterId } from './useActiveChapter';
import { beginChapterRegion } from './chapterRegionActions';
import { activateChapter } from './chapterSceneActions';
import { ChapterRosterPanel } from './ChapterRosterPanel';
import type { SimChapter } from '../../types/sim';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  ListTree,
  Loader2,
  Plus,
  RotateCcw,
  ScrollText,
  Sparkles,
  Square,
  SquareDashed,
  Trash2,
  X,
} from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Field, Input, Textarea } from '../ui/Field';

/** 极简排版：转义后仅渲染 **加粗**（大纲按行结构化渲染，无需完整 markdown） */
function fmt(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

/** 大纲阅读视图（阅读优先，衬线字体同正文阅读器）：## 小标题 / - 列表 / 普通段落 + **加粗** */
function OutlineView({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="reading space-y-2 text-[15px] leading-[1.9]">
      {lines.map((raw, i) => {
        const line = raw.trim();
        if (!line) return <div key={i} className="h-1.5" />;
        if (/^(#{1,3}\s*|■\s*)/.test(line)) {
          return (
            <h3
              key={i}
              className="mt-5 text-[16px] font-semibold first:mt-0"
              dangerouslySetInnerHTML={{ __html: fmt(line.replace(/^(#{1,3}\s*|■\s*)/, '')) }}
            />
          );
        }
        const bullet = line.match(/^([-•*]|\d+[.、)])\s*(.*)$/);
        if (bullet) {
          const ordered = /^\d/.test(bullet[1]);
          return (
            <div key={i} className="flex gap-2">
              {ordered ? (
                <span className="flex-shrink-0 opacity-70">{bullet[1]}</span>
              ) : (
                <span className="mt-[0.62em] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current opacity-30" />
              )}
              <span className="min-w-0 flex-1" dangerouslySetInnerHTML={{ __html: fmt(bullet[2]) }} />
            </div>
          );
        }
        return <p key={i} dangerouslySetInnerHTML={{ __html: fmt(line) }} />;
      })}
    </div>
  );
}

/** 章节状态点：绿=已生成大纲 / 黄=已写需求 / 灰=空白 */
function ChapterDot({ c }: { c: SimChapter }) {
  const state = c.outline.trim() ? 'emerald' : c.requirement.trim() ? 'amber' : 'slate';
  const tip = c.outline.trim() ? '已生成大纲' : c.requirement.trim() ? '已写需求，未生成' : '空白章节';
  return (
    <span
      className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
        state === 'emerald' ? 'bg-emerald-400' : state === 'amber' ? 'bg-amber-400' : 'bg-slate-300'
      }`}
      title={tip}
    />
  );
}

// ── 📜 章节大纲规则弹层（入口在本管理器内，与全文规则分开各自编辑） ──

function OutlineRulesDialog({ onClose }: { onClose: () => void }) {
  const outlineRules = useStudioStore((s) => s.outlineRules);
  return (
    <Dialog
      onClose={onClose}
      icon={<ScrollText />}
      title="章节大纲规则"
      subtitle="规定如何生成章节大纲的要求（结构/节奏/要素等），生成每一章大纲时严格遵守。与「全文规则」分开、各自独立编辑；随地图存档保存。"
      footer={
        <Button variant="primary" onClick={onClose}>
          完成
        </Button>
      }
    >
      <Field label="章节大纲规则" counter={`${outlineRules.length}/2000`}>
        <Textarea
          value={outlineRules}
          onChange={(e) => useStudioStore.getState().setOutlineRules(e.target.value)}
          maxLength={2000}
          rows={10}
          placeholder={`未设置时按默认结构生成：\n${DEFAULT_OUTLINE_RULES}`}
        />
      </Field>
    </Dialog>
  );
}

// ── 📚 卷管理弹层（v2.17：创建/编辑卷——卷介绍注入该卷各章的大纲生成，统一整卷方向） ──

export function VolumesDialog({ onClose }: { onClose: () => void }) {
  const volumes = useStudioStore((s) => s.volumes);
  const chapters = useStudioStore((s) => s.chapters);
  const boards = useStudioStore((s) => s.boards);
  return (
    <Dialog
      onClose={onClose}
      icon={<BookOpen />}
      title="卷管理"
      subtitle="每卷对应一张独立画布：把章节分卷（第 1~3 章都属于第一卷…），给每卷写一段介绍——生成该卷各章大纲时会注入卷介绍与该卷画布。章节归卷在阅读区的「卷」下拉选择。删除卷会一并删除它的画布与节点（章节回到未分卷）。随地图存档保存。"
      footer={
        <>
          <Button
            variant="soft"
            icon={<Plus />}
            onClick={() => void useStudioStore.getState().addVolume()}
            title="添加一卷（卷名自动「第N卷」，可改）"
          >
            添加卷
          </Button>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      {volumes.length === 0 && (
        <p className="rounded-[10px] border border-dashed border-slate-200 px-3 py-6 text-center text-[13px] text-slate-400">
          还没有卷——点「添加卷」创建第一卷
        </p>
      )}
      <div className="space-y-2">
        {volumes.map((v, i) => {
          const count = chapters.filter((c) => c.volumeId === v.id).length;
          const nodeCount = boards[volumeBoardId(v.id)]?.nodes.length ?? 0;
          const regionCount = boards[volumeBoardId(v.id)]?.regions.length ?? 0;
          return (
            <div key={v.id} className="rounded-[10px] border border-slate-200 bg-slate-50/60 p-2.5">
              <div className="mb-1.5 flex items-center gap-2">
                <Input
                  value={v.title}
                  maxLength={20}
                  onChange={(e) => useStudioStore.getState().updateVolume(v.id, { title: e.target.value })}
                  placeholder={`第${i + 1}卷`}
                  className="h-8 min-w-0 flex-1 font-semibold"
                />
                <span className="whitespace-nowrap text-[12px] text-slate-400">
                  {nodeCount} 节点 · {count} 章
                </span>
                <IconButton
                  icon={<Trash2 />}
                  title="删除本卷及其画布（卷内节点一并删除；章节回到未分卷，章节本身不删）"
                  onClick={() => {
                    const regionLine = regionCount > 0 ? `\n画布上的 ${regionCount} 个章节区域也会一并删除。` : '';
                    const msg =
                      nodeCount > 0
                        ? `删除「${v.title || '未命名卷'}」？\n将一并删除该卷画布及其中 ${nodeCount} 个节点，且不可恢复。${regionLine}\n卷内 ${count} 章将回到「未分卷」（章节本身不删）。`
                        : `删除「${v.title || '未命名卷'}」？${regionLine}\n卷内 ${count} 章将回到「未分卷」（章节本身不删）。`;
                    if (window.confirm(msg)) useStudioStore.getState().deleteVolume(v.id);
                  }}
                />
              </div>
              <Textarea
                value={v.intro}
                maxLength={300}
                rows={3}
                onChange={(e) => useStudioStore.getState().updateVolume(v.id, { intro: e.target.value })}
                placeholder={'卷介绍（这一卷讲什么、往哪个方向推进）\n例：主角被迫入门，从躺平摆烂到被迫小成，收束于第一次宗门大比'}
              />
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

export function OutlineManager({ onClose }: { onClose: () => void }) {
  const chapters = useStudioStore((s) => s.chapters);
  const volumes = useStudioStore((s) => s.volumes);
  const boards = useStudioStore((s) => s.boards);
  const busyId = useStudioStore((s) => s.outlineBusyId);
  const generating = useUiStore((s) => s.generating);
  const engine = useEditorRoomStore((s) => s.settings.engine);
  const hasOutlineRules = useStudioStore((s) => !!s.outlineRules.trim());
  // 📐 当前章节与正文管理器/画布区域高亮共用
  const selId = useActiveChapterId();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [volumesOpen, setVolumesOpen] = useState(false);
  // 推理耗尽 → 自动关闭推理重试的提示（仅本次生成有效）
  const [fallbackNotice, setFallbackNotice] = useState('');
  // 本次生成使用的舞台（快照/工作画布）与场景变化提示
  const [stageNotice, setStageNotice] = useState('');
  // 阅读系统配色：偏好存 nc2-reader-v1，默认米黄
  const [themeKey, setThemeKey] = useState('sepia');

  const selIdx = chapters.findIndex((c) => c.id === selId);
  const sel = selIdx >= 0 ? chapters[selIdx] : null;
  const isBusy = !!sel && busyId === sel.id;
  const t = READER_THEMES.find((x) => x.key === themeKey) ?? READER_THEMES[0];
  // 📚 当前章所属卷（v2.17）+ 卷速查表（侧栏徽标用；派生 Map 走 useMemo，§8.6 坑）
  const volById = useMemo(() => new Map(volumes.map((v) => [v.id, v])), [volumes]);
  const volOfSel = sel?.volumeId ? volById.get(sel.volumeId) : undefined;
  const selRegion = sel ? findChapterRegion(boards, sel.id) : null;

  // ✎ Ctrl+点画布人物节点 → 画布侧 dispatch，这里把人名以 [人名] 形式插进「本章需求」光标处（面板挂载才收得到，§8.8）。
  //  方括号标记画布人物（v2.14a 用户拍板）：原生 textarea 无法内嵌着色，用符号框住人名即可辨识；生成时 AI 也能看懂标记
  const reqRef = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef<number | null>(null);
  const trackCaret = () => {
    const ta = reqRef.current;
    if (ta) caretRef.current = ta.selectionStart;
  };
  useEffect(() => {
    const h = (ev: Event) => {
      const name = (ev as CustomEvent<string>).detail || '';
      const cur = useStudioStore.getState().chapters.find((c) => c.id === selId);
      if (!name || !cur) return;
      const ins = `[${name}]`;
      const text = cur.requirement;
      const pos = Math.min(caretRef.current ?? text.length, text.length);
      useStudioStore.getState().updateChapter(cur.id, { requirement: text.slice(0, pos) + ins + text.slice(pos) });
      caretRef.current = pos + ins.length;
      // 插完把光标还给输入框，接着打字
      requestAnimationFrame(() => {
        const ta = reqRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(pos + ins.length, pos + ins.length);
        }
      });
    };
    window.addEventListener('sim-insert-char-name', h);
    return () => window.removeEventListener('sim-insert-char-name', h);
  }, [selId]);

  // 挂载读一次阅读器偏好；其后变更即写回（font 字段属阅读器，原样保留）
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(READER_PREF_KEY) || '') as { theme?: string };
      if (p.theme && READER_THEMES.some((x) => x.key === p.theme)) setThemeKey(p.theme);
    } catch {
      /* 无偏好：沿用默认米黄 */
    }
  }, []);
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(READER_PREF_KEY) || '{}') as { font?: number };
      localStorage.setItem(READER_PREF_KEY, JSON.stringify({ theme: themeKey, font: p.font ?? 18 }));
    } catch {
      localStorage.setItem(READER_PREF_KEY, JSON.stringify({ theme: themeKey, font: 18 }));
    }
  }, [themeKey]);

  const addChapter = () => {
    const id = useStudioStore.getState().addChapter();
    activateChapter(id);
  };

  const removeChapter = (c: SimChapter) => {
    if (!window.confirm(`删除《${c.title || '未命名'}》？（其需求、大纲与章节区域一并删除）`)) return;
    const i = chapters.findIndex((x) => x.id === c.id);
    const next = chapters[i + 1] ?? chapters[i - 1] ?? null;
    useStudioStore.getState().deleteChapter(c.id);
    activateChapter(next?.id ?? null);
  };

  const changeVolume = (nextVolumeId: string) => {
    if (!sel) return;
    const st = useStudioStore.getState();
    const from = chapterBoardOf(sel.volumeId, volumes, boards);
    const to = chapterBoardOf(nextVolumeId, volumes, boards);
    if (selRegion && from !== to) {
      const ok = window.confirm('本章已绑定区域。更换所属卷会删除该区域（需在新画布重新绘制），继续？');
      if (!ok) return;
    }
    st.updateChapter(sel.id, { volumeId: nextVolumeId });
    // 换卷后章节画布变了：跟到新画布（同一章不回放，避免覆盖当前摆放）
    activateChapter(sel.id);
  };

  const openRegion = () => {
    if (!sel) return;
    const r = beginChapterRegion(sel.id);
    if (!r.ok) {
      window.alert(r.message);
      return;
    }
    onClose();
  };

  const gen = async () => {
    if (!sel || isBusy || generating) return;
    const st = useStudioStore.getState();
    const idx = st.chapters.findIndex((c) => c.id === sel.id);
    const latest = st.chapters[idx];
    const snap = latest?.snapshot;
    const snapBoard = snap ? st.boards[snap.boardId] : undefined;
    const staleText = snap
      ? snapshotIssueText(snap, snapBoard, snapBoard?.regions.find((r) => r.chapterId === sel.id), st.characters)
      : '';
    st.updateChapter(sel.id, { outline: '' });
    st.setOutlineBusy(sel.id);
    setFallbackNotice('');
    setStageNotice('');
    let lastFlush = 0;
    const { engine: eng, reasoningEffort } = useEditorRoomStore.getState().settings;
    // 🏛 作品责任编辑：注入其职责与「章节大纲规则」技能记忆（v2.21）
    const responsible = useEditorialStore.getState().getWorkResponsibleData('章节大纲规则');
    const r = await genChapterOutline({
      chapterId: sel.id,
      chapter: { title: sel.title, requirement: sel.requirement, volumeId: sel.volumeId },
      prevChapters: st.chapters.slice(Math.max(0, idx - 3), idx),
      engine: eng,
      reasoningEffort,
      ...(responsible ? { responsible } : {}),
      onFallback: setFallbackNotice,
      onDelta: (acc) => {
        const now = Date.now();
        if (now - lastFlush > 400) {
          lastFlush = now;
          useStudioStore.getState().updateChapter(sel.id, { outline: acc });
        }
      },
    });
    const s2 = useStudioStore.getState();
    s2.setOutlineBusy(null);
    if (r.ok && r.outline !== undefined) s2.updateChapter(sel.id, { outline: r.outline });
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

  // 阅读主题 → CSS 变量（子元素用任意值类取 --rd-card / --rd-btn / --rd-border / --rd-sub）
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
      {/* 头部：标题 + 引擎 + 配色圆点 + 📜 大纲规则 + 关闭 */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b bg-[var(--rd-card)] px-3 py-2" style={{ borderColor: t.border }}>
        <span className="flex items-center gap-1.5 whitespace-nowrap text-[14px] font-semibold">
          <ListTree className="h-4 w-4 opacity-70" />
          章节大纲
        </span>
        <span className="hidden whitespace-nowrap text-[12px] sm:inline" style={{ color: t.sub }}>
          {chapters.length} 章 · {engine === 'public' ? '公共模型' : '私有模型'}
        </span>
        <span className="flex-1" />
        {generating && (
          <span className="hidden items-center gap-1 whitespace-nowrap text-[12px] sm:flex" style={{ color: t.sub }}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            生成中
          </span>
        )}
        {fallbackNotice && (
          <span className="flex items-center gap-1 whitespace-nowrap text-[12px] text-amber-600" title={fallbackNotice}>
            ⚠ 已关闭推理重试
          </span>
        )}
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
        <button
          onClick={() => setVolumesOpen(true)}
          className={`flex items-center gap-1 whitespace-nowrap rounded-[8px] px-2 py-1 text-[12px] transition ${
            volumes.length ? '' : 'hover:bg-[var(--rd-btn)]'
          }`}
          style={volumes.length ? { background: t.accentSoft, color: t.accent } : { color: t.sub }}
          title="卷管理：把章节分卷并给每卷写介绍——生成该卷各章大纲时注入卷介绍，控制整卷方向、防止各章割裂"
        >
          <BookOpen className="h-3.5 w-3.5" />
          卷{volumes.length ? ` ${volumes.length}` : ''}
        </button>
        <button
          onClick={() => setRulesOpen(true)}
          className={`flex items-center gap-1 whitespace-nowrap rounded-[8px] px-2 py-1 text-[12px] transition ${
            hasOutlineRules ? '' : 'hover:bg-[var(--rd-btn)]'
          }`}
          style={hasOutlineRules ? { background: t.accentSoft, color: t.accent } : { color: t.sub }}
          title="章节大纲规则：如何生成章节大纲的要求（生成本页大纲时严格遵守；与全文规则分开编辑）"
        >
          <ScrollText className="h-3.5 w-3.5" />
          大纲规则
        </button>
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
                title={c.requirement.trim() || c.outline.trim() ? c.requirement.trim().slice(0, 60) || '已生成大纲' : '空白章节'}
              >
                <ChapterDot c={c} />
                {volById.get(c.volumeId) && (
                  <BookOpen
                    className="h-3 w-3 flex-shrink-0 opacity-60"
                    aria-label={`所属卷：${volById.get(c.volumeId)!.title || '未命名卷'}`}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {i + 1}. {c.title || '未命名'}
                </span>
                {busyId === c.id && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />}
              </button>
            ))}
          </div>
          <div className="p-2">
            <button
              onClick={addChapter}
              className="flex w-full items-center justify-center gap-1.5 rounded-[10px] py-2 text-[13px] font-medium transition hover:opacity-90"
              style={{ background: t.accent, color: t.accentInk }}
              title="添加章节"
            >
              <Plus className="h-4 w-4" />
              添加章节
            </button>
          </div>
        </div>

        {/* 右侧阅读区 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <div className="mx-auto w-full" style={{ maxWidth: '40em' }}>
          {sel ? (
            <>
              {/* 所属卷（v2.17）：本章归哪一卷——生成大纲时注入该卷的卷介绍，作为整卷统一方向 */}
              <div className="mb-2 flex min-w-0 items-center gap-2">
                <span className="flex items-center gap-1 whitespace-nowrap text-[12px] font-semibold" style={{ color: t.sub }}>
                  <BookOpen className="h-3.5 w-3.5" />
                  卷
                </span>
                <select
                  value={sel.volumeId}
                  onChange={(e) => changeVolume(e.target.value)}
                  className="rounded-[8px] border px-2 py-1 text-[12.5px] transition"
                  style={{ borderColor: t.border, background: t.card, color: t.text }}
                  title="本章所属卷：生成大纲时注入该卷的卷介绍，控制整卷方向（卷的创建/编辑在右上「卷」）"
                >
                  <option value="">未分卷</option>
                  {volumes.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.title || '未命名卷'}
                    </option>
                  ))}
                </select>
                {volOfSel && (
                  <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: t.sub }} title={volOfSel.intro.trim()}>
                    {volOfSel.intro.trim() || '（卷介绍未填写——点右上「卷」编辑）'}
                  </span>
                )}
                <button
                  type="button"
                  onClick={openRegion}
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[8px] border px-2 py-1 text-[12px] transition hover:opacity-80"
                  style={
                    selRegion
                      ? { background: t.accentSoft, color: t.accent, borderColor: t.border }
                      : { background: t.card, color: t.sub, borderColor: t.border }
                  }
                  title={
                    selRegion
                      ? '本章区域已绑定：点击切到所属画布并定位区域'
                      : '为本章绘制区域：在画布上拖出矩形，用于圈定本章的舞台范围'
                  }
                >
                  <SquareDashed className="h-3.5 w-3.5" />
                  {selRegion ? '区域已绑定' : '画区域'}
                </button>
              </div>
              {/* 章名（点题即改）+ 排序/删除 */}
              <div className="flex items-center gap-0.5">
                <input
                  value={sel.title}
                  onChange={(e) => useStudioStore.getState().updateChapter(sel.id, { title: e.target.value })}
                  maxLength={40}
                  placeholder="章节名"
                  className="min-w-0 flex-1 bg-transparent text-[18px] font-semibold placeholder:opacity-40 focus:outline-none"
                />
                <button
                  onClick={() => useStudioStore.getState().moveChapter(sel.id, -1)}
                  disabled={selIdx === 0}
                  className="flex-shrink-0 rounded-[8px] p-1.5 transition hover:bg-[var(--rd-btn)] disabled:opacity-30"
                  style={{ color: t.sub }}
                  title="上移"
                  aria-label="上移章节"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button
                  onClick={() => useStudioStore.getState().moveChapter(sel.id, 1)}
                  disabled={selIdx === chapters.length - 1}
                  className="flex-shrink-0 rounded-[8px] p-1.5 transition hover:bg-[var(--rd-btn)] disabled:opacity-30"
                  style={{ color: t.sub }}
                  title="下移"
                  aria-label="下移章节"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
                <button
                  onClick={() => removeChapter(sel)}
                  className="flex-shrink-0 rounded-[8px] p-1.5 transition hover:bg-rose-500/10 hover:text-rose-500"
                  style={{ color: t.sub }}
                  title="删除本章"
                  aria-label="删除本章"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {/* 本章需求（便签视觉上次于正文，随主题取色） */}
              <div className="mt-2.5 rounded-[10px] border px-3 py-2.5" style={{ borderColor: t.border, background: t.card }}>
                <div className="mb-1 text-[12px] font-semibold" style={{ color: t.sub }}>本章需求（大概方向，可留空）</div>
                <textarea
                  ref={reqRef}
                  value={sel.requirement}
                  onChange={(e) => useStudioStore.getState().updateChapter(sel.id, { requirement: e.target.value })}
                  onFocus={trackCaret}
                  onClick={trackCaret}
                  onKeyUp={trackCaret}
                  onBlur={trackCaret}
                  maxLength={2000}
                  rows={3}
                  placeholder="例：这时 [小军] 第一次躺平修炼成功……（Ctrl+点画布人物节点插入 [人名]）"
                  className="w-full resize-y bg-transparent text-[13.5px] leading-7 placeholder:opacity-40 focus:outline-none"
                />
              </div>
              {/* 🎭 本章名单 / 📸 快照（R2/R3） */}
              <ChapterRosterPanel chapter={sel} onRequestClose={onClose} />
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
                    disabled={generating}
                    className="flex items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13px] font-medium transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ background: t.accent, color: t.accentInk }}
                    title="按章节大纲规则 + 全文目标 + 所属卷介绍 + 画布舞台 + 前情生成本章大纲"
                  >
                    {sel.outline.trim() ? <RotateCcw className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {sel.outline.trim() ? '重新生成大纲' : '生成大纲'}
                  </button>
                )}
                {!hasOutlineRules && (
                  <span className="text-[12px] leading-relaxed" style={{ color: t.sub }}>
                    未设置「章节大纲规则」，将按默认结构生成（点右上「大纲规则」可自定义）
                  </span>
                )}
                {!isBusy && sel.outline.trim() && (
                  <span className="text-[12px] tabular-nums" style={{ color: t.sub }}>{sel.outline.length} 字</span>
                )}
              </div>
              {stageNotice && (
                <div className="mt-1.5 rounded-[8px] border border-amber-300/60 bg-amber-50/60 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber-800">
                  {stageNotice}
                </div>
              )}
              {/* 大纲正文（阅读视图，衬线+宽行距，随主题取色） */}
              <div className="mt-4">
                {sel.outline.trim() ? (
                  <OutlineView text={sel.outline} />
                ) : (
                  <div
                    className="rounded-[10px] border border-dashed px-4 py-6 text-center text-[13px] leading-relaxed"
                    style={{ borderColor: t.border, color: t.sub }}
                  >
                    还没有大纲——写好「本章需求」后点「生成大纲」。
                    <br />
                    生成会参考章节大纲规则、全文目标、所属卷介绍、画布上的环境/人物与前几章大纲，保持剧情连贯。
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-4 py-10">
              <div className="max-w-[26em] text-center">
                <ListTree className="mx-auto h-6 w-6 opacity-40" />
                <p className="mt-3 text-[13px] leading-relaxed" style={{ color: t.sub }}>
                  还没有章节。添加章节 → 写「本章需求」→ 按<b>章节大纲规则</b>生成大纲。
                  <br />
                  大纲会参考全文目标、所属卷介绍、画布舞台与前情大纲，保持剧情连贯。
                </p>
                <button
                  onClick={addChapter}
                  className="mx-auto mt-4 flex items-center gap-1.5 rounded-[10px] px-4 py-2 text-[13px] font-medium transition hover:opacity-90"
                  style={{ background: t.accent, color: t.accentInk }}
                >
                  <Plus className="h-4 w-4" />
                  添加第一章
                </button>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>

      {rulesOpen && <OutlineRulesDialog onClose={() => setRulesOpen(false)} />}
      {volumesOpen && <VolumesDialog onClose={() => setVolumesOpen(false)} />}
    </div>
  );
}
