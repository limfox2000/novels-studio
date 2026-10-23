/** 轻量 className 合并（不做去重，按顺序拼接；falsy 忽略） */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
