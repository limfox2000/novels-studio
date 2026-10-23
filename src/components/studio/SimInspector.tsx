/** 创作台属性面板（左侧停靠，可关闭）：选中单个节点时在此编辑其属性——
 *  🧑 人物 = 人名 + 性别（基础属性：男/女，决定节点配色）+ 形象（v2.21，服务器人物素材库）+ 年龄（v2.20）
 *  + 基础信息（v2.27：长相/身材/习惯穿搭/性格）+ 身份信息（v2.27：职业/身份/与故事相关的特殊设计）
 *  + 关系信息（v2.20，人物间关系，编辑室可填充）；🏗 环境 = 名称 + 类型 + 描述。
 *  节点面上只展示不输入（v2.3 用户拍板）。
 *  v2.4：面板放左侧、✕ 可关闭、点击节点**不自动弹出**——由顶栏「⚙ 属性」开关；已打开时点节点即切换显示。
 *  v2.28：未选中任何节点时显示「本书属性」（书名/封面/概览）——封面上传后存进作品状态，书架上显示；多选仍只提示。
 *  RF 外受控输入没问题（约定 7）。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Image as ImageIcon, Landmark, Mars, Plus, SlidersHorizontal, Trash2, Upload, UserRound, Venus, X } from 'lucide-react';
import { useStudioStore } from '../../stores/studioStore';
import { genderOf, ENV_TYPE_LABELS, type CharacterGender, type EnvironmentType, type SimNodeType } from '../../types/sim';
import { GENDER_STYLE } from './SimNodes';
import {
  CHARASSET_NAME_RE,
  DEFAULT_CHARASSET,
  charAssetUrl,
  charStageOf,
  deleteCharAsset,
  listCharAssets,
  uploadCharAsset,
  type CharAsset,
  type CharAssetGender,
  type CharAssetStage,
} from '../../services/charAssetApi';
import { fileToDataUrl } from '../../services/imgApi';
import { bookHue, makeBookCover } from '../../services/bookCover';
import { localImgDel, localImgGet, localImgSaveFromUrl } from '../../services/localImages';
import { genCharacterPortrait } from '../../engines/studioEngine';
import { useEditorRoomStore } from '../../stores/editorRoomStore';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { Dialog } from '../ui/Dialog';

export function SimInspector({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nodes = useStudioStore((s) => s.nodes);
  const selectedNodes = useMemo(() => nodes.filter((n) => n.selected), [nodes]);
  // 单选才显示节点属性；未选中=本书属性；多选只提示
  const selected: SimNodeType | null = selectedNodes.length === 1 ? selectedNodes[0] : null;

  if (!open) return null;
  const st = useStudioStore.getState();

  let title = '属性';
  let icon: ReactNode = <SlidersHorizontal />;
  let body: ReactNode = (
    <p className="text-[13px] leading-relaxed text-slate-400">
      已选择 {selectedNodes.length} 个节点（多选时不显示具体属性）。
    </p>
  );

  if (selectedNodes.length === 0) {
    // 📕 什么都没选：显示本书属性（书名/封面/概览）——封面即书架上书封显示的内容
    title = '本书属性';
    icon = <BookOpen />;
    body = <BookProperties />;
  } else if (selected?.data.kind === 'character') {
    const d = selected.data;
    title = '人物属性';
    icon = <UserRound />;
    const id = selected.id;
    body = (
      <>
        <Field label="人名">
          <Input
            autoFocus
            value={d.name}
            maxLength={12}
            onChange={(e) => st.updateCharacter(id, { name: e.target.value })}
            placeholder="人名"
          />
        </Field>
        <div className="mt-2 flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-[12px] font-medium text-slate-500">性别</div>
            <div className="flex gap-1.5">
              {(['male', 'female'] as CharacterGender[]).map((g) => {
                const gs = GENDER_STYLE[g];
                const active = genderOf(d.gender) === g;
                return (
                  <button
                    key={g}
                    onClick={() => st.updateCharacter(id, { gender: g })}
                    title={`性别：${gs.label}（决定节点配色）`}
                    className={`flex flex-1 items-center justify-center gap-1 rounded-[10px] border py-2 text-[13px] transition ${
                      active
                        ? `${gs.capsule} border-transparent font-medium text-white`
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {g === 'male' ? <Mars className="h-3.5 w-3.5" /> : <Venus className="h-3.5 w-3.5" />}
                    {gs.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="w-20 shrink-0">
            <Field label="年龄">
              <Input
                type="number"
                min={0}
                max={999}
                value={typeof d.age === 'number' && Number.isFinite(d.age) ? d.age : ''}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  const n = Math.round(Number(v));
                  st.updateCharacter(id, { age: v === '' || !Number.isFinite(n) ? undefined : Math.max(0, Math.min(999, n)) });
                }}
                placeholder="岁"
              />
            </Field>
          </div>
        </div>
        <Label>形象</Label>
        <CharAvatarPicker
          value={d.avatar}
          gender={genderOf(d.gender) === 'female' ? '女' : '男'}
          stage={charStageOf(d.age)}
          onChange={(v) => st.updateCharacter(id, { avatar: v })}
        />
        <Label>基础信息</Label>
        <Textarea
          value={d.basicInfo}
          onChange={(e) => st.updateCharacter(id, { basicInfo: e.target.value })}
          placeholder="长相、身材、习惯穿搭与性格，如：身形清瘦高挑，常穿洗旧的靛蓝长衫；寡言，遇事先观察再开口…"
          rows={4}
          className="resize-none"
        />
        <Label>身份信息</Label>
        <Textarea
          value={d.identityInfo}
          onChange={(e) => st.updateCharacter(id, { identityInfo: e.target.value })}
          placeholder="职业、身份、与故事相关的特殊设计，如：药铺学徒，实为前朝医官后人；随身药箱里藏着半张城防图…"
          rows={4}
          className="resize-none"
        />
        <Label>关系信息</Label>
        <Textarea
          value={d.relations ?? ''}
          onChange={(e) => st.updateCharacter(id, { relations: e.target.value })}
          placeholder="与其他人物的关系，如：李刚之父；与王明有旧怨（可留空，编辑室可填充）"
          rows={3}
          className="resize-none"
        />
        <Label>写真</Label>
        <PortraitBox nodeId={id} />
      </>
    );
  } else if (selected) {
    const d = selected.data;
    title = '环境属性';
    icon = <Landmark />;
    const id = selected.id;
    body = (
      <>
        <Field label="名称">
          <Input
            autoFocus
            value={d.name}
            maxLength={16}
            onChange={(e) => st.updateEnvironment(id, { name: e.target.value })}
            placeholder="环境名"
          />
        </Field>
        <Label>类型</Label>
        <Select
          value={d.etype}
          onChange={(e) => st.updateEnvironment(id, { etype: e.target.value as EnvironmentType })}
          title="环境类型（表达尺度：房间/建筑/社区/城镇/区域；床=容纳人物休息的容器；物品=非容器的物件标记——告知 AI 此处存在一个东西）"
        >
          {(Object.entries(ENV_TYPE_LABELS) as Array<[EnvironmentType, string]>).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </Select>
        <Label>描述</Label>
        <Textarea
          value={d.desc}
          onChange={(e) => st.updateEnvironment(id, { desc: e.target.value })}
          placeholder="描述（外观/功能/氛围…）"
          rows={6}
          className="resize-none"
        />
      </>
    );
  }

  return (
    <div
      key={selected?.id ?? 'none'}
      className="absolute left-2 top-[calc(var(--topbar-h)+8px)] z-40 max-h-[70vh] w-72 overflow-y-auto rounded-[16px] border border-slate-200/80 bg-white/95 p-3 shadow-float backdrop-blur max-sm:w-56"
    >
      <div className="mb-2.5 flex items-center gap-1.5">
        <span className="shrink-0 text-slate-500 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-700">{title}</span>
        <IconButton icon={<X />} title="关闭属性面板（顶栏「属性」可再次打开）" onClick={onClose} />
      </div>
      {body}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-1 mt-2.5 text-[12px] font-medium text-slate-500">{children}</div>;
}

/** 📕 本书属性（未选中任何节点时）：书名 / 封面 / 作品概览。
 *  封面经 makeBookCover 压成 5:7 JPEG 存进作品状态，随存档保存并在书架上显示。 */
function BookProperties() {
  const graphName = useStudioStore((s) => s.graphName);
  const cover = useStudioStore((s) => s.cover);
  const nodeCount = useStudioStore((s) => s.nodes.length);
  const chapterCount = useStudioStore((s) => s.chapters.length);
  const volumeCount = useStudioStore((s) => s.volumes.length);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const hue = bookHue(graphName || '未命名');

  const pick = async (file?: File) => {
    if (!file || busy) return;
    setBusy(true);
    try {
      useStudioStore.getState().setCover(await makeBookCover(file));
    } catch (e) {
      window.alert(`⚠ 封面处理失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = ''; // 清空后可再次选择同一文件
    }
  };

  return (
    <>
      <Field label="书名">
        <Input
          value={graphName}
          maxLength={40}
          onChange={(e) => useStudioStore.getState().setGraphName(e.target.value)}
          placeholder="未命名"
        />
      </Field>
      <Label>封面</Label>
      <div className="flex items-start gap-2.5">
        <div
          className="relative aspect-[5/7] w-[76px] shrink-0 overflow-hidden rounded-[6px] border border-slate-200 shadow-sm"
          style={{ background: `linear-gradient(155deg, hsl(${hue} 42% 90%), hsl(${hue} 38% 76%))` }}
        >
          {cover ? (
            <img src={cover} alt="作品封面" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-slate-400/80">
              <ImageIcon className="h-5 w-5" strokeWidth={1.75} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" icon={<Upload />} onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? '处理中…' : cover ? '更换封面' : '上传封面'}
            </Button>
            {cover && !busy && (
              <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => useStudioStore.getState().setCover('')}>
                移除
              </Button>
            )}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">自动按 5:7 居中裁切，随作品保存在本机。</p>
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
      <Label>作品概览</Label>
      <p className="text-[13px] text-slate-600">
        {nodeCount} 节点 · {chapterCount} 章 · {volumeCount} 卷
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">封面随作品保存，书架显示最近保存的封面。</p>
    </>
  );
}

const MAX_CHARASSET_BYTES = 5 * 1024 * 1024;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 🎨 写真区（v2.19b）：点「生成写真」→ 先驱动文本双模型按人物设定写生图提示词，再调生图 API 出单人立绘。
 *  图片只保留在浏览器本地（IndexedDB，key=portrait:<nodeId>，services/localImages.ts）——不进节点数据/存档，
 *  服务器临时文件由 media GC 自动回收；点图放大看原图。 */
function PortraitBox({ nodeId }: { nodeId: string }) {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'prompt' | 'image' | null>(null);
  const [err, setErr] = useState('');
  const [zoom, setZoom] = useState(false);

  // 本地读写真：同一节点再次打开面板/刷新页面都能拿到（IndexedDB 读取失败静默回「暂无写真」）
  useEffect(() => {
    let alive = true;
    setUrl(undefined);
    setErr('');
    void localImgGet(`portrait:${nodeId}`)
      .then((v) => {
        if (alive && v) setUrl(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [nodeId]);

  const gen = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    setStage('prompt');
    try {
      const engine = useEditorRoomStore.getState().settings.engine;
      const r = await genCharacterPortrait({ id: nodeId, engine, onStage: setStage });
      if (r.ok && r.url) {
        const data = await localImgSaveFromUrl(`portrait:${nodeId}`, r.url); // 抢在服务器 GC 前转存本地
        setUrl(data);
      } else setErr(r.error || '生成失败');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
      setStage(null);
    }
  };

  const remove = () => {
    void localImgDel(`portrait:${nodeId}`).catch(() => {});
    setUrl(undefined);
  };

  return (
    <div>
      {url ? (
        <button
          type="button"
          onClick={() => setZoom(true)}
          title="点击放大查看原图"
          className="block w-full overflow-hidden rounded-[10px] border border-slate-200 bg-slate-50"
        >
          <img src={url} alt="人物写真" draggable={false} className="h-36 w-full object-cover" />
        </button>
      ) : (
        <div className="flex h-36 w-full items-center justify-center rounded-[10px] border border-dashed border-slate-300 bg-slate-50 px-3 text-center text-[12px] leading-relaxed text-slate-400">
          {busy ? (stage === 'prompt' ? '正在生成提示词…' : '正在生成图片…（约 1-2 分钟）') : '暂无写真——点下方按钮由 AI 生成'}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={url ? 'secondary' : 'primary'}
          icon={<ImageIcon />}
          onClick={() => void gen()}
          disabled={busy}
          title={
            busy
              ? stage === 'prompt'
                ? '正在生成提示词'
                : '正在调用生图 API'
              : url
                ? '重新生成写真（覆盖本地旧图）'
                : 'AI 先按人物基础信息与身份信息写生图提示词，再调用生图 API 出立绘（图片保存在浏览器本地）'
          }
        >
          {busy ? (stage === 'prompt' ? '提示词中…' : '生成图片中…') : url ? '重新生成' : '生成写真'}
        </Button>
        {url && !busy && (
          <Button type="button" size="sm" icon={<Trash2 />} onClick={remove} title="删除本地写真（浏览器 IndexedDB 中移除）">
            移除
          </Button>
        )}
      </div>
      {err && <p className="mt-1.5 text-[12px] leading-relaxed text-rose-500">{err}</p>}
      {zoom &&
        url &&
        createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-6"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setZoom(false);
            }}
          >
            <button
              type="button"
              onClick={() => setZoom(false)}
              className="absolute right-4 top-3 rounded-full bg-white/10 p-2 text-white/80 transition hover:bg-white/20 hover:text-white"
              title="关闭"
            >
              <X className="h-5 w-5" />
            </button>
            <img src={url} alt="人物写真原图" draggable={false} className="max-h-[92vh] max-w-[94vw] rounded-[16px] shadow-2xl" />
          </div>,
          document.body,
        )}
    </div>
  );
}

function CharAvatarPicker({
  value,
  gender,
  stage,
  onChange,
}: {
  value?: string;
  gender: CharAssetGender;
  stage: CharAssetStage | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const [assets, setAssets] = useState<CharAsset[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const current = value || DEFAULT_CHARASSET;
  const shown = stage ? assets.filter((a) => a.gender === gender && a.stage === stage) : [];
  const curLabel = current === DEFAULT_CHARASSET ? `${current}（默认）` : current;

  const reload = useCallback(async () => {
    try {
      setAssets(await listCharAssets());
    } catch (e) {
      setErr(`素材库加载失败：${errMsg(e)}`);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onFile = async (file: File) => {
    setErr('');
    if (!stage) return;
    if (file.size > MAX_CHARASSET_BYTES) {
      setErr('图片超过 5MB');
      return;
    }
    let name = file.name.replace(/\.[^.]+$/, '');
    if (!CHARASSET_NAME_RE.test(name)) {
      const input = window.prompt('素材名（英文/数字/-/_，1–40 字符，不可与已有素材重名）', '');
      if (!input) return;
      name = input.trim();
      if (!CHARASSET_NAME_RE.test(name)) {
        setErr('素材名不合法');
        return;
      }
    }
    setBusy(true);
    try {
      await uploadCharAsset(name, gender, stage, await fileToDataUrl(file));
      await reload();
      onChange(name === DEFAULT_CHARASSET ? undefined : name);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm(`删除素材「${id}」？使用它的人物将回落默认形象。`)) return;
    setErr('');
    try {
      await deleteCharAsset(id);
      if (current === id) onChange(undefined);
      await reload();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const pick = (id: string) => {
    onChange(id === DEFAULT_CHARASSET ? undefined : id);
    setOpen(false);
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`形象：${curLabel}（点击打开素材库）`}
        className="flex h-16 w-16 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 transition hover:bg-slate-100"
      >
        <img
          src={charAssetUrl(current)}
          alt=""
          draggable={false}
          className="h-14 w-14 object-contain"
          style={{ imageRendering: 'pixelated' }}
        />
      </button>
      {err && !open && <p className="mt-1 text-[12px] text-rose-500">{err}</p>}
      {open && (
        <Dialog
          onClose={() => setOpen(false)}
          z={60}
          width="sm"
          icon={<ImageIcon />}
          title="人物素材库"
          subtitle={stage ? `${gender}·${stage}（${shown.length} 张）` : '未设置年龄'}
        >
          {!stage && <p className="mb-2 text-[12px] text-slate-400">请先在属性中设置年龄，再选择对应年龄段的素材。</p>}
          <div className="grid grid-cols-4 gap-2">
            {shown.map((a) => {
              const active = a.id === current;
              const isDefault = a.id === DEFAULT_CHARASSET;
              return (
                <div key={a.id} className="group relative">
                  <button
                    type="button"
                    title={isDefault ? `${a.id}（默认形象）` : a.id}
                    onClick={() => pick(a.id)}
                    className={`flex w-full items-center justify-center rounded-[10px] border p-1 transition ${
                      active
                        ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-200'
                        : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                    }`}
                  >
                    <img
                      src={charAssetUrl(a.id)}
                      alt={a.id}
                      draggable={false}
                      className="h-12 w-12 object-contain"
                      style={{ imageRendering: 'pixelated' }}
                    />
                  </button>
                  {!isDefault && (
                    <button
                      type="button"
                      title={`删除素材 ${a.id}`}
                      onClick={() => void onDelete(a.id)}
                      className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-slate-600 text-white group-hover:flex"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
              );
            })}
            <label
              title={stage ? `上传到 ${gender}·${stage}（png/jpeg/webp，≤5MB）` : '请先设置年龄，再上传对应年龄段的素材'}
              className={`flex h-[60px] cursor-pointer items-center justify-center rounded-[10px] border border-dashed border-slate-300 text-slate-400 hover:bg-slate-100 ${
                busy || !stage ? 'pointer-events-none opacity-50' : ''
              }`}
            >
              <Plus className="h-5 w-5" />
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void onFile(f);
                }}
              />
            </label>
          </div>
          {err && <p className="mt-2 text-[12px] text-rose-500">{err}</p>}
        </Dialog>
      )}
    </div>
  );
}
