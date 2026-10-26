/** 本地图片仓（IndexedDB）：AI 生成的图片以 data URL 存浏览器本地，持久化数据里不留服务器 URL——
 *  服务器 media GC（10 分钟保护窗）自动回收无引用文件，本地副本长期保留。
 *  单库单 store，key 按用途加前缀：charimg:<nodeId>:<stateId>:<nonce>（人物形象大图）/
 *  charhead:<nodeId>:<stateId>:<nonce>（裁切后的圆形头像）/ chat:<msgId>:<i>（编辑室生图块）… */
import { urlToDataUrl } from './imgApi';

const DB_NAME = 'nc2-imglocal-v1';
const STORE = 'imgs';

let dbp: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error ?? new Error('IndexedDB 打开失败'));
    });
  }
  return dbp;
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise<T>((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => res(req.result as T);
    req.onerror = () => rej(req.error ?? new Error('IndexedDB 操作失败'));
  });
}

export function localImgGet(key: string): Promise<string | undefined> {
  return tx<string | undefined>('readonly', (s) => s.get(key));
}

export async function localImgSet(key: string, dataUrl: string): Promise<void> {
  await tx('readwrite', (s) => s.put(dataUrl, key));
}

export async function localImgDel(key: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(key));
}

/** 复制本地图片（跨卷「复制为新」：形象/头像 key → 新节点自己的 key）。
 *  返回 'missing'=源图本来就不存在（不算失败，不提示）；读写异常则抛出，由调用方降级为警告，不阻塞节点复制。 */
export async function localImgCopy(fromKey: string, toKey: string): Promise<'copied' | 'missing'> {
  const data = await localImgGet(fromKey);
  if (!data) return 'missing';
  await localImgSet(toKey, data);
  return 'copied';
}

/** 生成完成后立即把服务器临时图片抓回本地转 data URL 存仓（抢在 10 分钟 GC 前），返回 data URL */
export async function localImgSaveFromUrl(key: string, url: string): Promise<string> {
  const data = await urlToDataUrl(url);
  await localImgSet(key, data);
  return data;
}
