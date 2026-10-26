/** 🖼 人物形象图片处理与本地存储（v2.31）
 *  - 上传：保留原尺寸（最长边超过 4096 时等比缩小），白底 JPEG；
 *  - AI：按预设比例 cover 裁切并输出精确像素（1024×1024 / 1440×1080 / 1920×1080 / 1080×1920）；
 *  - 头像：从大图源像素方形区域裁出 256×256 JPEG；
 *  - 本体只进 IndexedDB（charimg/charhead key），状态存档只存元数据；
 *  - 头像读取带模块级缓存，避免画布节点反复读库闪烁。 */
import { urlToDataUrl } from './imgApi';
import { localImgDel, localImgGet, localImgSet } from './localImages';
import { collectStateImageKeys, newCharacterHeadKey, newCharacterImageKey } from '../stores/characterStates';
import {
  CHARACTER_IMAGE_PRESET_DIMS,
  type CharacterImageCrop,
  type CharacterImagePreset,
  type CharacterStateImage,
  type SimBoard,
} from '../types/sim';

export const CHARACTER_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const CHARACTER_IMAGE_MAX_EDGE = 4096;
export const HEADSHOT_SIZE = 256;
const JPEG_QUALITY = 0.9;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface PreparedCharacterImage {
  dataUrl: string;
  width: number;
  height: number;
}

type DecodedImage = {
  src: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
};

function mimeOf(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return '';
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('图片解码失败'));
    img.src = src;
  });
}

async function decodeFile(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { src: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* 回退到 <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    return { src: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

async function decodeDataUrl(dataUrl: string): Promise<DecodedImage> {
  const img = await loadImageElement(dataUrl);
  return { src: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持图片处理');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

/** 按目标比例 cover 裁切并绘制到精确尺寸 */
function drawCover(
  src: CanvasImageSource,
  sw: number,
  sh: number,
  targetW: number,
  targetH: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const { canvas, ctx } = canvasOf(targetW, targetH);
  const sourceRatio = sw / sh;
  const targetRatio = targetW / targetH;
  let sx = 0;
  let sy = 0;
  let cropW = sw;
  let cropH = sh;
  if (sourceRatio > targetRatio) {
    cropW = sh * targetRatio;
    sx = (sw - cropW) / 2;
  } else if (sourceRatio < targetRatio) {
    cropH = sw / targetRatio;
    sy = (sh - cropH) / 2;
  }
  ctx.drawImage(src, sx, sy, cropW, cropH, 0, 0, targetW, targetH);
  return { canvas, ctx };
}

function exportJpeg(canvas: HTMLCanvasElement): string {
  try {
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch {
    throw new Error('图片编码失败（可能尺寸过大）');
  }
}

async function drawDecoded(
  decoded: DecodedImage,
  preset: CharacterImagePreset | 'original',
): Promise<PreparedCharacterImage> {
  try {
    let width = decoded.width;
    let height = decoded.height;
    if (!width || !height) throw new Error('图片尺寸无效');
    if (preset === 'original') {
      const edge = Math.max(width, height);
      if (edge > CHARACTER_IMAGE_MAX_EDGE) {
        const scale = CHARACTER_IMAGE_MAX_EDGE / edge;
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }
      const { canvas, ctx } = canvasOf(width, height);
      ctx.drawImage(decoded.src, 0, 0, width, height);
      return { dataUrl: exportJpeg(canvas), width, height };
    }
    const dims = CHARACTER_IMAGE_PRESET_DIMS[preset];
    const { canvas } = drawCover(decoded.src, width, height, dims.w, dims.h);
    return { dataUrl: exportJpeg(canvas), width: dims.w, height: dims.h };
  } finally {
    decoded.close();
  }
}

/** 上传文件 → 原图尺寸（超长边缩小）或指定预设的精确尺寸 */
export async function prepareCharacterImageFile(
  file: File,
  preset: CharacterImagePreset | 'original',
): Promise<PreparedCharacterImage> {
  const mime = mimeOf(file);
  if (!ALLOWED_MIME.has(mime)) throw new Error('只支持 PNG / JPEG / WebP 图片');
  if (file.size > CHARACTER_IMAGE_MAX_BYTES) throw new Error('图片超过 20MB，请压缩后再上传');
  const decoded = await decodeFile(file);
  return drawDecoded(decoded, preset);
}

/** 服务器临时图 URL → 指定预设的精确尺寸；调用方应抢在媒体 GC 前执行 */
export async function prepareCharacterImageUrl(
  url: string,
  preset: CharacterImagePreset,
): Promise<PreparedCharacterImage> {
  const dataUrl = await urlToDataUrl(url);
  const decoded = await decodeDataUrl(dataUrl);
  return drawDecoded(decoded, preset);
}

/** 源图像素方形区域 → 256×256 圆形头像底图 */
export async function cropHeadshot(fullDataUrl: string, crop: CharacterImageCrop): Promise<string> {
  const decoded = await decodeDataUrl(fullDataUrl);
  try {
    const size = Math.max(1, Math.round(crop.size));
    const x = Math.max(0, Math.min(decoded.width - size, Math.round(crop.x)));
    const y = Math.max(0, Math.min(decoded.height - size, Math.round(crop.y)));
    const { canvas, ctx } = canvasOf(HEADSHOT_SIZE, HEADSHOT_SIZE);
    ctx.drawImage(decoded.src, x, y, size, size, 0, 0, HEADSHOT_SIZE, HEADSHOT_SIZE);
    return exportJpeg(canvas);
  } finally {
    decoded.close();
  }
}

/** 写入新大图；每次换图生成新 key，复制状态之间的旧引用不会被覆盖 */
export async function saveFullImage(
  nodeId: string,
  stateId: string,
  prepared: PreparedCharacterImage,
  preset: CharacterImagePreset | 'original',
): Promise<{ image: CharacterStateImage; dataUrl: string }> {
  const key = newCharacterImageKey(nodeId, stateId);
  await localImgSet(key, prepared.dataUrl);
  return {
    image: { key, width: prepared.width, height: prepared.height, preset },
    dataUrl: prepared.dataUrl,
  };
}

/** 生成并写入新头像；返回带 headKey/crop 的形象元数据 */
export async function saveHeadshot(
  nodeId: string,
  stateId: string,
  image: CharacterStateImage,
  crop: CharacterImageCrop,
  fullDataUrl: string,
): Promise<{ image: CharacterStateImage; dataUrl: string }> {
  const dataUrl = await cropHeadshot(fullDataUrl, crop);
  const headKey = newCharacterHeadKey(nodeId, stateId);
  await localImgSet(headKey, dataUrl);
  primeHeadshot(headKey, dataUrl);
  return {
    image: {
      ...image,
      headKey,
      crop: {
        x: Math.round(crop.x),
        y: Math.round(crop.y),
        size: Math.round(crop.size),
      },
    },
    dataUrl,
  };
}

// ── 头像缓存（画布节点与属性面板共用） ──

const headCache = new Map<string, string>();
const headPending = new Map<string, Promise<string | undefined>>();

export function peekHeadshot(key: string | undefined): string | undefined {
  return key ? headCache.get(key) : undefined;
}

export function primeHeadshot(key: string, dataUrl: string): void {
  headCache.set(key, dataUrl);
  headPending.delete(key);
}

export function loadHeadshot(key: string): Promise<string | undefined> {
  const cached = headCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = headPending.get(key);
  if (pending) return pending;
  const p = localImgGet(key)
    .then((v) => {
      if (v) headCache.set(key, v);
      return v;
    })
    .catch(() => undefined)
    .finally(() => headPending.delete(key));
  headPending.set(key, p);
  return p;
}

export function invalidateHeadshot(key: string): void {
  headCache.delete(key);
  headPending.delete(key);
}

/** 取得全部画布仍引用的大图/头像 key */
export function collectReferencedImageKeys(boards: Record<string, SimBoard>): Set<string> {
  const refs = new Set<string>();
  for (const board of Object.values(boards)) {
    for (const node of board.nodes) {
      if (node.data.kind !== 'character') continue;
      for (const state of node.data.states) {
        for (const key of collectStateImageKeys(state)) refs.add(key);
      }
    }
  }
  return refs;
}

/** 只删除已无任何状态引用的 key；跨卷镜像/状态继承仍引用时保留 */
export async function releaseCharacterImageKeys(
  keys: Array<string | undefined>,
  boards: Record<string, SimBoard>,
): Promise<void> {
  const unique = [...new Set(keys.filter((k): k is string => !!k))];
  if (!unique.length) return;
  const refs = collectReferencedImageKeys(boards);
  await Promise.allSettled(
    unique
      .filter((key) => !refs.has(key))
      .map(async (key) => {
        if (key.startsWith('charhead:')) invalidateHeadshot(key);
        await localImgDel(key);
      }),
  );
}
