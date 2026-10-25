/** 编辑室聊天的用户粘贴图片：浏览器端压缩后，本体存 IndexedDB（localImages 的 chat:<msgId>:u:<i>），
 *  消息里只留轻量元数据，避免大段 base64 进入 localStorage 存档。发送时再异步读回 data URL 交给视觉模型。 */
import { localImgDel, localImgGet, localImgSet } from './localImages';

/** 单条消息最多附带的图片数（视觉 token 成本高，保持轻量） */
export const CHAT_ATTACHMENT_MAX = 3;
/** 一次请求最多带上的图片总数（当前消息 + 最近历史，防止多轮重复图片撑爆上下文） */
export const CHAT_VISION_TOTAL_MAX = 4;
export const CHAT_ATTACHMENT_MAX_SOURCE = 20 * 1024 * 1024;
const MAX_EDGE = 1568;
const MAX_DATA_URL_CHARS = 1_600_000;
export const DEFAULT_IMAGE_PROMPT = '请分析这些图片，提取可用于人物或环境设计的细节。';

export interface ChatAttachmentInput {
  dataUrl: string;
  mime: string;
  name: string;
  w: number;
  h: number;
  bytes: number;
}

export interface ChatAttachmentMeta {
  i: number;
  mime: string;
  name: string;
  w: number;
  h: number;
  bytes: number;
}

export const chatAttachmentKey = (msgId: string, i: number) => `chat:${msgId}:u:${i}`;

function attachmentMime(file: File): string {
  if (file.type && file.type !== 'image/svg+xml') return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'avif') return 'image/avif';
  return 'image/jpeg';
}

async function decodeImage(file: File): Promise<{ src: CanvasImageSource; w: number; h: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { src: bmp, w: bmp.width, h: bmp.height };
    } catch {
      /* 回退到 <img> 解码（部分格式/浏览器不支持 createImageBitmap） */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = url;
    });
    return { src: img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 把粘贴/选择的图片压到最长边 1568、JPEG 约 0.86 质量；过大时逐步缩小，返回可直接发给视觉模型的 data URL。 */
export async function compressChatImage(file: File): Promise<ChatAttachmentInput> {
  if (file.size > CHAT_ATTACHMENT_MAX_SOURCE) {
    throw new Error(`${file.name || '图片'} ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 20MB 上限`);
  }
  const mime = attachmentMime(file);
  if (!mime.startsWith('image/')) throw new Error(`${file.name || '文件'} 不是图片`);
  const { src, w, h } = await decodeImage(file);
  if (!w || !h) throw new Error(`${file.name || '图片'} 尺寸无效`);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持图片压缩');
  let scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  let dataUrl = '';
  let outW = 0;
  let outH = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    outW = Math.max(1, Math.round(w * scale));
    outH = Math.max(1, Math.round(h * scale));
    canvas.width = outW;
    canvas.height = outH;
    // 透明 PNG 转 JPEG 时铺白底，避免黑底
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(src, 0, 0, outW, outH);
    dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    if (dataUrl.length <= MAX_DATA_URL_CHARS) break;
    scale *= 0.78;
  }
  if ('close' in src && typeof src.close === 'function') src.close();
  if (!dataUrl || dataUrl.length > MAX_DATA_URL_CHARS) throw new Error('图片过大，压缩后仍超过上限，请裁剪后再试');
  return {
    dataUrl,
    mime: 'image/jpeg',
    name: (file.name || '粘贴图片').slice(0, 80),
    w: outW,
    h: outH,
    bytes: Math.round((dataUrl.length * 3) / 4),
  };
}

/** 图片本体写入 IndexedDB；消息只保存元数据 */
export async function saveChatAttachments(msgId: string, images: ChatAttachmentInput[]): Promise<ChatAttachmentMeta[]> {
  const metas: ChatAttachmentMeta[] = [];
  for (let i = 0; i < images.length && i < CHAT_ATTACHMENT_MAX; i++) {
    const img = images[i];
    await localImgSet(chatAttachmentKey(msgId, i), img.dataUrl);
    metas.push({ i, mime: img.mime, name: img.name, w: img.w, h: img.h, bytes: img.bytes });
  }
  return metas;
}

/** 按元数据读回图片 data URL；缺失/读取失败的条目跳过，不阻塞文字发送。 */
export async function loadChatAttachmentUrls(msgId: string, metas?: ChatAttachmentMeta[]): Promise<string[]> {
  if (!metas?.length) return [];
  const out = await Promise.all(
    metas.map((m) => localImgGet(chatAttachmentKey(msgId, m.i)).catch(() => undefined)),
  );
  return out.filter((v): v is string => !!v);
}

export function deleteChatAttachments(msgId: string, metas?: ChatAttachmentMeta[]): void {
  if (!metas?.length) return;
  for (const m of metas) void localImgDel(chatAttachmentKey(msgId, m.i)).catch(() => undefined);
}
