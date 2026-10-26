/** ⚙ 模型中心（v2.27）：模型相关配置统一管理，取代顶栏旧「模型配置」弹窗与编辑室设置里的模型项。
 *  - 文本模型：🏠 私有模型（自建/租用 GPU，地址随开关机变动）+ 🌐 公共模型（SaaS 中转，key 只存服务器、前端打码）；
 *  - 引擎与推理：对话/创作引擎、正文执笔引擎、推理强度（关闭/低/中/高）、编辑输出是否设上限；
 *  - 生图模型：默认轨 + 公共中转 + 私有 ComfyUI，带链路测试。
 *  所有状态放在本组件（切标签不丢、生图轮询不中断）；关面板即停止轮询。
 *  引擎与推理偏好存本机（editorRoomStore 持久化），模型地址/密钥存服务器 qwenconfig.json / imgconfig.json。 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Cpu, Globe, House, Image as ImageIcon, Loader2, RefreshCw, X } from 'lucide-react';
import {
  qwGetConfig,
  qwSaveConfig,
  qwPing,
  qwListModels,
  qwGetMeta,
  REASONING_EFFORTS,
  REASONING_EFFORT_LABEL,
  type QwenConfig,
  type QwenMeta,
  type ReasoningEffort,
  type TextEngine,
} from '../../shared/qwenClient';
import { imgLoadConfig, imgSaveConfig, imgSubmit, imgTask, imgRelayModels } from '../../services/imgApi';
import type { ImgConfig } from '../../types/image';
import { useEditorRoomStore } from '../../stores/editorRoomStore';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Field, Input, Select } from '../ui/Field';
import { Segmented } from '../ui/Segmented';
import { Switch } from '../ui/Switch';
import { Badge, StatusDot } from '../ui/Badge';

type Tab = 'text' | 'engine' | 'image';

/** 一张配置卡：图标 + 标题 + 右侧状态，内容独立成块（不是一串平铺字段） */
function Card({ icon, title, subtitle, aside, children }: { icon: ReactNode; title: string; subtitle?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[12px] border border-slate-200/80 bg-white p-3">
      <div className="mb-2.5 flex items-start gap-2">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-slate-100 text-slate-500 [&>svg]:h-3.5 [&>svg]:w-3.5">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-slate-700">{title}</div>
          {subtitle && <div className="mt-0.5 text-[12px] leading-relaxed text-slate-400">{subtitle}</div>}
        </div>
        {aside}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

/** 行内提示：普通说明 / 成功 / 警告（失败一律 ⚠ + 保留表单） */
function Note({ text, tone = 'info' }: { text: string; tone?: 'info' | 'ok' | 'warn' }) {
  if (!text) return null;
  const cls = tone === 'warn' ? 'text-rose-600' : tone === 'ok' ? 'text-emerald-600' : 'text-slate-500';
  return (
    <p className={`flex items-start gap-1 break-all text-[12px] leading-relaxed ${cls}`}>
      {tone === 'warn' && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      {tone === 'ok' && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0">{text}</span>
    </p>
  );
}

/** 失败态的措辞统一带 ⚠，用于判定 tone */
const toneOf = (msg: string): 'ok' | 'warn' | 'info' => (msg.startsWith('⚠') ? 'warn' : msg.startsWith('✓') ? 'ok' : 'info');

export function ModelCenterPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('text');

  // 引擎与推理偏好（本机持久化）
  const settings = useEditorRoomStore((s) => s.settings);
  const setSettings = useEditorRoomStore((s) => s.setSettings);

  // ── 文本模型 ──
  const [textLoaded, setTextLoaded] = useState(false);
  const [textLoadErr, setTextLoadErr] = useState('');
  const [priv, setPriv] = useState({ base_url: '', model: '' });
  const [privKey, setPrivKey] = useState('');
  const [privKeySet, setPrivKeySet] = useState(false);
  const [privBusy, setPrivBusy] = useState(false);
  const [privMsg, setPrivMsg] = useState('');
  const [pingStatus, setPingStatus] = useState<'idle' | 'checking' | 'ok' | 'down'>('idle');
  const [pingMsg, setPingMsg] = useState('');
  const [meta, setMeta] = useState<QwenMeta | null>(null);
  const [metaErr, setMetaErr] = useState('');

  const [pub, setPub] = useState({ base_url: '', model: '' });
  const [pubKey, setPubKey] = useState('');
  const [pubKeySet, setPubKeySet] = useState(false);
  const [pubModels, setPubModels] = useState<string[]>([]);
  const [pubBusy, setPubBusy] = useState(false);
  const [pubMsg, setPubMsg] = useState('');

  // ── 生图模型 ──
  const [img, setImg] = useState<ImgConfig | null>(null);
  const [imgLoadErr, setImgLoadErr] = useState('');
  const [imgKey, setImgKey] = useState('');
  const [imgPubModels, setImgPubModels] = useState<string[]>([]);
  const [imgPrivWorkflows, setImgPrivWorkflows] = useState<string[]>([]);
  const [imgMsg, setImgMsg] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  const [imgProbe, setImgProbe] = useState<{ status: 'testing' | 'ok' | 'failed'; url?: string; error?: string } | null>(null);

  const closedRef = useRef(false);
  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
    };
  }, []);

  // ESC 关闭（与书架/编辑器一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const loadText = () => {
    setTextLoadErr('');
    qwGetConfig()
      .then((c) => {
        if (closedRef.current) return;
        setPriv({ base_url: c.base_url, model: c.model });
        setPrivKeySet(Boolean(c.key_set));
        setPub({ base_url: c.public?.base_url ?? '', model: c.public?.model ?? '' });
        setPubKeySet(Boolean(c.public?.key_set));
        setTextLoaded(true);
      })
      .catch((e) => {
        if (closedRef.current) return;
        setTextLoaded(false);
        setTextLoadErr('⚠ ' + (e as Error).message);
      });
  };

  const checkPriv = () => {
    setPingStatus('checking');
    setPingMsg('');
    qwPing()
      .then((p) => {
        if (closedRef.current) return;
        setPingStatus(p.ok ? 'ok' : 'down');
        setPingMsg(p.ok ? `在线（${p.latencyMs ?? '?'}ms）` : p.error || '无响应');
      })
      .catch((e) => {
        if (closedRef.current) return;
        setPingStatus('down');
        setPingMsg((e as Error).message);
      });
    qwGetMeta()
      .then((m) => {
        if (closedRef.current) return;
        if (m.ok) {
          setMeta(m);
          setMetaErr('');
        } else setMetaErr(m.error || '读取失败');
      })
      .catch((e) => {
        if (closedRef.current) return;
        setMetaErr((e as Error).message);
      });
  };

  const loadImg = () => {
    setImgLoadErr('');
    imgLoadConfig()
      .then((c) => {
        if (!closedRef.current) setImg(c);
      })
      .catch((e) => {
        if (!closedRef.current) setImgLoadErr('⚠ ' + (e as Error).message);
      });
  };

  useEffect(() => {
    loadText();
    checkPriv();
    loadImg();
    // 只在打开时加载一次；后续重试用按钮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 私有模型：保存（key 留空 = 不修改）→ 检测 ──
  const savePriv = async () => {
    if (!textLoaded || privBusy) return;
    setPrivBusy(true);
    setPrivMsg('');
    try {
      const patch: Partial<QwenConfig> = { base_url: priv.base_url, model: priv.model };
      if (privKey.trim()) patch.api_key = privKey.trim();
      const c = await qwSaveConfig(patch);
      if (closedRef.current) return;
      setPriv({ base_url: c.base_url, model: c.model });
      setPrivKeySet(Boolean(c.key_set));
      setPrivKey('');
      const p = await qwPing();
      if (closedRef.current) return;
      setPingStatus(p.ok ? 'ok' : 'down');
      setPingMsg(p.ok ? `在线（${p.latencyMs ?? '?'}ms）` : p.error || '无响应');
      setPrivMsg(p.ok ? `✓ 已保存，私有模型在线（${p.latencyMs ?? '?'}ms）` : `已保存，但私有模型离线：${p.error || '无响应'}`);
    } catch (e) {
      if (!closedRef.current) setPrivMsg('⚠ ' + (e as Error).message);
    } finally {
      if (!closedRef.current) setPrivBusy(false);
    }
  };

  // ── 公共模型：保存（key 留空 = 不修改；model 为空时不覆盖已存模型） ──
  const savePub = async (silent = false): Promise<boolean> => {
    if (!textLoaded) return false;
    const patch: Partial<NonNullable<QwenConfig['public']>> = { base_url: pub.base_url };
    if (pub.model.trim()) patch.model = pub.model.trim();
    if (pubKey.trim()) patch.api_key = pubKey.trim();
    try {
      const c = await qwSaveConfig({ public: patch as NonNullable<QwenConfig['public']> });
      if (!closedRef.current) {
        setPub({ base_url: c.public?.base_url ?? '', model: c.public?.model ?? '' });
        setPubKeySet(Boolean(c.public?.key_set));
        setPubKey('');
        if (!silent) setPubMsg('✓ 公共模型配置已保存');
      }
      return true;
    } catch (e) {
      if (!closedRef.current) setPubMsg('⚠ 保存失败：' + (e as Error).message);
      return false;
    }
  };

  // 「检查模型」先保存当前表单，避免测到旧地址/旧 key
  const checkPubModels = async () => {
    if (pubBusy) return;
    setPubBusy(true);
    setPubMsg('检查中…');
    try {
      if (!(await savePub(true))) return;
      const models = await qwListModels('public');
      if (closedRef.current) return;
      setPubModels(models);
      if (!models.length) setPubMsg('⚠ 上游未返回模型列表，请手动填写模型名');
      else {
        setPub((p) => (p.model.trim() ? p : { ...p, model: models[0] }));
        setPubMsg(`✓ 上游支持 ${models.length} 个模型，请在下拉中选择`);
      }
    } catch (e) {
      if (closedRef.current) return;
      setPubModels([]);
      setPubMsg('⚠ ' + (e as Error).message + '——请检查地址/Key 后重试，或手动填写模型名');
    } finally {
      if (!closedRef.current) setPubBusy(false);
    }
  };

  const savePubOnly = async () => {
    if (pubBusy) return;
    setPubBusy(true);
    setPubMsg('');
    try {
      await savePub();
    } finally {
      if (!closedRef.current) setPubBusy(false);
    }
  };

  // ── 生图：保存（key 留空 = 不修改；default 轨 + 双轨一次保存） ──
  const saveImg = async (silent = false): Promise<boolean> => {
    if (!img || imgBusy) return false;
    const pubPatch: Partial<ImgConfig['public']> = { base_url: img.public?.base_url ?? '', model_list: img.public?.model_list ?? [] };
    if (imgKey.trim()) pubPatch.api_key = imgKey.trim();
    try {
      const c = await imgSaveConfig({ default: img.default, private: img.private, public: pubPatch as ImgConfig['public'] });
      if (!closedRef.current) {
        setImg(c);
        setImgKey('');
        if (!silent) setImgMsg('✓ 生图配置已保存');
      }
      return true;
    } catch (e) {
      if (!closedRef.current) setImgMsg('⚠ 保存失败：' + (e as Error).message);
      return false;
    }
  };

  const saveImgOnly = async () => {
    if (imgBusy) return;
    setImgBusy(true);
    setImgMsg('');
    try {
      await saveImg();
    } finally {
      if (!closedRef.current) setImgBusy(false);
    }
  };

  // 🌐 公生图「检查模型」：保存当前表单 → 拉中转模型列表（首项即默认）
  const checkImgPub = async () => {
    if (!img || imgBusy) return;
    setImgBusy(true);
    setImgMsg('检查中…');
    try {
      if (!(await saveImg(true))) return;
      const models = await imgRelayModels('public');
      if (closedRef.current) return;
      if (!models.length) {
        setImgMsg('⚠ 中转未返回模型列表，请手动填写');
        return;
      }
      setImgPubModels(models);
      setImg((cur) => (cur ? { ...cur, public: { ...cur.public, model_list: models } } : cur));
      setImgMsg(`✓ 拉取 ${models.length} 个模型，第一项为默认`);
    } catch (e) {
      if (!closedRef.current) setImgMsg('⚠ ' + (e as Error).message + '——请检查地址/Key，或手动填写模型列表');
    } finally {
      if (!closedRef.current) setImgBusy(false);
    }
  };

  // 🏠 私生图「刷新工作流」：保存当前表单 → 拉 ComfyUI 控制面板已保存的工作流列表
  const checkImgPriv = async () => {
    if (!img || imgBusy) return;
    setImgBusy(true);
    setImgMsg('检查中…');
    try {
      if (!(await saveImg(true))) return;
      const workflows = await imgRelayModels('private');
      if (closedRef.current) return;
      if (!workflows.length) {
        setImgMsg('⚠ 工作流面板未返回工作流，请确认地址，或手动填写工作流 ID');
        return;
      }
      setImgPrivWorkflows(workflows);
      setImg((cur) =>
        cur && (!cur.private?.workflow_id || !workflows.includes(cur.private.workflow_id))
          ? { ...cur, private: { ...cur.private, workflow_id: workflows[0] } }
          : cur,
      );
      setImgMsg(`✓ 拉取 ${workflows.length} 个工作流`);
    } catch (e) {
      if (!closedRef.current) setImgMsg('⚠ ' + (e as Error).message + '——请检查 ComfyUI 面板地址，或手动填写工作流 ID');
    } finally {
      if (!closedRef.current) setImgBusy(false);
    }
  };

  // 链路测试（按当前默认轨提交红圆测试图并轮询到出图；关面板停止轮询）
  const testImg = async () => {
    if (!img || imgBusy) return;
    setImgBusy(true);
    setImgMsg('');
    setImgProbe({ status: 'testing' });
    const rail = img.default === 'private' ? ('private' as const) : ('public' as const);
    const model = rail === 'private' ? '' : img.public?.model_list?.[0] || 'gpt-image-2.5';
    const label = rail === 'private' ? img.private?.workflow_id || '工作流' : model;
    try {
      const taskId = await imgSubmit({ model, prompt: 'a red circle on white background, flat style', size: '1:1', imageSize: '1K', rail });
      for (let k = 0; k < 60; k++) {
        await new Promise((r) => setTimeout(r, 2500));
        if (closedRef.current) return;
        const t = await imgTask(taskId);
        if (closedRef.current) return;
        if (t.status === 'completed' && t.images?.length) {
          setImgProbe({ status: 'ok', url: t.images[0] });
          setImgMsg(`✓ 链路可用（${label}）`);
          return;
        }
        if (t.status === 'failed') {
          setImgProbe({ status: 'failed', error: t.error || '生成失败' });
          return;
        }
      }
      if (!closedRef.current) setImgProbe({ status: 'failed', error: '等待超时（150 秒）' });
    } catch (e) {
      if (!closedRef.current) setImgProbe({ status: 'failed', error: (e as Error).message });
    } finally {
      if (!closedRef.current) setImgBusy(false);
    }
  };

  const pingTone = pingStatus === 'ok' ? 'ok' : pingStatus === 'down' ? 'down' : pingStatus === 'checking' ? 'warn' : 'idle';
  const pubConfigured = Boolean(pub.base_url.trim() && pub.model.trim());
  const modelHint = settings.engine === 'public' ? '公共模型' : '私有模型';

  return (
    <div className="fixed bottom-2 left-2 right-2 top-[calc(var(--topbar-h)+10px)] z-40 flex flex-col overflow-hidden rounded-[16px] border border-slate-200/80 bg-white shadow-panel sm:bottom-4 sm:left-auto sm:right-4 sm:w-[560px]">
      {/* 头部 */}
      <div className="flex flex-shrink-0 items-start gap-2 border-b border-slate-100 px-4 py-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-brand-50 text-brand-600">
          <Cpu className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-slate-800">模型中心</div>
          <div className="mt-0.5 text-[12px] text-slate-400">文本 / 引擎与推理 / 生图，统一配置</div>
        </div>
        {textLoadErr && <IconButton icon={<RefreshCw />} title="重新读取配置" onClick={loadText} />}
        <IconButton icon={<X />} title="关闭模型中心（ESC）" onClick={onClose} />
      </div>

      {/* 标签页 */}
      <div className="flex-shrink-0 border-b border-slate-100 px-4 py-2">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'text' as const, label: '文本模型' },
            { value: 'engine' as const, label: '引擎与推理' },
            { value: 'image' as const, label: '生图模型' },
          ]}
          className="w-full [&>button]:flex-1"
        />
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {/* ── 文本模型 ── */}
        {tab === 'text' && (
          <>
            {textLoadErr && (
              <div className="flex items-center justify-between gap-2 rounded-[10px] bg-rose-50 px-3 py-2 text-[12px] text-rose-600">
                <span className="min-w-0 break-all">读取服务器配置失败：{textLoadErr.replace('⚠ ', '')}</span>
                <Button size="sm" variant="secondary" onClick={loadText}>
                  重试
                </Button>
              </div>
            )}

            <Card
              icon={<House />}
              title="私有模型"
              subtitle="自建 / 租用 GPU，地址随开关机变动"
              aside={
                <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-slate-50 px-2 py-1 text-[12px] text-slate-500">
                  <StatusDot tone={pingTone} pulse={pingStatus === 'checking'} />
                  {pingStatus === 'checking' ? '检测中' : pingStatus === 'ok' ? '在线' : pingStatus === 'down' ? '离线' : '未检测'}
                </span>
              }
            >
              <Field label="服务地址">
                <Input
                  value={priv.base_url}
                  onChange={(e) => setPriv({ ...priv, base_url: e.target.value })}
                  placeholder="https://xxxx.seetacloud.com:8443（无需 /v1）"
                  disabled={!textLoaded}
                />
              </Field>
              <Field label="模型名">
                <Input
                  value={priv.model}
                  onChange={(e) => setPriv({ ...priv, model: e.target.value })}
                  placeholder="/root/models/Qwen3.8-27B-Q4_K_M.gguf"
                  disabled={!textLoaded}
                />
              </Field>
              <Field label="API Key" hint="只存服务器，前端仅显示是否已设置；留空表示不修改">
                <Input
                  type="password"
                  value={privKey}
                  onChange={(e) => setPrivKey(e.target.value)}
                  placeholder={privKeySet ? '已设置（留空 = 不修改）' : '未设置（按需填写）'}
                  disabled={!textLoaded}
                />
              </Field>
              {meta ? (
                <div className="rounded-[8px] bg-slate-50 px-2.5 py-2 text-[12px] leading-relaxed text-slate-500">
                  <div className="break-all font-medium text-slate-600">{meta.model}</div>
                  <div className="mt-0.5 text-slate-400">
                    上下文 {meta.n_ctx ? Math.round(meta.n_ctx / 1024) + 'K' : '未知'}
                    {meta.n_ctx_train ? `（训练 ${Math.round(meta.n_ctx_train / 1024)}K）` : ''}
                    {meta.ftype ? ` · ${meta.ftype}` : ''}
                  </div>
                </div>
              ) : (
                <div className="text-[12px] text-slate-400">{metaErr ? `模型信息：${metaErr}` : '读取模型信息中…'}</div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => void savePriv()} disabled={!textLoaded || privBusy}>
                  {privBusy ? '保存中…' : '保存并检测'}
                </Button>
                <Button size="sm" onClick={checkPriv} disabled={pingStatus === 'checking'}>
                  重新检测
                </Button>
                {pingMsg && <span className="text-[12px] text-slate-400">{pingMsg}</span>}
              </div>
              <Note text={privMsg} tone={toneOf(privMsg)} />
            </Card>

            <Card
              icon={<Globe />}
              title="公共模型"
              subtitle="SaaS 中转（Responses API），编辑室可手动切换"
              aside={pubConfigured ? <Badge tone="success">已配置</Badge> : <Badge tone="warn">未配置</Badge>}
            >
              <Field label="中转地址">
                <Input
                  value={pub.base_url}
                  onChange={(e) => setPub({ ...pub, base_url: e.target.value })}
                  placeholder="https://api.example.com（无需 /v1）"
                  disabled={!textLoaded}
                />
              </Field>
              <Field label="API Key" hint="只存服务器；留空表示不修改">
                <Input
                  type="password"
                  value={pubKey}
                  onChange={(e) => setPubKey(e.target.value)}
                  placeholder={pubKeySet ? '已设置（留空 = 不修改）' : '只存服务器'}
                  disabled={!textLoaded}
                />
              </Field>
              <Field label="模型">
                {pubModels.length > 0 ? (
                  <Select value={pub.model} onChange={(e) => setPub({ ...pub, model: e.target.value })} disabled={!textLoaded}>
                    {!pub.model && <option value="">请选择模型</option>}
                    {pubModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {pub.model && !pubModels.includes(pub.model) && <option value={pub.model}>{pub.model}（当前配置）</option>}
                  </Select>
                ) : (
                  <Input
                    value={pub.model}
                    onChange={(e) => setPub({ ...pub, model: e.target.value })}
                    placeholder="可点「检查模型」拉取列表后选择"
                    disabled={!textLoaded}
                  />
                )}
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => void checkPubModels()} disabled={!textLoaded || pubBusy}>
                  {pubBusy ? '检查中…' : '检查模型'}
                </Button>
                <Button size="sm" variant="primary" onClick={() => void savePubOnly()} disabled={!textLoaded || pubBusy}>
                  保存公共模型
                </Button>
              </div>
              <Note text={pubMsg} tone={toneOf(pubMsg)} />
            </Card>

            <p className="px-1 text-[12px] leading-relaxed text-slate-400">
              模型地址与密钥只存服务器；前端只显示「已设置 / 未设置」，不保存明文。
            </p>
          </>
        )}

        {/* ── 引擎与推理 ── */}
        {tab === 'engine' && (
          <>
            <Card icon={<Cpu />} title="对话与创作引擎" subtitle="编辑室对话、章节大纲、编辑单独对话使用">
              <Segmented
                value={settings.engine}
                onChange={(v: TextEngine) => setSettings({ engine: v })}
                options={[
                  { value: 'private' as const, label: '🏠 私有模型' },
                  { value: 'public' as const, label: '🌐 公共模型' },
                ]}
                className="w-full [&>button]:flex-1"
              />
              <div className="text-[12px] leading-relaxed text-slate-400">
                {pubConfigured ? `公共：${pub.model}` : '公共模型未配置——到「文本模型」填写地址与模型后可用'}
              </div>
            </Card>

            <Card icon={<ImageIcon />} title="正文执笔引擎" subtitle="仅「正文管理器」生成正文时使用，与对话引擎分开">
              <Segmented
                value={settings.contentEngine}
                onChange={(v: TextEngine) => setSettings({ contentEngine: v })}
                options={[
                  { value: 'private' as const, label: '🏠 私有模型' },
                  { value: 'public' as const, label: '🌐 公共模型' },
                ]}
                className="w-full [&>button]:flex-1"
              />
              <div className="text-[12px] leading-relaxed text-slate-400">当前：{settings.contentEngine === 'public' ? '公共模型' : '私有模型'}执笔</div>
            </Card>

            <Card icon={<Cpu />} title="推理强度" subtitle="影响编辑室对话、章节大纲与编辑单独对话">
              <Segmented
                value={settings.reasoningEffort}
                onChange={(v: ReasoningEffort) => setSettings({ reasoningEffort: v })}
                options={REASONING_EFFORTS.map((e) => ({ value: e, label: REASONING_EFFORT_LABEL[e] }))}
                className="w-full [&>button]:flex-1"
              />
              <div className="space-y-1 text-[12px] leading-relaxed text-slate-400">
                <p>关闭=直接作答；关闭以上档位越高，思考预算越大（输出上限同步提高）。</p>
                <p>私有模型只区分开/关（低/中/高均视为开启）；公共模型按档位下发 reasoning.effort。</p>
                <p>部分上游即使关闭也可能自行推理；若只见思考不见正文，请调低或关闭。</p>
              </div>
            </Card>

            <Card icon={<Check />} title="编辑输出" subtitle="编辑单独对话的补全预算">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] leading-relaxed text-slate-500">输出不设上限（整理长记忆不再截断）</span>
                <Switch checked={settings.editorUnlimited} onChange={(v) => setSettings({ editorUnlimited: v })} />
              </div>
              <div className="text-[12px] leading-relaxed text-slate-400">
                开启=16384 token（默认，实际写完为止）；关闭=8192 token。推理档位只抬高、不压低该预算。
              </div>
            </Card>

            <p className="px-1 text-[12px] leading-relaxed text-slate-400">
              引擎与推理偏好存本机浏览器（随当前作品设定保留）；模型地址与密钥存服务器。
            </p>
          </>
        )}

        {/* ── 生图模型 ── */}
        {tab === 'image' &&
          (imgLoadErr ? (
            <div className="flex items-center justify-between gap-2 rounded-[10px] bg-rose-50 px-3 py-2 text-[12px] text-rose-600">
              <span className="min-w-0 break-all">读取生图配置失败：{imgLoadErr.replace('⚠ ', '')}</span>
              <Button size="sm" variant="secondary" onClick={loadImg}>
                重试
              </Button>
            </div>
          ) : !img ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              读取生图配置中…
            </div>
          ) : (
            <>
              <Card icon={<ImageIcon />} title="生图默认轨" subtitle="编辑室【生图】块按此轨出图">
                <Segmented
                  value={img.default}
                  onChange={(v) => setImg({ ...img, default: v })}
                  options={[
                    { value: 'public' as const, label: '公共中转' },
                    { value: 'private' as const, label: '私有 ComfyUI' },
                  ]}
                  className="w-full [&>button]:flex-1"
                />
              </Card>

              <Card icon={<Globe />} title="公共生图（中转）" subtitle="OpenAI 风格图片接口">
                <Field label="中转地址">
                  <Input
                    value={img.public?.base_url ?? ''}
                    onChange={(e) => setImg({ ...img, public: { ...img.public, base_url: e.target.value } })}
                    placeholder="https://www.rightapi.ai"
                  />
                </Field>
                <Field label="API Key" hint="只存服务器；留空表示不修改">
                  <Input
                    type="password"
                    value={imgKey}
                    onChange={(e) => setImgKey(e.target.value)}
                    placeholder={img.public?.key_set ? '已设置（留空 = 不修改）' : '只存服务器'}
                  />
                </Field>
                <div className="flex items-end gap-2">
                  <Field label="模型列表（逗号分隔，第一项为默认）" className="min-w-0 flex-1">
                    <Input
                      value={(img.public?.model_list ?? []).join(', ')}
                      onChange={(e) =>
                        setImg({
                          ...img,
                          public: { ...img.public, model_list: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) },
                        })
                      }
                      placeholder="gpt-image-2.5, nano-banana"
                    />
                  </Field>
                  <Button size="sm" onClick={() => void checkImgPub()} disabled={imgBusy}>
                    检查模型
                  </Button>
                </div>
              </Card>

              <Card icon={<House />} title="私有生图（ComfyUI 工作流）" subtitle="工作流 API 出图，不支持参考图">
                <Field label="ComfyUI 面板地址" hint="填控制面板根地址（工作流 API）">
                  <Input
                    value={img.private?.base_url ?? ''}
                    onChange={(e) => setImg({ ...img, private: { ...img.private, base_url: e.target.value } })}
                    placeholder="http://127.0.0.1:8188"
                  />
                </Field>
                <div className="flex items-end gap-2">
                  <Field label="工作流" className="min-w-0 flex-1">
                    {imgPrivWorkflows.length > 0 ? (
                      <Select
                        value={img.private?.workflow_id ?? ''}
                        onChange={(e) => setImg({ ...img, private: { ...img.private, workflow_id: e.target.value } })}
                      >
                        {!img.private?.workflow_id && <option value="">请选择工作流</option>}
                        {imgPrivWorkflows.map((w) => (
                          <option key={w} value={w}>
                            {w}
                          </option>
                        ))}
                        {img.private?.workflow_id && !imgPrivWorkflows.includes(img.private.workflow_id) && (
                          <option value={img.private.workflow_id}>{img.private.workflow_id}（当前配置）</option>
                        )}
                      </Select>
                    ) : (
                      <Input
                        value={img.private?.workflow_id ?? ''}
                        onChange={(e) => setImg({ ...img, private: { ...img.private, workflow_id: e.target.value } })}
                        placeholder="可点「刷新工作流」拉取"
                      />
                    )}
                  </Field>
                  <Button size="sm" onClick={() => void checkImgPriv()} disabled={imgBusy}>
                    刷新工作流
                  </Button>
                </div>
              </Card>

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => void saveImgOnly()} disabled={imgBusy}>
                  保存生图配置
                </Button>
                <Button size="sm" onClick={() => void testImg()} disabled={imgBusy}>
                  链路测试（按默认轨）
                </Button>
              </div>
              <Note text={imgMsg} tone={toneOf(imgMsg)} />
              {imgProbe?.status === 'testing' && <Note text="测试图生成中（约 1-2 分钟，可切换标签页，关面板会停止）…" />}
              {imgProbe?.status === 'ok' && imgProbe.url && (
                <img src={imgProbe.url} alt="生图链路测试" className="w-28 rounded-[10px] border border-slate-200" />
              )}
              {imgProbe?.status === 'failed' && <Note text={`⚠ 测试失败：${imgProbe.error}`} tone="warn" />}
              <p className="px-1 text-[12px] leading-relaxed text-slate-400">
                生图配置存服务器（imgconfig.json）；生图失败不影响文本模型使用。
              </p>
            </>
          ))}
      </div>
    </div>
  );
}
