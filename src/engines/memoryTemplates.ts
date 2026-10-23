/** 🧠 编辑技能记忆模板层（模板副本模式，2026-10-22）：skills/editor-memory/ 下每个生成能力一份 md 模板
 *  （固定契约小节 + 出厂基线条目），编辑创建时整套复制为该编辑的初始技能记忆副本；调教新增的条目
 *  按小节归类、追加在对应小节的基线之下。本模块负责：模板装载（Vite ?raw 构建期内联）、副本初始化、
 *  小节解析与归类追加、写入前的确定性校验（骨架不可动 + 调教条目过否定/残留过滤）、保骨架截断。
 *  更新器的总规则在 meetingEngine.MEMORY_UPDATE_RULES；行级清洗原语也在本层（meetingEngine 转发导出）。 */
import raw01 from '../../skills/editor-memory/01-全文目标.md?raw';
import raw02 from '../../skills/editor-memory/02-全文规则.md?raw';
import raw03 from '../../skills/editor-memory/03-人物生成.md?raw';
import raw04 from '../../skills/editor-memory/04-环境生成.md?raw';
import raw05 from '../../skills/editor-memory/05-章节大纲规则.md?raw';
import raw06 from '../../skills/editor-memory/06-章节需求.md?raw';
import raw07 from '../../skills/editor-memory/07-卷生成.md?raw';
import raw08 from '../../skills/editor-memory/08-正文生成.md?raw';
import type { EditorModule } from './meetingEngine';

/** 模板文件与模块的对应（顺序即 EDITOR_MODULES 顺序；改动模板文件名时同步此表） */
const TEMPLATE_FILES: Array<[EditorModule, string]> = [
  ['全文目标', raw01],
  ['全文规则', raw02],
  ['人物生成', raw03],
  ['环境生成', raw04],
  ['章节大纲规则', raw05],
  ['章节需求', raw06],
  ['卷生成', raw07],
  ['正文生成', raw08],
];

/** 剥掉文件头部的 YAML frontmatter（--- ... ---），只留正文（H1 + 各小节）——frontmatter 是仓库文件元数据，不随副本 */
function stripFrontmatter(raw: string): string {
  const m = raw.match(/^﻿?---\n[\s\S]*?\n---\n?/);
  return m ? raw.slice(m[0].length).trimStart() : raw.trimStart();
}

const TEMPLATE_BODIES = Object.fromEntries(TEMPLATE_FILES.map(([m, raw]) => [m, stripFrontmatter(raw)])) as Record<EditorModule, string>;

/** 编辑创建时的初始技能记忆：八个模块各一份模板全文副本（骨架 + 出厂基线，未调教即可独立产出） */
export function blankSkillMemories(): Record<EditorModule, string> {
  return { ...TEMPLATE_BODIES };
}

/** 单模块的出厂副本（记忆被手动清空后吸收时重新铺底用） */
export function blankSkillMemory(module: EditorModule): string {
  return TEMPLATE_BODIES[module];
}

/** 该模块出厂副本是否为未调教状态（副本内容与模板一致）——UI 的「已有沉淀」指示用 */
export function isUntunedMemory(module: EditorModule, memory: string | undefined): boolean {
  const v = (memory ?? '').trim();
  return !v || v === TEMPLATE_BODIES[module].trim();
}

// ── 行级清洗原语（主/技能记忆共用；meetingEngine 转发导出保持既有导入路径） ──

/** 🚫 记忆条目正向表述门槛：以否定词开头的条目视为「未提炼到可操作的粒度」，不写入记忆。 */
const MEMORY_NEG_PREFIX = ['不', '禁', '避', '勿', '别', '忌', '莫'];

/** 🧠 对话残留确定性过滤（主/技能记忆共用防线）：调教对话产出的条目里剔除——
 *  客套开头（好的/收到…）、对话指称（刚才/上一条/本次对话…离开对话语境就失去所指）、
 *  以我/你开头的对话转述（不是做法本身）、疑问句尾（问题不是经验）。
 *  有意保守：像「正文单章 2000-3000 字」这类正常技法不会被误杀。 */
const RESIDUE_RES = [
  /^(好的|收到|明白|了解|没问题|知道了|嗯+)/,
  /刚才|刚刚|上一条|这一条|本次对话|这次对话|如前所述|按你说的|按我说的|前面提到|上面提到/,
  /^(我|我们|你|您)(会|将|要|已)/,
];

/** 清洗记忆条目：剔除以否定词（不/不要/禁止/避免…）开头的行；返回清洗后的文本。
 *  全部条目被剔除时返回空串——调用方应放弃本次写入，而不是清空既有记忆。 */
export function sanitizeMemoryEntries(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.filter((l) => {
    const body = l.replace(/^[-•*]+\s*/, '').replace(/^\d+[.、)]\s*/, '').trim();
    return !!body && !MEMORY_NEG_PREFIX.some((p) => body.startsWith(p));
  });
  return kept.join('\n');
}

export function filterChatResidue(text: string): { kept: string; dropped: number } {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.filter((l) => !RESIDUE_RES.some((re) => re.test(l)) && !/[？?]\s*$/.test(l));
  return { kept: kept.join('\n'), dropped: lines.length - kept.length };
}

// ── 记忆文件解析 / 归类追加 / 确定性校验 ──

export interface MemorySection {
  title: string;
  lines: string[];
}
export interface MemoryDoc {
  head: string[];
  sections: MemorySection[];
}

/** 解析记忆文件（模板或编辑副本）：H1 等头部行 + 「## 小节名」分组；空行忽略，行内容 trim 保留 */
export function parseMemoryDoc(text: string): MemoryDoc {
  const head: string[] = [];
  const sections: MemorySection[] = [];
  let cur: MemorySection | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^##\s*(.+?)\s*$/);
    if (m) {
      cur = { title: m[1], lines: [] };
      sections.push(cur);
    } else if (cur) cur.lines.push(line);
    else head.push(line);
  }
  return { head, sections };
}

function renderMemoryDoc(doc: MemoryDoc): string {
  const blocks = doc.sections.map((s) => ['## ' + s.title, ...s.lines].join('\n'));
  return [doc.head.join('\n'), ...blocks].join('\n\n');
}

const normLine = (l: string) => l.replace(/\s+/g, '');

/** 小节名的「基名」：去掉尾部（…）括注——「基本信息（人名 · 年龄 · 性别）」→「基本信息」 */
function baseSectionName(title: string): string {
  return title.replace(/（[^）]*）\s*$/, '').trim();
}

/** 该模块可归类追加条目的小节基名（按模板顺序）：固定契约小节不收条目 */
export function templateCraftSections(module: EditorModule): string[] {
  return parseMemoryDoc(TEMPLATE_BODIES[module])
    .sections.filter((s) => !s.title.includes('固定契约'))
    .map((s) => baseSectionName(s.title));
}

/** 对话记忆协议用的小节速查表（模板即真相，模板改了这里自动跟） */
export const TEMPLATE_CRAFT_SECTIONS: Record<EditorModule, string[]> = Object.fromEntries(
  TEMPLATE_FILES.map(([m]) => [m, templateCraftSections(m)]),
) as Record<EditorModule, string[]>;

export interface SectionDraft {
  section: string;
  lines: string[];
}

/** 解析对话产出的归类草稿：「## 小节名」分组 + 条目行；小节名不在候选内（含固定契约小节）、
 *  以及任何小节头之前的未归类行，都计入 dropped——拿不准归属的宁可不记。同名小节合并为一组 */
export function parseSectionDraft(draft: string, validSections: string[]): { groups: SectionDraft[]; dropped: number } {
  const groups: SectionDraft[] = [];
  let dropped = 0;
  let cur: SectionDraft | undefined;
  for (const raw of draft.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^#{2,3}\s*(.+?)\s*$/);
    if (m) {
      const name = baseSectionName(m[1]);
      const existing = groups.find((g) => g.section === name);
      cur = validSections.includes(name) ? (existing ?? { section: name, lines: [] }) : undefined;
      if (cur && !existing) groups.push(cur);
      if (!cur) dropped++;
      continue;
    }
    if (cur) cur.lines.push(line);
    else dropped++;
  }
  return { groups: groups.filter((g) => g.lines.length), dropped };
}

/** 把已归类的条目组追加进副本：写入对应小节（基名匹配）现有行的末尾——即基线之下；
 *  副本里找不到的小节忽略（上游 parseSectionDraft 已按模板小节校验，此处兜底） */
export function appendToSkillCopy(copy: string, groups: SectionDraft[]): string {
  const doc = parseMemoryDoc(copy);
  for (const g of groups) {
    const s = doc.sections.find((x) => baseSectionName(x.title) === g.section);
    if (s) s.lines.push(...g.lines);
  }
  return renderMemoryDoc(doc);
}

// ── 模板升级（已有编辑副本的迁移） ──

/** v2.26 人物生成模板的骨架行（v2.27 拆分基础信息/身份信息后，这些行不属于任何新小节）：
 *  迁移时据此区分「出厂基线」与「调教条目」，只保留调教条目。 */
const V2_26_CHARACTER_SKELETON = new Set(
  [
    '# 人物生成 · 技能记忆',
    '_生成/修订人物设定一律按此执行；结构本身不因调教改动。_',
    '- 人物设定依次产出：基本信息（人名/性别/年龄）→ 外观 → 性格 → 人物关系（按需）',
    '- 人名/性别/年龄是节点字段：人名给贴合作品的语言感名字，性别 男/女，年龄给数字',
    '_三项的取法；特殊题材有惯例口径时沉淀在这里（辅助需求，通常留空）。_',
    '- 人名贴合题材世界观的语言感，年龄与身份、阅历匹配，性别按作品需要设定——三项都给全，字段直接可用',
    '_外观设计的写法——核心沉淀区之一：不同题材的形象口径与辨识点取舍。_',
    '- 体貌、着装、气质各一笔，落到一个让人记住的标志细节（疤痕、饰品、习惯动作）；外观与身份、处境自洽',
    '_性格设计的写法——核心沉淀区之一：性格立体化与行为逻辑的偏好。_',
    '- 用具体行为倾向代替形容词堆叠：欲望、软肋、行事风格各占一点；动机与背景经历对得上，行为可复现',
    '_人物关系的搭法；特殊题材的关系网需求沉淀在这里（辅助需求，按需启用）。_',
    '- 每个人物与主线至少一处勾连；关系写成双向的（谁对谁怎样、谁欠谁什么），标明现状与张力',
  ].map(normLine),
);

/** 旧版技能副本 → 当前模板（目前只有人物生成需要：v2.27 把「基本信息/外观/性格」拆成
 *  「基础属性/基础信息/身份信息」）。只迁移调教条目：旧骨架行按 V2_26_CHARACTER_SKELETON 剔除，
 *  外观+性格条目并入基础信息，基本信息条目并入基础属性，身份信息从出厂基线起。幂等且只降不升——
 *  已是新结构（有「基础信息」小节）或不是旧结构时原样返回。 */
export function upgradeSkillCopy(module: EditorModule, copy: string): string {
  if (module !== '人物生成') return copy;
  const doc = parseMemoryDoc(copy);
  const has = (base: string) => doc.sections.some((s) => baseSectionName(s.title) === base);
  if (has('基础信息') || !has('外观')) return copy;
  const tpl = parseMemoryDoc(TEMPLATE_BODIES[module]);
  const tplSet = new Set(tpl.sections.flatMap((s) => s.lines).map(normLine));
  const tuned = (base: string): string[] => {
    const s = doc.sections.find((x) => baseSectionName(x.title) === base);
    return (s?.lines ?? []).filter((l) => !V2_26_CHARACTER_SKELETON.has(normLine(l)) && !tplSet.has(normLine(l)));
  };
  const mapped: Record<string, string[]> = {
    基础属性: tuned('基本信息'),
    基础信息: [...tuned('外观'), ...tuned('性格')],
    身份信息: [],
    人物关系: tuned('人物关系'),
  };
  const blocks = tpl.sections.map((ts) => {
    const base = baseSectionName(ts.title);
    const seen = new Set<string>();
    const extra = (mapped[base] ?? []).filter((l) => {
      const k = normLine(l);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return ['## ' + ts.title, ...ts.lines, ...extra].join('\n');
  });
  return [tpl.head.join('\n'), ...blocks].join('\n\n');
}

/** 技能记忆副本的确定性写入校验（模型整合/优化输出复验，纯代码）：重建式校验——
 *  ① 小节名与顺序必须与模板完全一致、H1 不动，否则整体不合格（调用方回退确定性追加）；
 *  ② 重建时骨架行（契约/说明行/基线）一律由模板原样补齐——被改写、删除、挪动都自动复原，
 *     模型改写过的骨架行会落入「调教条目」接受行级过滤；
 *  ③ 其余条目逐行过 否定表述 / 对话残留 / 疑问句尾 过滤，违规剔除并计数。
 *  返回重建后的规范副本（骨架在前、该小节调教条目在后）。 */
export function revalidateSkillCopy(text: string, module: EditorModule): { ok: boolean; memory?: string; dropped: number } {
  const fail = { ok: false, dropped: 0 };
  const tpl = parseMemoryDoc(TEMPLATE_BODIES[module]);
  const doc = parseMemoryDoc(text);
  if (doc.head.length !== tpl.head.length || doc.head.some((l, i) => normLine(l) !== normLine(tpl.head[i]))) return fail;
  if (doc.sections.length !== tpl.sections.length) return fail;
  for (let i = 0; i < doc.sections.length; i++) {
    if (normLine(doc.sections[i].title) !== normLine(tpl.sections[i].title)) return fail;
  }
  const tplLines = new Set<string>([...tpl.head, ...tpl.sections.flatMap((s) => s.lines)].map(normLine));
  let dropped = 0;
  const tuned = tpl.sections.map((_ts, i) => {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const raw of doc.sections[i].lines) {
      const k = normLine(raw);
      if (tplLines.has(k)) continue; // 骨架行由模板原样补齐（重复/挪动在此归一）
      if (seen.has(k)) {
        dropped++;
        continue;
      }
      seen.add(k);
      const body = raw.replace(/^[-•*]+\s*/, '').replace(/^\d+[.、)]\s*/, '').trim();
      if (!body || MEMORY_NEG_PREFIX.some((p) => body.startsWith(p)) || RESIDUE_RES.some((re) => re.test(body)) || /[？?]\s*$/.test(body)) {
        dropped++;
        continue;
      }
      kept.push(/^[-•*]/.test(raw) ? raw : `- ${raw}`);
    }
    return kept;
  });
  const blocks = tpl.sections.map((ts, i) => ['## ' + ts.title, ...ts.lines, ...tuned[i]].join('\n'));
  return { ok: true, memory: [tpl.head.join('\n'), ...blocks].join('\n\n'), dropped };
}

/** 超上限时的保骨架截断：从尾部往前只删调教条目（契约/说明行/基线绝不删），直到 ≤ cap；
 *  只剩骨架仍超限则原样返回（骨架不可动，就让它超着） */
export function trimSkillCopy(copy: string, module: EditorModule, cap: number): string {
  let text = copy;
  const tpl = parseMemoryDoc(TEMPLATE_BODIES[module]);
  for (;;) {
    if (text.length <= cap) return text;
    const doc = parseMemoryDoc(text);
    let removed = false;
    for (let i = doc.sections.length - 1; i >= 0 && !removed; i--) {
      const tplSet = new Set((tpl.sections[i]?.lines ?? []).map(normLine));
      for (let j = doc.sections[i].lines.length - 1; j >= 0; j--) {
        if (!tplSet.has(normLine(doc.sections[i].lines[j]))) {
          doc.sections[i].lines.splice(j, 1);
          removed = true;
          break;
        }
      }
    }
    if (!removed) return text;
    text = renderMemoryDoc(doc);
  }
}
