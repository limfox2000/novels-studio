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
import { BookOpen, Image as ImageIcon, Landmark, Layers, Mars, Pencil, Plus, SlidersHorizontal, Trash2, Upload, UserRound, Venus, X } from 'lucide-react';
import { useStudioStore, useActiveNodes, type CharacterStateError } from '../../stores/studioStore';
import {
  genderOf,
  ENV_TYPE_LABELS,
  type CharacterData,
  type CharacterGender,
  type CharacterState,
  type EnvironmentType,
  type SimNodeType,
} from '../../types/sim';
import {
  activeCharacterState,
  characterStateIndex,
  nextStateLabel,
  portraitKeyForState,
} from '../../stores/characterStates';
import { GENDER_STYLE } from './SimNodes';
import { referenceChapterText, stateReferenceSummary, type StateReferenceSummary } from '../../stores/snapshotRefs';
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
  const nodes = useActiveNodes();
  const activeBoardId = useStudioStore((s) => s.activeBoardId);
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
    const state = activeCharacterState(d);
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
        <div className="mt-2 flex items-center gap-2">
          <span className="shrink-0 text-[12px] font-medium text-slate-500">性别</span>
          <div className="flex gap-1">
            {(['male', 'female'] as CharacterGender[]).map((g) => {
              const gs = GENDER_STYLE[g];
              const active = genderOf(d.gender) === g;
              return (
                <button
                  key={g}
                  onClick={() => st.updateCharacter(id, { gender: g })}
                  title={`性别：${gs.label}（跨状态稳定，决定节点配色）`}
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
        <CharacterStateBar nodeId={id} data={d} boardId={activeBoardId} />
        <div className="mt-2 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <Label>年龄</Label>
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
          </div>
          <div className="shrink-0">
            <Label>形象</Label>
            <CharAvatarPicker
              value={state.avatar}
              gender={genderOf(d.gender) === 'female' ? '女' : '男'}
              stage={charStageOf(state.age)}
              onChange={(v) => st.updateActiveCharacterState(id, { avatar: v })}
            />
          </div>
        </div>
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
        <Label>写真</Label>
        <PortraitBox nodeId={id} state={state} />
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

const MAX_CHARASSET_BYTES = 5 * 1024 * 1024;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const STATE_ERR_TEXT: Record<CharacterStateError, string> = {
  'not-found': '人物或状态不存在',
  'base-not-found': '要复制的基准状态不存在',
  'empty-label': '状态名不能为空',
  'duplicate-label': '同一人物内已有同名状态',
  protected: '默认状态（首项）不可删除，可重命名',
  'last-state': '人物至少保留一个状态',
};

/** 状态引用是否仍被任何画布上的任何人物状态使用（跨卷镜像会共享同一写真 key） */
function portraitKeyReferenced(key: string): boolean {
  return Object.values(useStudioStore.getState().boards).some((b) =>
    b.nodes.some((n) => n.data.kind === 'character' && n.data.states.some((st) => st.portraitKey === key)),
  );
}

/** 清掉最后一个引用后才删除 IndexedDB 图片，避免误删其它状态/镜像仍在用的共享写真 */
function releasePortraitKey(key: string | undefined): void {
  if (!key || portraitKeyReferenced(key)) return;
  void localImgDel(key).catch(() => {});
}

/** 🧬 状态条（v2.30）：切换/新建（复制当前）/重命名/删除。状态属性由下方表单写当前状态。 */
function CharacterStateBar({ nodeId, data, boardId }: { nodeId: string; data: CharacterData; boardId: string }) {
  const state = activeCharacterState(data);
  const index = characterStateIndex(data, state.id);
  const chapters = useStudioStore((s) => s.chapters);
  const st = useStudioStore.getState();
  const refs: StateReferenceSummary = useMemo(
    () => stateReferenceSummary(chapters, boardId, nodeId, state.id),
    [chapters, boardId, nodeId, state.id],
  );

  const add = () => {
    const label = window.prompt(
      `新状态名称（将复制「${state.label}」的属性与写真，创建后切到新状态）`,
      nextStateLabel(data.states),
    );
    if (label === null) return;
    const r = st.addCharacterState(nodeId, { label, baseStateId: state.id, activate: true });
    if (!r.ok) window.alert(`⚠ ${STATE_ERR_TEXT[r.error]}`);
  };

  const rename = () => {
    const label = window.prompt('状态名称（同一人物内唯一，如「重伤后」）', state.label);
    if (label === null) return;
    const r = st.renameCharacterState(nodeId, state.id, label);
    if (!r.ok) window.alert(`⚠ ${STATE_ERR_TEXT[r.error]}`);
  };

  const remove = () => {
    if (index === 0) return;
    const impact = refs.count
      ? `\n\n该状态被 ${refs.count} 章引用：${referenceChapterText(refs, 6)}。删除后这些章节继续引用原状态 ID，将显示「资料缺失」，快照不会自动更新。`
      : '';
    if (!window.confirm(`删除状态「${state.label}」？切到该状态的人物设定与写真引用会一并移除（其它状态仍在用的图片不会被删）。${impact}`)) return;
    const r = st.deleteCharacterState(nodeId, state.id);
    if (!r.ok) {
      window.alert(`⚠ ${STATE_ERR_TEXT[r.error]}`);
      return;
    }
    releasePortraitKey(r.removed?.portraitKey);
  };

  const defaultLabel = `状态${index}`;
  return (
    <div className="mt-2" title="点击数字切换状态；画布、属性表单、写真与章节生成都使用当前状态">
      <div className="flex items-center gap-1.5">
        <Layers className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {data.states.map((s, i) => {
            const active = s.id === state.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => st.switchCharacterState(nodeId, s.id)}
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
            title="新建状态：复制当前状态的全部属性与写真引用，并切换到新状态"
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
          title={`被 ${refs.count} 章引用：${refs.chapters.map((c) => c.title).join('、')}\n修改当前状态属性会改变这些历史章节的画布表现；快照不会自动更新。`}
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

/** 🎨 写真区（v2.19b / v2.30 按状态）：点「生成写真」→ 先驱动文本双模型按**当前状态**写生图提示词，再调生图 API。
 *  图片只保留在浏览器本地（IndexedDB）：规范 key=portrait:<nodeId>:<stateId>，旧写真 key=portrait:<nodeId>。
 *  生成总是 copy-on-write 写当前状态的规范 key，不覆盖从基准状态继承来的图片；点图放大看原图。 */
function PortraitBox({ nodeId, state }: { nodeId: string; state: CharacterState }) {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'prompt' | 'image' | null>(null);
  const [err, setErr] = useState('');
  const [zoom, setZoom] = useState(false);
  const stateIdRef = useRef(state.id);
  stateIdRef.current = state.id;

  // 本地读写真：引用可能来自基准状态（继承），所以按 state.portraitKey 读，而不是按规范 key 推导
  useEffect(() => {
    let alive = true;
    setUrl(undefined);
    setErr('');
    if (state.portraitKey) {
      void localImgGet(state.portraitKey)
        .then((v) => {
          if (alive && v) setUrl(v);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [nodeId, state.id, state.portraitKey]);

  const gen = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    setStage('prompt');
    try {
      const engine = useEditorRoomStore.getState().settings.engine;
      const r = await genCharacterPortrait({ id: nodeId, stateId: state.id, engine, onStage: setStage });
      if (r.ok && r.url) {
        const key = portraitKeyForState(nodeId, state.id);
        const data = await localImgSaveFromUrl(key, r.url); // 抢在服务器 GC 前转存本地
        useStudioStore.getState().updateCharacterState(nodeId, { portraitKey: key }, state.id);
        if (stateIdRef.current === state.id) setUrl(data);
      } else if (stateIdRef.current === state.id) setErr(r.error || '生成失败');
    } catch (e) {
      if (stateIdRef.current === state.id) setErr(errMsg(e));
    } finally {
      setBusy(false);
      setStage(null);
    }
  };

  const remove = () => {
    const oldKey = state.portraitKey;
    useStudioStore.getState().updateCharacterState(nodeId, { portraitKey: undefined }, state.id);
    setUrl(undefined);
    releasePortraitKey(oldKey);
  };

  return (
    <div>
      {url ? (
        <button
          type="button"
          onClick={() => setZoom(true)}
          title={`点击放大查看「${state.label}」写真原图`}
          className="block w-full overflow-hidden rounded-[10px] border border-slate-200 bg-slate-50"
        >
          <img src={url} alt={`${state.label}人物写真`} draggable={false} className="h-36 w-full object-cover" />
        </button>
      ) : (
        <div className="flex h-36 w-full items-center justify-center rounded-[10px] border border-dashed border-slate-300 bg-slate-50 px-3 text-center text-[12px] leading-relaxed text-slate-400">
          {busy ? (stage === 'prompt' ? '正在生成提示词…' : '正在生成图片…（约 1-2 分钟）') : `「${state.label}」暂无写真——点下方按钮由 AI 生成`}
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
                ? `重新生成「${state.label}」写真（只覆盖当前状态）`
                : 'AI 先按当前状态的基础信息与身份信息写生图提示词，再调用生图 API 出立绘（图片保存在浏览器本地）'
          }
        >
          {busy ? (stage === 'prompt' ? '提示词中…' : '生成图片中…') : url ? '重新生成' : '生成写真'}
        </Button>
        {url && !busy && (
          <Button
            type="button"
            size="sm"
            icon={<Trash2 />}
            onClick={remove}
            title="移除当前状态的写真引用；若图片仍被其它状态/镜像使用则保留本地图片"
          >
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
            <img src={url} alt={`${state.label}人物写真原图`} draggable={false} className="max-h-[92vh] max-w-[94vw] rounded-[16px] shadow-2xl" />
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
        className="flex h-14 w-14 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 transition hover:bg-slate-100"
      >
        <img
          src={charAssetUrl(current)}
          alt=""
          draggable={false}
          className="h-12 w-12 object-contain"
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
