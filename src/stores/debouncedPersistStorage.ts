/** 💾 防抖 persist storage（P1）：Zustand 每次 set 只登记最新 payload，真正 JSON.stringify + localStorage
 *  写入延后到停止更新后（默认 500ms，最长 2s）。流式生成每约 400ms 写章节时，避免每 400ms 全量序列化整个工作区。
 *  只在落盘时序列化；页面隐藏/关闭时 flush 最新数据，超配额等错误保留待写 payload 供下次重试。 */
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { useUiStore } from './uiStore';

export interface DebouncedPersistStorage<S> extends PersistStorage<S> {
  /** 立即写入最新待写数据（页面隐藏/生成结束时用） */
  flush: () => void;
  /** 是否有尚未落盘的数据 */
  hasPending: () => boolean;
}

export interface DebouncedPersistOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  /** 默认 true；测试可关闭，避免注册全局页面事件 */
  registerLifecycleHooks?: boolean;
  onError?: (error: unknown) => void;
}

type Pending = { name: string; value: StorageValue<unknown> };

function readRaw(name: string): StorageValue<unknown> | null {
  try {
    const raw = window.localStorage.getItem(name);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as { state?: unknown; version?: unknown };
    return 'state' in value ? (value as StorageValue<unknown>) : null;
  } catch {
    return null;
  }
}

function quotaMessage(e: unknown): string {
  const name = e && typeof e === 'object' ? (e as { name?: unknown }).name : '';
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    ? '本地存储空间不足，最新改动可能未保存。请导出存档后清理浏览器站点数据。'
    : '本地自动保存失败，最新改动可能未保存。';
}

export function createDebouncedPersistStorage<S>(
  opts: DebouncedPersistOptions = {},
): DebouncedPersistStorage<S> {
  const debounceMs = opts.debounceMs ?? 500;
  const maxWaitMs = opts.maxWaitMs ?? 2000;
  let pending: Pending | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstPendingAt = 0;
  let errorReported = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const write = () => {
    clearTimer();
    if (!pending) return;
    const { name, value } = pending;
    // 每次落盘尝试后重新计算最长等待窗口；失败时 pending 保留，下一次变更重新计时
    firstPendingAt = 0;
    try {
      window.localStorage.setItem(name, JSON.stringify(value));
      pending = null;
      errorReported = false;
      useUiStore.getState().setSaveStatus('saved', '✓ 已自动保存');
    } catch (e) {
      // 保留最新 payload：下一次 store 变更或页面隐藏/关闭时重试，不丢内存状态
      if (!errorReported) {
        errorReported = true;
        useUiStore.getState().setSaveStatus('error', quotaMessage(e));
        opts.onError?.(e);
      }
    }
  };

  const schedule = () => {
    const now = Date.now();
    if (!pending) return;
    if (!firstPendingAt) firstPendingAt = now;
    clearTimer();
    const remainingMax = maxWaitMs - (now - firstPendingAt);
    const delay = Math.max(0, Math.min(debounceMs, remainingMax));
    timer = setTimeout(write, delay);
    if (useUiStore.getState().saveStatus !== 'saving') {
      useUiStore.getState().setSaveStatus('saving', '');
    }
  };

  if (opts.registerLifecycleHooks !== false && typeof window !== 'undefined') {
    const flush = () => write();
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') write();
    });
  }

  return {
    getItem: (name) => readRaw(name) as StorageValue<S> | null,
    setItem: (name, value) => {
      pending = { name, value: value as StorageValue<unknown> };
      if (!firstPendingAt) firstPendingAt = Date.now();
      schedule();
    },
    removeItem: (name) => {
      clearTimer();
      pending = null;
      firstPendingAt = 0;
      try {
        window.localStorage.removeItem(name);
      } catch {
        /* 存储不可用时由下一次写入统一报错 */
      }
    },
    flush: write,
    hasPending: () => pending !== null,
  };
}
