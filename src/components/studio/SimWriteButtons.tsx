/** 📎 写入按钮行（编辑室对话与会议纪要共用）：点击确认后才改写 studioStore；字段内容与草稿一致时显示已写入。
 *  章节需求/本章大纲按章节标题定位（标题重名时不写，避免写错章）；同一回复多章需求可一键全部写入。 */
import { useStudioStore } from '../../stores/studioStore';
import { WRITE_TARGETS, type SimWriteBlock, type WriteField } from '../../engines/studioEngine';
import type { SimChapter } from '../../types/sim';
import { AlertTriangle, Check, Layers, PenLine } from 'lucide-react';

const CHAPTER_FIELD = 'chapterRequirement';

/** 全局文本字段窄化守卫（章节需求/本章大纲按章节定位，不走 studioStore 字段索引） */
function isTextField(f: WriteField): f is 'mainGoal' | 'rules' | 'outlineRules' | 'charGenRules' {
  return f === 'mainGoal' || f === 'rules' || f === 'outlineRules' || f === 'charGenRules';
}

function findChapter(chapters: SimChapter[], title: string | undefined): SimChapter | undefined {
  if (!title) return undefined;
  const hits = chapters.filter((c) => c.title === title);
  return hits.length === 1 ? hits[0] : undefined;
}

/** 章节定位写入（章节需求 / 本章大纲）：按标题唯一定位后覆盖对应字段 */
function chapterPatch(w: SimWriteBlock): Partial<Pick<SimChapter, 'requirement' | 'outline'>> {
  return w.field === CHAPTER_FIELD ? { requirement: w.text } : { outline: w.text };
}

function chapterWord(w: SimWriteBlock): string {
  return w.field === CHAPTER_FIELD ? '需求' : '大纲';
}

function WriteButton({ w }: { w: SimWriteBlock }) {
  const chapters = useStudioStore((s) => s.chapters);
  const chapterTargeted = w.field === CHAPTER_FIELD || w.field === 'chapterOutline';
  const general = useStudioStore((s) => (isTextField(w.field) ? s[w.field] : ''));
  const meta = WRITE_TARGETS[w.field];

  if (chapterTargeted) {
    const chapter = findChapter(chapters, w.chapter);
    const dup = chapters.filter((c) => c.title === w.chapter).length > 1;
    const word = chapterWord(w);
    const cur = chapter ? chapter[w.field === CHAPTER_FIELD ? 'requirement' : 'outline'].trim() : '';
    const label = `《${w.chapter ?? ''}》${word}`;
    const isDone = !!chapter && cur === w.text.trim();
    const apply = () => {
      if (!chapter) return;
      if (cur && !window.confirm(`覆盖《${chapter.title}》的章节${word}？\n（原内容将被替换）`)) return;
      useStudioStore.getState().updateChapter(chapter.id, chapterPatch(w));
    };
    const reason = dup ? '有同名章节，请先改名' : '未找到该章节';
    return (
      <button
        onClick={apply}
        disabled={isDone || !chapter}
        title={!chapter ? reason : w.over ? `原文超过上限，已截断至 ${meta.cap} 字` : `写入${label}（会覆盖现有内容）`}
        className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {!chapter ? (
          <>
            <AlertTriangle className="h-3.5 w-3.5" />
            {label}：{reason}
          </>
        ) : isDone ? (
          <>
            <Check className="h-3.5 w-3.5" />
            已写入「{label}」
          </>
        ) : (
          <>
            <PenLine className="h-3.5 w-3.5" />
            写入「{label}」（{w.text.length} 字{w.over ? '，已截断' : ''}）
          </>
        )}
      </button>
    );
  }

  const isDone = general.trim() === w.text.trim();
  const apply = () => {
    if (!isTextField(w.field)) return;
    const setter = WRITE_TARGETS[w.field].setter;
    if (!setter) return;
    const st = useStudioStore.getState();
    if (st[w.field].trim() && !window.confirm(`覆盖当前「${WRITE_TARGETS[w.field].label}」？\n（原内容将被替换）`)) return;
    st[setter](w.text);
  };

  return (
    <button
      onClick={apply}
      disabled={isDone}
      title={w.over ? `原文超过上限，已截断至 ${meta.cap} 字` : `写入${meta.label}（会覆盖现有内容）`}
      className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {isDone ? (
        <>
          <Check className="h-3.5 w-3.5" />
          已写入「{meta.label}」
        </>
      ) : (
        <>
          <PenLine className="h-3.5 w-3.5" />
          写入「{meta.label}」（{w.text.length} 字{w.over ? '，已截断' : ''}）
        </>
      )}
    </button>
  );
}

export function SimWriteButtons({ writes }: { writes?: SimWriteBlock[] }) {
  const chapters = useStudioStore((s) => s.chapters);
  if (!writes?.length) return null;
  const batch = writes
    .filter((w) => w.field === CHAPTER_FIELD)
    .map((w) => ({ w, chapter: findChapter(chapters, w.chapter) }))
    .filter((x): x is { w: SimWriteBlock; chapter: SimChapter } => !!x.chapter && x.chapter.requirement.trim() !== x.w.text.trim());
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1">
      {batch.length >= 2 && (
        <button
          onClick={() => {
            const overwrite = batch.filter((x) => x.chapter.requirement.trim()).length;
            if (overwrite && !window.confirm(`覆盖 ${overwrite} 章已有的章节需求？\n（原内容将被替换）`)) return;
            const st = useStudioStore.getState();
            for (const { w, chapter } of batch) st.updateChapter(chapter.id, { requirement: w.text });
          }}
          title="按顺序把本条回复里各章的章节需求一次写入（已有需求会被覆盖）"
          className="flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-brand-700"
        >
          <Layers className="h-3.5 w-3.5" />
          全部写入章节需求（{batch.length}）
        </button>
      )}
      {writes.map((w, i) => (
        <WriteButton key={`${w.field}-${w.chapter ?? ''}-${i}`} w={w} />
      ))}
    </div>
  );
}
