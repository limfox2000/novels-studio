/** 📕 作品封面（v2.28）：用户上传的封面图在本地压成 5:7 小图（data URL）随作品状态/存档保存，
 *  书架直接显示——不上传服务器、不占 IndexedDB。压缩后约 20–50KB，避免原图撑爆 localStorage。 */
import { fileToDataUrl } from './imgApi';

/** 封面输出尺寸（书架书封显示约 132×185，2x 屏足够清晰） */
export const BOOK_COVER_W = 360;
export const BOOK_COVER_H = 504;

const MAX_INPUT_BYTES = 15 * 1024 * 1024;

/** 书名 hash → 0..359 色相（无封面时的占位底色，同书恒定；书架与属性面板共用） */
export function bookHue(name: string): number {
  return [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 0);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('图片解码失败，请换一张图片'));
    im.src = src;
  });
}

/** 上传文件 → 封面 data URL：按 5:7 居中裁切后缩到 360×504 JPEG（白底，quality 0.84）。
 *  非图片/超大/解码失败抛中文错误，调用方提示即可。 */
export async function makeBookCover(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > MAX_INPUT_BYTES) throw new Error('图片过大（上限 15MB）');
  const img = await loadImage(await fileToDataUrl(file));
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) throw new Error('图片尺寸无效');
  // 居中裁切到 5:7（与书架书封比例一致，所见即所得）
  const ratio = BOOK_COVER_W / BOOK_COVER_H;
  let sw = iw;
  let sh = ih;
  if (sw / sh > ratio) sw = sh * ratio;
  else sh = sw / ratio;
  const canvas = document.createElement('canvas');
  canvas.width = BOOK_COVER_W;
  canvas.height = BOOK_COVER_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持图片处理');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, BOOK_COVER_W, BOOK_COVER_H);
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, BOOK_COVER_W, BOOK_COVER_H);
  return canvas.toDataURL('image/jpeg', 0.84);
}
