/** 💾 手动 persist storage：Zustand 的每次 set 只登记最新 payload 并标记“未保存”，
 *  只有用户点「保存」或按 Ctrl/Cmd+S 时才 JSON.stringify 并写入 localStorage。
 *  不再注册 pagehide/beforeunload 自动落盘——刷新/关闭前需手动保存，工具栏持续显示未保存状态。 */
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { useUiStore } from './uiStore';

export interface ManualPersistStorage<S> extends PersistStorage<S> {
  /** 立即写入最新待写数据；无待写数据时也返回 true */
  save: () => boolean;
  /** 是否有尚未保存的数据 */
  hasPending: () => boolean;
  /** 把当前内存状态设为“已保存基线”（初始化恢复后调用，避免首次选中/缩放就误标未保存） */
  markClean: (state: S) => void;
}

export interface ManualPersistOptions<S> {
  onError?: (error: unknown) => void;
  /** 内容级比较：忽略选中/测量/视口等瞬态字段；相等时不登记待写、不标记未保存 */
  contentEqual?: (a: S, b: S) => boolean;
  /** 首次保存（localStorage 尚无记录）时写入的 persist 版本号 */
  defaultVersion?: number;
}

type Pending<S> = { name: string; value: StorageValue<S> };

const UNSAVED_MSG = '有未保存改动';

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

function saveErrorMessage(e: unknown): string {
  const name = e && typeof e === 'object' ? (e as { name?: unknown }).name : '';
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    ? '本地存储空间不足，保存失败。请导出存档后清理浏览器站点数据。'
    : '本地保存失败，请检查浏览器存储权限或空间。';
}

export function createManualPersistStorage<S>(opts: ManualPersistOptions<S> = {}): ManualPersistStorage<S> {
  let pending: Pending<S> | null = null;
  /** 最近一次内存 payload（即使只改了视口/当前画布等不计入未保存状态的字段，也保留下来供显式保存写盘） */
  let latest: Pending<S> | null = null;
  let storageName: string | null = null;
  let storageVersion: number | undefined;
  let errorReported = false;
  /** 最近一次保存（或初始化恢复）时的内存状态；仅用于忽略瞬态 set */
  let cleanState: S | null = null;

  return {
    getItem: (name) => {
      storageName = name;
      const raw = readRaw(name) as StorageValue<S> | null;
      storageVersion = typeof raw?.version === 'number' ? raw.version : undefined;
      return raw;
    },
    setItem: (name, value) => {
      const next = value as StorageValue<S>;
      storageName = name;
      latest = { name, value: next };
      // 未保存期间直接覆盖待写 payload；已保存状态下先判断内容是否真的变了，
      // 选中节点、React Flow 测量、平移视口等瞬态变化不弄脏作品
      if (useUiStore.getState().saveStatus !== 'unsaved') {
        if (opts.contentEqual && cleanState && opts.contentEqual(cleanState, next.state)) return;
        // 保存失败的错误保持可见，直到下一次保存成功；不要被“未保存”覆盖
        if (useUiStore.getState().saveStatus !== 'error') {
          useUiStore.getState().setSaveStatus('unsaved', UNSAVED_MSG);
        }
      }
      pending = { name, value: next };
    },
    removeItem: (name) => {
      pending = null;
      latest = null;
      cleanState = null;
      errorReported = false;
      try {
        window.localStorage.removeItem(name);
      } catch {
        /* 存储不可用时由下一次保存统一报错 */
      }
    },
    save: () => {
      // 优先写最新内存状态：这样“平移视口/切画布”虽不标未保存，用户主动保存时仍会连同内容一起落盘
      const target = latest ?? pending;
      if (!target) {
        useUiStore.getState().setSaveStatus('saved', '✓ 已保存');
        return true;
      }
      const { name, value } = target;
      try {
        window.localStorage.setItem(name, JSON.stringify(value));
        pending = null;
        cleanState = value.state;
        errorReported = false;
        useUiStore.getState().setSaveStatus('saved', '✓ 已保存');
        return true;
      } catch (e) {
        if (!errorReported) {
          errorReported = true;
          useUiStore.getState().setSaveStatus('error', saveErrorMessage(e));
          opts.onError?.(e);
        }
        return false;
      }
    },
    hasPending: () => pending !== null,
    markClean: (state) => {
      // 不清理 pending：若恢复过程中触发了版本迁移，数据仍应等待用户显式保存
      cleanState = state;
      errorReported = false;
      if (storageName) {
        latest = {
          name: storageName,
          value: { state, version: storageVersion ?? opts.defaultVersion } as StorageValue<S>,
        };
      }
    },
  };
}
