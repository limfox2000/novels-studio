/**
 * 作品书架（着陆视图）：进创作台先见书架，「打开 / 返回首页」也回到这里。
 * 横向书封带：当前画布（或同名存档高亮「当前」）+ 本机存档（新→旧）+ ＋新建。
 * 纯本机（nc2-sim-archives-v1）；封面随作品/存档保存（v2.28），未设置时按书名 hash 着色占位。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, Download, LibraryBig, Plus, Upload, X } from 'lucide-react';
import {
  useStudioStore,
  DEFAULT_BOARD_ID,
  emptyBoard,
  hasUnsavedStudioChanges,
  saveStudioWorkspace,
} from '../../stores/studioStore';
import {
  archiveResultSummary,
  deleteLocalArchive,
  exportLocalArchive,
  importLocalArchive,
  listLocalArchives,
  loadLocalArchive,
} from '../../services/studioSync';
import { bookHue } from '../../services/bookCover';
import { useUiStore } from '../../stores/uiStore';
import { persistActiveChapterId } from '../../stores/activeChapter';
import { IconButton } from '../ui/IconButton';

function BookCard({
  name,
  subtitle,
  cover,
  current,
  hue,
  onOpen,
  onDelete,
}: {
  name: string;
  subtitle: string;
  cover?: string;
  current?: boolean;
  hue: number;
  onOpen: () => void;
  onDelete?: (e: MouseEvent) => void;
}) {
  const act = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onOpen();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={act}
      title={name}
      className="group w-[132px] shrink-0 cursor-pointer snap-center text-left focus:outline-none"
    >
      <div
        className="relative aspect-[5/7] overflow-hidden rounded-[8px] border border-white/70 shadow-float transition-all duration-200 group-hover:-translate-y-1 group-hover:shadow-panel group-focus-visible:ring-4 group-focus-visible:ring-brand-500/20"
        style={{ background: `linear-gradient(155deg, hsl(${hue} 42% 90%), hsl(${hue} 38% 76%))` }}
      >
        {cover ? (
          <img src={cover} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-slate-500/70">
            <BookOpen className="h-6 w-6" strokeWidth={1.75} />
            <span className="text-[11px]">未设置封面</span>
          </div>
        )}
        <div
          className="absolute inset-y-0 left-0 w-1.5"
          style={{ background: cover ? 'rgba(0,0,0,0.18)' : `hsl(${hue} 30% 62%)` }}
        />
        {current && <span className="absolute left-1.5 top-1.5 rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] leading-none text-white">当前</span>}
        {onDelete && (
          <button
            onClick={onDelete}
            title="删除此存档"
            aria-label={`删除存档 ${name}`}
            className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-rose-500/90 text-white hover:bg-rose-600 group-hover:flex group-focus-within:flex"
          >
            <X className="h-3 w-3" strokeWidth={2} />
          </button>
        )}
      </div>
      <p className="mt-2 truncate text-[13px] font-medium text-slate-700 group-hover:text-brand-700">{name}</p>
      <p className="text-[11px] text-slate-400">{subtitle}</p>
    </div>
  );
}

function NewCard({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} title="新建空白创作台" className="group w-[132px] shrink-0 cursor-pointer snap-center text-left focus:outline-none">
      <div className="flex aspect-[5/7] flex-col items-center justify-center gap-1.5 rounded-[8px] border-2 border-dashed border-slate-300 text-slate-400 transition-colors duration-200 group-hover:border-brand-400 group-hover:bg-brand-50/40 group-hover:text-brand-600">
        <Plus className="h-6 w-6" strokeWidth={1.75} />
        <span className="text-[11px]">新建作品</span>
      </div>
      <p className="mt-2 text-[13px] font-medium text-slate-400 group-hover:text-brand-700">从空白开始</p>
    </button>
  );
}

export function Bookshelf({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState(() => listLocalArchives());
  const graphName = useStudioStore((s) => s.graphName);
  const liveCover = useStudioStore((s) => s.cover);
  // 书架节点数 = 全部画布合计（默认主画布 + 各卷）
  const nodeCount = useStudioStore((s) => Object.values(s.boards).reduce((n, b) => n + b.nodes.length, 0));
  const rowRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [overflow, setOverflow] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });

  const hasLive = nodeCount > 0 || graphName !== '未命名';
  const liveIsArchive = hasLive && items.some((a) => a.name === graphName);

  const updateArrows = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    setOverflow({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  }, []);
  useEffect(() => {
    updateArrows();
    window.addEventListener('resize', updateArrows);
    return () => window.removeEventListener('resize', updateArrows);
  }, [items, updateArrows]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const scrollByPage = (dir: 1 | -1) => {
    const el = rowRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  // 行为镜像原「打开/新建」按钮：确认文案一致；载入失败（快照损坏）不关书架
  const openArchive = (name: string) => {
    const dirty = hasUnsavedStudioChanges();
    const tip = dirty
      ? '载入将替换当前画布内容，当前未保存的改动会丢失，确定？'
      : '载入将替换当前画布内容（当前内容已在本机留存），确定？';
    if ((nodeCount > 1 || dirty) && !window.confirm(tip)) return;
    const r = loadLocalArchive(name);
    if (!r.ok) {
      window.alert(r.error || `❌ 载入「${name}」失败。`);
      return;
    }
    const summary = archiveResultSummary(r);
    if (summary) window.alert(`已载入「${name}」（v${r.fromVersion} → v${r.fromVersion >= 3 ? r.fromVersion : 3}）\n\n${summary}`);
    onClose();
  };

  const exportCurrent = () => {
    if (!items.some((a) => a.name === graphName)) {
      window.alert('当前作品还没有命名存档。先点顶栏「保存」再导出。');
      return;
    }
    if (hasUnsavedStudioChanges() && !window.confirm('当前有未保存改动，导出的将是上次保存的存档。仍要导出？')) return;
    const r = exportLocalArchive(graphName);
    if (!r.ok) {
      window.alert(`导出失败：${r.error}`);
      return;
    }
    const blob = new Blob([r.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${graphName.replace(/[\\/:*?"<>|]/g, '_') || 'novels-canvas'}.novels-canvas.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    let r = importLocalArchive(text, file.name);
    if (r.conflict) {
      if (!window.confirm(`本地已有同名存档「${r.name}」。覆盖该存档？`)) return;
      r = importLocalArchive(text, file.name, { overwrite: true });
    }
    if (!r.ok) {
      window.alert(`导入失败：${r.error || '未知错误'}（现有存档未改动）`);
      return;
    }
    setItems(listLocalArchives());
    const summary = archiveResultSummary(r);
    window.alert(`已导入存档「${r.name}」到书架。${summary ? '\n\n' + summary : ''}`);
  };
  const startNewWork = () => {
    // replaceState 是合并语义：全字段显式清空（同顶栏「新建」）
    const dirty = hasUnsavedStudioChanges();
    const tip = dirty
      ? '清空当前创作台画布，重新开始？当前未保存的改动会丢失。'
      : '清空当前创作台画布，重新开始？（当前内容已在本机留存）';
    if ((nodeCount > 0 || dirty) && !window.confirm(tip)) return;
    useStudioStore.getState().replaceState({
      boards: { [DEFAULT_BOARD_ID]: emptyBoard(DEFAULT_BOARD_ID) },
      activeBoardId: DEFAULT_BOARD_ID,
      rules: '',
      outlineRules: '',
      charGenRules: '',
      mainGoal: '',
      volumes: [],
      chapters: [],
      responsibleId: '',
      cover: '',
    });
    useStudioStore.getState().setGraphName('未命名');
    useUiStore.getState().setActiveChapterId(null);
    persistActiveChapterId(null);
    // 新建是显式操作：立即把空白作品写为本机当前进度，避免刷新后回到旧作品
    if (!saveStudioWorkspace()) window.alert('⚠ 空白作品暂未写入本机，请检查浏览器存储空间后手动保存。');
    onClose();
  };
  const removeArchive = (e: MouseEvent, name: string) => {
    e.stopPropagation();
    if (window.confirm(`删除存档「${name}」？不可恢复`)) {
      deleteLocalArchive(name);
      setItems(listLocalArchives());
    }
  };

  return (
    <div className="nv-in fixed inset-0 z-40 flex flex-col bg-gradient-to-b from-slate-50 via-white to-slate-100">
      <header className="flex items-center gap-2.5 px-4 pt-4 sm:px-8 sm:pt-6">
        <span className="text-brand-600">
          <LibraryBig className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <div>
          <h1 className="text-[15px] font-semibold text-slate-800">作品书架</h1>
          <p className="text-[12px] text-slate-500">创作内容只保存在本机浏览器、不上传服务器；关闭前请点顶栏「保存」</p>
        </div>
        <span className="flex-1" />
        <button
          onClick={exportCurrent}
          title="把当前作品的命名存档导出为 v3 JSON 文件"
          className="flex items-center gap-1 rounded-[8px] border border-slate-200 bg-white/80 px-2.5 py-1.5 text-[12px] text-slate-600 transition hover:bg-white hover:text-slate-800"
        >
          <Download className="h-3.5 w-3.5" />
          导出当前存档
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          title="从 JSON 文件导入存档（校验后保存到书架，不覆盖当前作品）"
          className="flex items-center gap-1 rounded-[8px] border border-slate-200 bg-white/80 px-2.5 py-1.5 text-[12px] text-slate-600 transition hover:bg-white hover:text-slate-800"
        >
          <Upload className="h-3.5 w-3.5" />
          导入存档
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.novels-canvas,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importFile(f);
          }}
        />
        <IconButton icon={<X />} title="关闭书架，返回画布" onClick={onClose} />
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center px-4">
        <div className="relative w-full max-w-6xl">
          {overflow.left && (
            <button
              onClick={() => scrollByPage(-1)}
              title="向左翻页"
              className="absolute -left-1 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/90 text-slate-500 shadow-float transition hover:text-slate-800"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
          {overflow.right && (
            <button
              onClick={() => scrollByPage(1)}
              title="向右翻页"
              className="absolute -right-1 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/90 text-slate-500 shadow-float transition hover:text-slate-800"
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
          <div
            ref={rowRef}
            onScroll={updateArrows}
            className="flex items-start gap-5 overflow-x-auto px-12 py-10 snap-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {!liveIsArchive && hasLive && (
              <BookCard name={graphName} subtitle={`当前画布 · ${nodeCount} 节点`} cover={liveCover || undefined} hue={230} onOpen={onClose} />
            )}
            {items.map((a) => {
              // 当前作品对应的存档卡显示实时封面（含刚移除的空值），其余存档显示各自快照封面
              const isCurrent = liveIsArchive && a.name === graphName;
              return (
                <BookCard
                  key={a.name}
                  name={a.name}
                  subtitle={new Date(a.savedAt).toLocaleDateString()}
                  cover={isCurrent ? liveCover || undefined : a.cover}
                  current={isCurrent}
                  hue={bookHue(a.name)}
                  onOpen={() => openArchive(a.name)}
                  onDelete={(e) => removeArchive(e, a.name)}
                />
              );
            })}
            <NewCard onClick={startNewWork} />
            {items.length === 0 && !hasLive && (
              <p className="self-center whitespace-nowrap pl-2 text-[13px] text-slate-400">书架还是空的——点「＋」开始第一部作品</p>
            )}
          </div>
        </div>
      </main>

      <footer className="pb-5 text-center text-[12px] text-slate-400">点击书封继续创作 · 「＋」新建作品</footer>
    </div>
  );
}
