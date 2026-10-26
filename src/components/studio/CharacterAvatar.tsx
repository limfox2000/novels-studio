/** 🧑 画布人物头像（v2.31）：优先显示状态大图里手动裁出的头部圆形头像；
 *  没有 headKey / 读库失败 / 字节缺失时，按性别显示内置剪影（男蓝短发 / 女玫红长发）。
 *  头像本体在 IndexedDB，异步读取走 characterImages 的模块级缓存，避免节点反复闪白。 */
import { useEffect, useState } from 'react';
import { loadHeadshot, peekHeadshot } from '../../services/characterImages';
import type { CharacterGender, CharacterStateImage } from '../../types/sim';

const FALLBACK_BG: Record<CharacterGender, string> = {
  male: 'bg-blue-100',
  female: 'bg-rose-100',
};

function Silhouette({ gender }: { gender: CharacterGender }) {
  return gender === 'female' ? (
    <svg viewBox="0 0 64 64" className="h-full w-full" aria-hidden="true">
      <rect width="64" height="64" fill="#ffe4e6" />
      {/* 长发轮廓 */}
      <path d="M19 29c0-9 5.5-15.5 13-15.5S45 20 45 29v15l-4 3V32c0-4.5-3-8-9-8s-9 3.5-9 8v15l-4-3z" fill="#be123c" />
      <circle cx="32" cy="26" r="8.4" fill="#f43f5e" />
      <path d="M15.5 64c1.4-11.5 8-18 16.5-18s15.1 6.5 16.5 18z" fill="#f43f5e" />
    </svg>
  ) : (
    <svg viewBox="0 0 64 64" className="h-full w-full" aria-hidden="true">
      <rect width="64" height="64" fill="#dbeafe" />
      {/* 短发轮廓 */}
      <path d="M21 27c0-8 4.8-13.5 11-13.5S43 19 43 27v4l-3-2c-2-4-4-6-8-6s-6 2-8 6l-3 2z" fill="#1d4ed8" />
      <circle cx="32" cy="27" r="8.6" fill="#3b82f6" />
      <path d="M14 64c1.5-11.5 8.4-18 18-18s16.5 6.5 18 18z" fill="#3b82f6" />
    </svg>
  );
}

export function CharacterAvatar({
  image,
  gender,
  stateId,
  size = 64,
  className = '',
}: {
  image?: CharacterStateImage;
  gender: CharacterGender;
  stateId?: string;
  size?: number;
  className?: string;
}) {
  const headKey = image?.headKey;
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(() => {
    const url = peekHeadshot(headKey);
    return headKey && url ? { key: headKey, url } : null;
  });

  useEffect(() => {
    let alive = true;
    const cached = peekHeadshot(headKey);
    setLoaded(headKey && cached ? { key: headKey, url: cached } : null);
    if (!headKey) return;
    void loadHeadshot(headKey).then((v) => {
      if (alive && v) setLoaded({ key: headKey, url: v });
    });
    return () => {
      alive = false;
    };
  }, [headKey]);

  // 必须“当前 key 已加载”才显示头像：切换状态时不会闪出上一张头像
  const kind = headKey && loaded?.key === headKey ? 'headshot' : gender;
  return (
    <div
      className={`shrink-0 overflow-hidden rounded-full bg-slate-100 ring-2 ring-white shadow-md ${className}`}
      style={{ width: size, height: size }}
      data-testid="character-avatar"
      data-avatar-kind={kind}
      data-avatar-key={headKey ?? ''}
      data-state-id={stateId ?? ''}
      title={kind === 'headshot' ? '人物头像（从形象大图裁切）' : `未设置头像，显示${gender === 'female' ? '女' : '男'}性剪影`}
    >
      {kind === 'headshot' && loaded ? (
        <img src={loaded.url} alt="" draggable={false} className="h-full w-full object-cover" />
      ) : (
        <div className={`h-full w-full ${FALLBACK_BG[gender]}`}>
          <Silhouette gender={gender} />
        </div>
      )}
    </div>
  );
}
