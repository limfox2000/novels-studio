/** 后端 API 基址。
 *  生产：取页面所在目录作为反向代理前缀（如 /novels-studio/studio.html → /novels-studio）；
 *  开发：页面在站点根目录，返回 ''，由 Vite proxy 转发 /api。 */
export const API_BASE = location.pathname.replace(/[^/]*\.html?$/, '').replace(/\/+$/, '') || '';
