/** ✨ 全局写作技能库（本机浏览器共享，所有作品可用）。
 *  与 editorialStore 的全局编辑名单同形态：立即可持久化，不参与作品的手动保存脏标记；
 *  作品章节只保存启用的技能 ID（SimChapter.writingSkillIds），技能正文不进作品存档。
 *  删除技能时由管理器顺手清理当前作品的章节引用；其它存档里的旧 ID 在解析时安全忽略。 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { uid } from '../utils/id';
import {
  WRITING_SKILL_CONTENT_MAX,
  WRITING_SKILL_DESC_MAX,
  WRITING_SKILL_LIBRARY_MAX,
  WRITING_SKILL_NAME_MAX,
  sanitizeWritingSkillContent,
  sanitizeWritingSkillDesc,
  sanitizeWritingSkillName,
  type WritingSkill,
  type WritingSkillInput,
} from '../types/writingSkill';

export type WritingSkillResult = { ok: true; id: string } | { ok: false; error: string };

interface WritingSkillState {
  skills: WritingSkill[];
  createSkill: (input: WritingSkillInput) => WritingSkillResult;
  updateSkill: (id: string, input: WritingSkillInput) => { ok: true } | { ok: false; error: string };
  deleteSkill: (id: string) => void;
}

function stamp(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 持久化恢复兜底：坏条目丢弃、缺 ID 补新 ID、字段归一/截断、按 ID 与名称去重、最多 50 条 */
export function sanitizeWritingSkillLibrary(v: unknown): WritingSkill[] {
  if (!Array.isArray(v)) return [];
  const now = Date.now();
  const byId = new Set<string>();
  const names = new Set<string>();
  const out: WritingSkill[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = sanitizeWritingSkillName(r.name);
    const content = sanitizeWritingSkillContent(r.content);
    if (!name || !content) continue;
    const nameKey = name.toLowerCase();
    if (names.has(nameKey)) continue;
    let id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) id = `wsk-${uid()}`;
    if (byId.has(id)) continue;
    names.add(nameKey);
    byId.add(id);
    out.push({
      id,
      name,
      description: sanitizeWritingSkillDesc(r.description),
      content,
      createdAt: stamp(r.createdAt, now),
      updatedAt: stamp(r.updatedAt, now),
    });
    if (out.length >= WRITING_SKILL_LIBRARY_MAX) break;
  }
  return out;
}

function cleanInput(input: WritingSkillInput): WritingSkillInput {
  return {
    name: sanitizeWritingSkillName(input.name),
    description: sanitizeWritingSkillDesc(input.description),
    content: sanitizeWritingSkillContent(input.content),
  };
}

function validate(
  skills: WritingSkill[],
  input: WritingSkillInput,
  excludeId?: string,
): { ok: true; clean: WritingSkillInput } | { ok: false; error: string } {
  const clean = cleanInput(input);
  if (!clean.name) return { ok: false, error: `技能名称不能为空（最多 ${WRITING_SKILL_NAME_MAX} 字）` };
  if (!clean.content) return { ok: false, error: `写作说明不能为空（最多 ${WRITING_SKILL_CONTENT_MAX} 字）` };
  if (skills.some((s) => s.id !== excludeId && s.name.toLowerCase() === clean.name.toLowerCase())) {
    return { ok: false, error: `技能库已有同名技能「${clean.name}」` };
  }
  return { ok: true, clean };
}

export const useWritingSkillStore = create<WritingSkillState>()(
  persist(
    (set, get) => ({
      skills: [],
      createSkill: (input) => {
        const skills = get().skills;
        if (skills.length >= WRITING_SKILL_LIBRARY_MAX) {
          return { ok: false, error: `技能库最多 ${WRITING_SKILL_LIBRARY_MAX} 个技能` };
        }
        const r = validate(skills, input);
        if (!r.ok) return r;
        const now = Date.now();
        const id = `wsk-${uid()}`;
        set({ skills: [...skills, { id, ...r.clean, createdAt: now, updatedAt: now }] });
        return { ok: true, id };
      },
      updateSkill: (id, input) => {
        const skills = get().skills;
        const before = skills.find((s) => s.id === id);
        if (!before) return { ok: false, error: '技能不存在（可能已在其它页面删除）' };
        const r = validate(skills, input, id);
        if (!r.ok) return r;
        set({
          skills: skills.map((s) => (s.id === id ? { ...s, ...r.clean, updatedAt: Date.now() } : s)),
        });
        return { ok: true };
      },
      deleteSkill: (id) => set((s) => ({ skills: s.skills.filter((x) => x.id !== id) })),
    }),
    {
      name: 'nc2-writing-skills-v1',
      version: 1,
      partialize: (s) => ({ skills: s.skills }) as Partial<WritingSkillState>,
      merge: (persisted, current) => ({
        ...current,
        skills: sanitizeWritingSkillLibrary((persisted as { skills?: unknown } | undefined)?.skills),
      }),
    },
  ),
);
