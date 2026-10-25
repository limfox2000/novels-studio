/** ✨ 正文写作技能（扩展包）→ system prompt 片段。
 *  只由 genChapterContent 使用：按本章 writingSkillIds 的顺序解析全局技能库，生成一个可选的补充块；
 *  0 个有效技能时返回空串，正文 prompt 与未上线该功能时完全一致。
 *  技能是“写法建议”，必须让位于全文规则/大纲/人物设定，并明确只在相关场景参考。 */
import {
  WRITING_SKILL_ACTIVE_MAX,
  WRITING_SKILLS_BLOCK_MAX,
  sanitizeWritingSkillContent,
  sanitizeWritingSkillDesc,
  sanitizeWritingSkillName,
  type WritingSkill,
} from '../types/writingSkill';

/** 按槽位顺序解析：忽略技能库中不存在/空内容/重复的 ID，最多 3 个 */
export function resolveWritingSkills(ids: unknown, library: WritingSkill[]): WritingSkill[] {
  if (!Array.isArray(ids)) return [];
  const byId = new Map<string, WritingSkill>();
  for (const s of library) if (s?.id && !byId.has(s.id)) byId.set(s.id, s);
  const out: WritingSkill[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const skill = byId.get(id);
    if (!skill || !sanitizeWritingSkillName(skill.name) || !sanitizeWritingSkillContent(skill.content)) continue;
    out.push(skill);
    if (out.length >= WRITING_SKILL_ACTIVE_MAX) break;
  }
  return out;
}

const HEADER =
  '【写作技能补充】（本章启用的专项写作说明。仅在涉及相关对象/场景时按此写法展开；不相关则忽略，' +
  '不得为了使用技能而添加情节、人物或物件。若与全文规则、本章大纲、人物设定冲突，以后者为准。）';

/** 构造正文 system 的技能块；无有效技能返回 ''。总长超限时按槽位顺序保留前面的技能 */
export function buildWritingSkillsBlock(skills: WritingSkill[]): string {
  let out = HEADER;
  let added = 0;
  for (const skill of skills) {
    const name = sanitizeWritingSkillName(skill.name);
    const content = sanitizeWritingSkillContent(skill.content);
    if (!name || !content) continue;
    const desc = sanitizeWritingSkillDesc(skill.description);
    const section = `【写作技能：${name}】${desc ? `\n适用：${desc}` : ''}\n${content}`;
    const candidate = `${out}\n\n${section}`;
    if (candidate.length > WRITING_SKILLS_BLOCK_MAX) break;
    out = candidate;
    added += 1;
  }
  return added ? out : '';
}
