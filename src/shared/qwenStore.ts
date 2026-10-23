/** Qwen 设计引擎可达性状态（非持久化）：顶栏 ⚡ 徽章、页面挂载探测、引擎动作预检（qwenGate）三方共用。
 *  租用 GPU 常关机——每个 Qwen 动作前 ensureOnline() 预检，60s 内在线结果视为新鲜，不重复 ping。 */
import { create } from 'zustand';
import { qwPing } from './qwenClient';

const FRESH_MS = 60_000;

interface QwenState {
  status: 'idle' | 'checking' | 'ok' | 'down';
  msg: string; // ok: 延迟（如 '135ms'）；down: 离线原因
  lastOkAt: number; // 上次在线时刻（0=从未在线），新鲜度判断用
  /** 强制探测一次并写入状态；返回是否在线 */
  check: () => Promise<boolean>;
  /** 动作预检：在线且结果新鲜（60s 内）直接放行，否则探测 */
  ensureOnline: () => Promise<boolean>;
}

export const useQwenStore = create<QwenState>((set, get) => ({
  status: 'idle',
  msg: '',
  lastOkAt: 0,

  check: async () => {
    set({ status: 'checking', msg: '' });
    try {
      const r = await qwPing();
      if (r.ok) {
        set({ status: 'ok', msg: `${r.latencyMs ?? '?'}ms`, lastOkAt: Date.now() });
        return true;
      }
      set({ status: 'down', msg: r.error || '离线' });
      return false;
    } catch (e) {
      set({ status: 'down', msg: (e as Error).message });
      return false;
    }
  },

  ensureOnline: async () => {
    const { status, lastOkAt } = get();
    if (status === 'ok' && Date.now() - lastOkAt < FRESH_MS) return true;
    return get().check();
  },
}));
