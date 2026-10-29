/** 创作台属性面板（左侧停靠，可关闭）：选中单个节点时在此编辑其属性——
 *  🧑 人物 = 人名 + 性别（v3 人物库：身份写库，全部画布放置同步生效）+ 状态（年龄/基础信息/身份信息/关系信息/人物形象，
 *  写入当前画布放置正在显示的状态；未放置的人物不能在这里改状态属性）
 *  + 人物形象（v2.31：每状态一张大图，从大图手动裁出圆形头像）；🏗 环境 = 名称 + 类型 + 描述。
 *  节点面上只展示不输入（v2.3 用户拍板）。
 *  v2.4：面板放左侧、✕ 可关闭、点击节点**不自动弹出**——由顶栏「⚙ 属性」开关；已打开时点节点即切换显示。
 *  v2.28：未选中任何节点时显示「本书属性」（书名/封面/概览）——封面上传后存进作品状态，书架上显示；多选仍只提示。
 *  RF 外受控输入没问题（约定 7）。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Crop, Image as ImageIcon, Landmark, Layers, Mars, Pencil, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, UserRound, Venus, X } from 'lucide-react';
import { useStudioStore, useActiveNodes, type CharacterStateError } from '../../stores/studioStore';
import {
  CHARACTER_IMAGE_PRESET_DIMS,
  CHARACTER_IMAGE_PRESETS,
  genderOf,
  ENV_TYPE_LABELS,
  type CharacterGender,
  type CharacterImagePreset,
  type CharacterPlacementData,
  type CharacterState,
  type CharacterStateImage,
  type EnvironmentType,
  type SimNodeType,
  type WorkCharacter,
} from '../../types/sim';
import { characterActiveState, characterStateIndex, nextStateLabel } from '../../stores/characterStates';
import { GENDER_STYLE } from './SimNodes';
import { CharacterAvatar } from './CharacterAvatar';
import { CharacterCropDialog } from './CharacterCropDialog';
import { referenceChapterText, stateReferenceSummary, type StateReferenceSummary } from '../../stores/snapshotRefs';
import {
  prepareCharacterImageFile,
  prepareCharacterImageUrl,
  saveFullImage,
} from '../../services/characterImages';
import { bookHue, makeBookCover } from '../../services/bookCover';
import { localImgGet } from '../../services/localImages';

import { genCharacterImage } from '../../engines/studioEngine';
import { useEditorRoomStore } from '../../stores/editorRoomStore';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Field, Input, Select, Textarea } from '../ui/Field';

export function SimInspector({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nodes = useActiveNodes();
  const characters = useStudioStore((s) => s.characters);
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
    const character = characters[d.characterId];
    title = '人物属性';
    icon = <UserRound />;
    if (!character) {
      // 库记录缺失（sanitize 会清掉悬空放置，此处仅兜底渲染）
      body = (
        <p className="text-[13px] leading-relaxed text-slate-400">
          该放置的人物已不在人物库中，可从画布移除此节点。
        </p>
      );
    } else {
      const state = characterActiveState(character, d.activeStateId);
      const id = d.characterId;
      body = (
        <>
          <Field label="人名">
            <Input
              autoFocus
              value={character.name}
              maxLength={12}
              onChange={(e) => st.updateCharacter(id, { name: e.target.value })}
              placeholder="人名"
            />
          </Field>
          <div className="mt-2 flex items-center gap-2">
            <span className="shrink-0 text-[12px] font-medium text-slate-500">性别</span>
            <div className="flex gap-1">
              {(['male', 'female'] as CharacterGender[]).map((g) => {
                const gs = GENDER_STYLE[g];
                const active = genderOf(character.gender) === g;
                return (
                  <button
                    key={g}
                    onClick={() => st.updateCharacter(id, { gender: g })}
                    title={`性别：${gs.label}（写库，全部画布放置同步生效；决定节点配色）`}
                    className={`flex items-center gap-1 rounded-[8px] border px-3 py-1.5 text-[12px] transition ${
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
          <CharacterStateBar characterId={id} character={character} activeStateId={d.activeStateId} />
          <Field label="年龄">
            <Input
              type="number"
              min={0}
              max={999}
              value={typeof state.age === 'number' && Number.isFinite(state.age) ? state.age : ''}
              onChange={(e) => {
                const v = e.target.value.trim();
                const n = Math.round(Number(v));
                st.updateActiveCharacterState(id, {
                  age: v === '' || !Number.isFinite(n) ? undefined : Math.max(0, Math.min(999, n)),
                });
              }}
              placeholder="岁"
            />
          </Field>
          <CharacterImageSection characterId={id} state={state} gender={genderOf(character.gender)} />
          <Label>基础信息</Label>
          <Textarea
            value={state.basicInfo}
            onChange={(e) => st.updateActiveCharacterState(id, { basicInfo: e.target.value })}
            placeholder="长相、身材、习惯穿搭与性格，如：身形清瘦高挑，常穿洗旧的靛蓝长衫；寡言，遇事先观察再开口…"
            rows={4}
            className="resize-none"
          />
          <Label>身份信息</Label>
          <Textarea
            value={state.identityInfo}
            onChange={(e) => st.updateActiveCharacterState(id, { identityInfo: e.target.value })}
            placeholder="职业、身份、与故事相关的特殊设计，如：药铺学徒，实为前朝医官后人；随身药箱里藏着半张城防图…"
            rows={4}
            className="resize-none"
          />
          <Label>关系信息</Label>
          <Textarea
            value={state.relations ?? ''}
            onChange={(e) => st.updateActiveCharacterState(id, { relations: e.target.value })}
            placeholder="与其他人物的关系，如：李刚之父；与王明有旧怨（可留空，编辑室可填充）"
            rows={3}
            className="resize-none"
          />
        </>
      );
    }
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
  const nodeCount = useStudioStore((s) => Object.values(s.boards).reduce((n, b) => n + b.nodes.length, 0));
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
        {nodeCount} 节点（全部画布） · {chapterCount} 章 · {volumeCount} 卷
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">封面随作品保存，书架显示最近保存的封面。</p>
    </>
  );
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const STATE_ERR_TEXT: Record<CharacterStateError, string> = {
  'not-found': '人物或状态不存在',
  'base-not-found': '要复制的基准状态不存在',
  'empty-label': '状态名不能为空',
  'duplicate-label': '同一人物内已有同名状态',
  protected: '默认状态（首项）不可删除，可重命名',
  'last-state': '人物至少保留一个状态',
  unplaced: '该人物未放置在当前画布，放置后才能修改其当前状态',
};

/** 🧬 状态条（v2.30 · v3 人物库）：状态属人物库记录——切换=当前画布放置级（写放置不写库）；
 *  新建/重命名/删除=库级，影响该人物全部画布放置。状态属性由下方表单写当前状态。
 *  （人物库面板复用：activeStateId 缺省=首项状态，切换仍作用于当前画布放置，未放置时提示 unplaced。） */
export function CharacterStateBar({
  characterId,
  character,
  activeStateId,
}: {
  characterId: string;
  character: WorkCharacter;
  activeStateId?: string;
}) {
  const state = characterActiveState(character, activeStateId);
  const index = characterStateIndex(character, state.id);
  const chapters = useStudioStore((s) => s.chapters);
  const st = useStudioStore.getState();
  const refs: StateReferenceSummary = useMemo(
    () => stateReferenceSummary(chapters, characterId, state.id),
    [chapters, characterId, state.id],
  );

  const add = () => {
    const label = window.prompt(
      `新状态名称（将复制「${state.label}」的属性与形象，创建后切到新状态；全部画布放置可用）`,
      nextStateLabel(character.states),
    );
    if (label === null) return;
    const r = st.addCharacterState(characterId, { label, baseStateId: state.id, activate: true });
    if (!r.ok) window.alert(`⚠ ${STATE_ERR_TEXT[r.error]}`);
  };

  const rename = () => {
    const label = window.prompt('状态名称（同一人物内唯一，如「重伤后」）', state.label);
    if (label === null) return;
    const r = st.renameCharacterState(characterId, state.id, label);
    if (!r.ok) window.alert(`⚠ ${STATE_ERR_TEXT[r.error]}`);
  };

  const remove = () => {
    if (index === 0) return;
    const impact = refs.count
      ? `\n\n该状态被 ${refs.count} 章引用：${referenceChapterText(refs, 6)}。删除后这些章节在切回同步前会显示「资料缺失」；章节场景会随画布自动同步。`
      : '';
    if (!window.confirm(`删除状态「${state.label}」？该状态的人物设定与形象引用会一并移除（其它状态仍在用的图片不会被删）。${impact}`)) return;
    const r = st.deleteCharacterState(characterId, state.id);
    if (!r.ok) window.alert(`⚠ ${STATE_ERR_TEXT[r.error]}`);
  };

  const defaultLabel = `状态${index}`;
  return (
    <div className="mt-2" title="点击数字切换当前画布显示的状态；状态属性属人物库，修改一处全局生效">
      <div className="flex items-center gap-1.5">
        <Layers className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {character.states.map((s, i) => {
            const active = s.id === state.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => st.switchCharacterState(characterId, s.id)}
                title={`切换到状态 ${i}：${s.label}${i === 0 ? '（默认）' : ''}`}
                aria-label={`切换到状态 ${i}：${s.label}`}
                aria-pressed={active}
                className={`h-7 min-w-7 rounded-[8px] border px-1.5 text-[12px] font-medium tabular-nums transition ${
                  active
                    ? 'border-brand-500 bg-brand-50 text-brand-700 ring-2 ring-brand-100'
                    : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                {i}
              </button>
            );
          })}
          <IconButton
            icon={<Plus />}
            title="新建状态：复制当前状态的全部属性与形象引用（库级，全部画布可用），并切到新状态"
            onClick={add}
          />
        </div>
        {state.label !== defaultLabel && (
          <span className="max-w-[72px] shrink-0 truncate text-[11px] text-slate-400" title={`当前状态：${state.label}`}>
            {state.label}
          </span>
        )}
        <IconButton icon={<Pencil />} title="重命名当前状态（状态 ID 不变）" onClick={rename} />
        <IconButton
          icon={<Trash2 />}
          title={index === 0 ? STATE_ERR_TEXT.protected : '删除当前状态（默认状态不可删）'}
          onClick={remove}
          disabled={index === 0}
          danger={index !== 0}
        />
      </div>
      {refs.count > 0 && (
        <p
          className="mt-1 pl-5 text-[10px] leading-relaxed text-amber-600"
          title={`被 ${refs.count} 章引用：${refs.chapters.map((c) => c.title).join('、')}\n修改当前状态属性会改变这些历史章节的生成内容；章节场景会随画布自动同步。`}
          data-state-refs={refs.count}
        >
          被 {refs.count} 章引用 · 修改会影响历史章
        </p>
      )}
      <p className="mt-1 truncate pl-5 text-[10px] leading-relaxed text-slate-400">
        点击数字切换 · ＋ 复制当前状态并新建
      </p>
    </div>
  );
}

type CropTarget = {
  stateId: string;
  stateLabel: string;
  image: CharacterStateImage;
  fullUrl: string;
};

/** 🖼 人物形象区（v2.31，按状态 · v3 人物库）：形象属人物库状态——写入后该人物全部画布放置同步生效。
 *  - 上传：保留原图尺寸（最长边 >4096 等比缩小）；
 *  - AI：按所选预设构图生成，再在客户端裁切/缩放到精确像素；
 *  - 头像：从大图手动框选头部，生成 256×256 圆形头像；未裁切时画布显示性别剪影；
 *  - 大图/头像本体只进 IndexedDB，状态里只存元数据。
 *  （人物库面板复用：纯库级操作，不依赖画布上下文。） */
export function CharacterImageSection({
  characterId,
  state,
  gender,
}: {
  characterId: string;
  state: CharacterState;
  gender: CharacterGender;
}) {
  const image = state.image;
  const [fullUrl, setFullUrl] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'prompt' | 'image' | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<CharacterImagePreset>('1:1');
  const [zoom, setZoom] = useState(false);
  const [cropTarget, setCropTarget] = useState<CropTarget | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stateIdRef = useRef(state.id);
  stateIdRef.current = state.id;

  // 大图从 IndexedDB 读取；元数据存在但字节缺失（换浏览器/被清理）时给出明确提示
  useEffect(() => {
    let alive = true;
    setFullUrl(undefined);
    setErr('');
    if (!image?.key) return;
    void localImgGet(image.key)
      .then((v) => {
        if (!alive) return;
        if (v) setFullUrl(v);
        else setErr('形象文件缺失（可能来自其它浏览器或已被清理），请重新上传或生成。');
      })
      .catch(() => {
        if (alive) setErr('读取本地形象失败，请刷新后重试。');
      });
    return () => {
      alive = false;
    };
  }, [characterId, state.id, image?.key]);

  const openCrop = async (img: CharacterStateImage, sid: string, label: string, url?: string) => {
    let src = url ?? fullUrl;
    if (!src) {
      try {
        src = await localImgGet(img.key);
      } catch {
        src = undefined;
      }
    }
    if (!src) {
      setErr('形象文件缺失，无法裁切头像；请重新上传或生成。');
      return;
    }
    setCropTarget({ image: img, fullUrl: src, stateId: sid, stateLabel: label });
  };

  const onFile = async (file?: File) => {
    if (!file || busy) return;
    const sid = state.id;
    const label = state.label;
    setBusy(true);
    setErr('');
    try {
      // 上传始终保留原图尺寸（超 4096 长边等比缩小）；预设只用于 AI 生成
      const prepared = await prepareCharacterImageFile(file, 'original');
      const saved = await saveFullImage(characterId, sid, prepared, 'original');
      useStudioStore.getState().updateCharacterState(characterId, { image: saved.image }, sid);
      if (stateIdRef.current === sid) {
        setFullUrl(saved.dataUrl);
        setCropTarget({ image: saved.image, fullUrl: saved.dataUrl, stateId: sid, stateLabel: label });
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const generate = async () => {
    if (busy) return;
    const sid = state.id;
    const label = state.label;
    const preset = mode;
    setBusy(true);
    setErr('');
    setStage('prompt');
    try {
      const engine = useEditorRoomStore.getState().settings.engine;
      const r = await genCharacterImage({ characterId, stateId: sid, engine, preset, onStage: setStage });
      if (!r.ok || !r.url) throw new Error(r.error || '生成失败');
      const prepared = await prepareCharacterImageUrl(r.url, preset);
      const saved = await saveFullImage(characterId, sid, prepared, preset);
      useStudioStore.getState().updateCharacterState(characterId, { image: saved.image }, sid);
      if (stateIdRef.current === sid) {
        setFullUrl(saved.dataUrl);
        setCropTarget({ image: saved.image, fullUrl: saved.dataUrl, stateId: sid, stateLabel: label });
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
      setStage(null);
    }
  };

  const remove = () => {
    if (!image || busy) return;
    if (!window.confirm(`移除「${state.label}」的人物形象与头像？（其它状态仍在使用的图片不会被删）`)) return;
    useStudioStore.getState().updateCharacterState(characterId, { image: undefined }, state.id);
    setFullUrl(undefined);
    setZoom(false);
    setCropTarget(null);
  };

  const presetLabel =
    image?.preset === 'original' ? '原图尺寸' : image?.preset ? CHARACTER_IMAGE_PRESET_DIMS[image.preset].label : '';
  const avatarHint = !image
    ? `未设置形象，画布显示${gender === 'female' ? '女' : '男'}性剪影`
    : image.headKey
      ? '已裁切头像'
      : `未裁切头像，画布显示${gender === 'female' ? '女' : '男'}性剪影`;

  return (
    <div data-testid="character-image-section">
      <Label>人物形象</Label>
      {image && fullUrl ? (
        <button
          type="button"
          onClick={() => setZoom(true)}
          title="点击查看完整大图"
          className="block w-full overflow-hidden rounded-[10px] border border-slate-200 bg-slate-100"
          data-testid="character-image-full"
        >
          <img src={fullUrl} alt={`${state.label}人物形象`} draggable={false} className="h-44 w-full object-contain" />
        </button>
      ) : image ? (
        <div className="flex h-32 w-full items-center justify-center rounded-[10px] border border-dashed border-amber-300 bg-amber-50/60 px-3 text-center text-[12px] leading-relaxed text-amber-700">
          形象文件缺失，请重新上传或生成
        </div>
      ) : (
        <div className="flex h-32 w-full flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-slate-300 bg-slate-50 px-3 text-center text-[12px] leading-relaxed text-slate-400">
          <CharacterAvatar image={undefined} gender={gender} stateId={state.id} size={52} />
          <span>当前状态还没有人物形象</span>
        </div>
      )}

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-slate-400">
        <span className="min-w-0 truncate">
          {image ? `${image.width}×${image.height} · ${presetLabel}` : 'PNG / JPEG / WebP · 最大 20MB · 上传保留原尺寸'}
        </span>
        {busy && <span className="shrink-0 text-brand-600">{stage === 'prompt' ? '生成提示词…' : '生成图片…'}</span>}
      </div>

      <div className="mt-2 flex items-center gap-2 rounded-[10px] border border-slate-200 bg-white p-2">
        <CharacterAvatar image={image} gender={gender} stateId={state.id} size={46} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-slate-600">画布头像</div>
          <div className="mt-0.5 text-[11px] leading-snug text-slate-400" data-avatar-status>
            {avatarHint}
          </div>
        </div>
      </div>

      <div className="mt-2">
        <label className="mb-1 block text-[11px] text-slate-400" htmlFor="character-image-size">
          AI 生成尺寸（上传保留原图尺寸）
        </label>
        <Select
          id="character-image-size"
          value={mode}
          onChange={(e) => setMode(e.target.value as CharacterImagePreset)}
          disabled={busy}
          title="AI 按所选比例构图生成，并在本地裁切/缩放到精确像素；上传图片则始终保留原尺寸（最长边超过 4096 时等比缩小）。"
          data-testid="character-image-size"
        >
          {CHARACTER_IMAGE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {CHARACTER_IMAGE_PRESET_DIMS[p].label}（{p}）
            </option>
          ))}
        </Select>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          icon={<Upload />}
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title="上传本地图片作为当前状态的人物形象；成功后自动打开头像裁切"
          data-testid="character-image-upload"
        >
          上传
        </Button>
        <Button
          type="button"
          size="sm"
          variant={image ? 'secondary' : 'primary'}
          icon={<Sparkles />}
          onClick={() => void generate()}
          disabled={busy}
          title={busy ? '正在生成' : 'AI 按当前状态的基础信息与身份信息写生图提示词，生成单张完整人物形象；成功后自动打开头像裁切'}
          data-testid="character-image-ai"
        >
          {busy ? '生成中…' : image ? '重新生成' : 'AI 生成'}
        </Button>
        <Button
          type="button"
          size="sm"
          icon={<Crop />}
          onClick={() => image && void openCrop(image, state.id, state.label)}
          disabled={busy || !image || !fullUrl}
          title={image ? '从大图中框选头部区域作为画布圆形头像' : '先上传或生成人物形象，再选取头像'}
          data-testid="character-image-crop"
        >
          {image?.headKey ? '调整头像' : '选取头像'}
        </Button>
        {image && (
          <Button
            type="button"
            size="sm"
            icon={<Trash2 />}
            onClick={remove}
            disabled={busy}
            title="移除当前状态的人物形象与头像引用；其它状态/镜像仍在用的图片会保留"
            data-testid="character-image-remove"
          >
            移除
          </Button>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        data-testid="character-image-file-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = '';
        }}
      />

      {err && <p className="mt-1.5 text-[12px] leading-relaxed text-rose-500">{err}</p>}
      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
        大图与头像只保存在本机浏览器，随人物状态元数据引用；导出到其它浏览器后需重新设置图片。
      </p>

      {cropTarget && (
        <CharacterCropDialog
          characterId={characterId}
          stateId={cropTarget.stateId}
          stateLabel={cropTarget.stateLabel}
          image={cropTarget.image}
          fullDataUrl={cropTarget.fullUrl}
          onClose={() => setCropTarget(null)}
        />
      )}

      {zoom &&
        image &&
        fullUrl &&
        createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-6"
            data-testid="character-image-zoom"
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
            <img
              src={fullUrl}
              alt={`${state.label}人物形象原图`}
              draggable={false}
              className="max-h-[92vh] max-w-[94vw] rounded-[16px] object-contain shadow-2xl"
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
