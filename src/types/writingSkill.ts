/** ✨ 写作技能扩展包（正文生成专用）：用户自建的专项写作说明。
 *  技能库全局共用（writingSkillStore，保存在本机浏览器）；作品只在章节上记录启用了哪些技能 ID。
 *  上限保持克制：最多同时启用 3 个、每个说明 1000 字，避免给正文 prompt 增加负担。 */

export const WRITING_SKILL_ACTIVE_MAX = 3;
export const WRITING_SKILL_NAME_MAX = 20;
export const WRITING_SKILL_DESC_MAX = 60;
export const WRITING_SKILL_CONTENT_MAX = 1000;
export const WRITING_SKILL_LIBRARY_MAX = 50;
/** 一次注入正文 system 的技能块总上限（含标题/适用场景），超限时按槽位顺序丢弃后续技能 */
export const WRITING_SKILLS_BLOCK_MAX = 3400;

export interface WritingSkill {
  /** `wsk-…`；改名不变，作品章节只引用这个 ID */
  id: string;
  name: string;
  /** 适用场景，可空（如「花朵、庭院、植物意象等」） */
  description: string;
  /** 具体写作方法，正文生成时注入 */
  content: string;
  createdAt: number;
  updatedAt: number;
}

export type WritingSkillInput = Pick<WritingSkill, 'name' | 'description' | 'content'>;

/** 名称/适用场景：折叠所有空白（含换行）为单空格并截断 */
export function sanitizeWritingSkillName(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, WRITING_SKILL_NAME_MAX) : '';
}

export function sanitizeWritingSkillDesc(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, WRITING_SKILL_DESC_MAX) : '';
}

/** 写作说明：保留段落换行，只归一 CRLF、去首尾空白并截断 */
export function sanitizeWritingSkillContent(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, WRITING_SKILL_CONTENT_MAX) : '';
}

/** 章节启用的技能 ID：trim、去重、保持槽位顺序、最多 3 个 */
export function sanitizeWritingSkillIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= WRITING_SKILL_ACTIVE_MAX) break;
  }
  return out;
}

export function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
