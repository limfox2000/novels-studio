/** 🎬 推演会话运行时（不持久化）：舞台上的模拟从开始到重置只活在内存里。
 *
 *  与作品数据严格隔离：推演只读 boards/characters 快照，人物移动是渲染投影，
 *  **从不写回**画布节点位置——关掉推演/切走舞台，画布回到摆放时的样子。
 *  引擎本身是纯函数（../engines/simRunner），本 store 只负责持有 session 与定时器。 */
import { create } from 'zustand';
import { useStudioStore } from './studioStore';
import { STAGE_BOARD_ID } from './boardOps';
import { createSimSession, stepSimSession, type SimSession } from '../engines/simRunner';

export const SIM_SPEED_OPTIONS = [500, 1000, 2000] as const;
export type SimIntervalMs = (typeof SIM_SPEED_OPTIONS)[number];

interface SimSessionState {
  /** 当前会话；null=未开始 */
  session: SimSession | null;
  running: boolean;
  error: string;
  intervalMs: SimIntervalMs;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  stepOnce: () => void;
  setIntervalMs: (ms: SimIntervalMs) => void;
}

/** 模块级定时器：不进 store state（state 里放 timer 会让每次 set 都触发订阅） */
let timer: ReturnType<typeof setInterval> | null = null;

function clearTimer() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export const useSimSessionStore = create<SimSessionState>((set, get) => {
  /** 按当前 session 推一拍；session 已不存在则自动停表 */
  const tick = () => {
    const s = get().session;
    if (!s) {
      clearTimer();
      set({ running: false });
      return;
    }
    set({ session: stepSimSession(s) });
  };

  const arm = () => {
    clearTimer();
    timer = setInterval(tick, get().intervalMs);
  };

  return {
    session: null,
    running: false,
    error: '',
    intervalMs: 1000,

    /** 开始推演：读当前舞台板与人物库快照建会话。已在推演中则先丢弃旧会话 */
    start: () => {
      const studio = useStudioStore.getState();
      const board = studio.boards[STAGE_BOARD_ID];
      if (!board) {
        set({ error: '找不到舞台画布：请刷新页面后重试。', running: false });
        return;
      }
      const result = createSimSession(board, studio.characters);
      if ('error' in result) {
        clearTimer();
        set({ session: null, running: false, error: result.error });
        return;
      }
      set({ session: result.session, running: true, error: '' });
      arm();
    },

    pause: () => {
      clearTimer();
      set({ running: false });
    },

    resume: () => {
      if (!get().session || get().running) return;
      set({ running: true, error: '' });
      arm();
    },

    reset: () => {
      clearTimer();
      set({ session: null, running: false, error: '' });
    },

    /** 单步：暂停态下手动推进一拍（未开始时自动建会话） */
    stepOnce: () => {
      if (get().running) return;
      if (!get().session) {
        get().start();
        get().pause();
        return;
      }
      set({ session: stepSimSession(get().session!) });
    },

    setIntervalMs: (ms) => {
      set({ intervalMs: ms });
      if (get().running) arm();
    },
  };
});

/** 页面卸载/切走舞台时暂停（供组件 cleanup 调用，避免定时器泄漏） */
export function pauseSimSession() {
  useSimSessionStore.getState().pause();
}
