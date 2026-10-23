/** 生成卡片 ID。crypto.randomUUID 仅在安全上下文（HTTPS/localhost）可用，
 *  纯 HTTP 部署时需要兼容方案 */
export function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
