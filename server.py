#!/usr/bin/env python3
"""
novels-studio — AI 小说创作台后端
后端职责（前端为 Vite 构建产物）：
  GET  /api/graphs                列出 graphs/ 下所有图
  GET/POST/DELETE /api/graph      单图读取 / 保存 / 删除
  GET/POST /api/imgconfig         生图中转配置（key 打码返回）
  GET/POST /api/qwenconfig        Qwen 章纲推演配置（base_url/model，key 打码返回）
  GET  /api/qwen/ping             Qwen 租用服务器连通检查（/v1/models，6s）
  POST /api/qwen/chat             Qwen chat 代理（SSE 流式透传，默认关思考）
  POST /api/img/submit            提交生图任务（中转异步，返回 task_id）
  GET  /api/img/task/{id}         轮询生图任务；completed 时把结果图落盘换成本地 URL
  POST /api/img/upload            上传参考图（dataURL → images/ 落盘）
  GET  /api/img/file/{name}       图片文件服务
  POST /api/vid/submit            提交视频生成任务（AutoDL.Art ComfyUI 反代，返回 task_id）
  GET  /api/vid/task/{id}         轮询视频任务；SUCCESS 时把结果视频立即下载落盘换本地 URL
  GET  /api/vid/file/{name}       视频文件服务
  GET/POST/DELETE /api/imagegraph 生图画布存档（imagegraphs/ 目录）
  GET  /                          SPA 入口（dist/studio.html，缺省回退 dist/index.html）
  /*                              dist/ 静态资产
端口: 8768   访问: http://<你的服务器>/<部署子路径>/
"""
import asyncio, json, os, logging, re, time, base64, random
import aiohttp
from aiohttp import web

log = logging.getLogger("novels-studio")
logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s: %(message)s")

BASE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(BASE, "dist")
HOST, PORT = "0.0.0.0", 8768
GRAPHS_DIR = os.path.join(BASE, "graphs")
os.makedirs(GRAPHS_DIR, exist_ok=True)
IMG_DIR = os.path.join(BASE, "images")
os.makedirs(IMG_DIR, exist_ok=True)
IMG_GRAPHS_DIR = os.path.join(BASE, "imagegraphs")
os.makedirs(IMG_GRAPHS_DIR, exist_ok=True)
IMGCONF_PATH = os.path.join(BASE, "imgconfig.json")
VID_DIR = os.path.join(BASE, "videos")
os.makedirs(VID_DIR, exist_ok=True)
AUD_DIR = os.path.join(BASE, "audiofiles")
os.makedirs(AUD_DIR, exist_ok=True)
VIDCONF_PATH = os.path.join(BASE, "vidconfig.json")
SCRIPTCONF_PATH = os.path.join(BASE, "scriptconfig.json")
QWENCONF_PATH = os.path.join(BASE, "qwenconfig.json")
SKILLS_DIR = os.path.join(BASE, "skills")
os.makedirs(SKILLS_DIR, exist_ok=True)
SKILLS_JSON = os.path.join(BASE, "skills.json")
CHARASSET_DIR = os.path.join(BASE, "charassets")
CHARASSET_GENDERS = ("男", "女")
CHARASSET_STAGES = ("少年", "青年", "中年", "老年")
for _g in CHARASSET_GENDERS:
    for _s in CHARASSET_STAGES:
        os.makedirs(os.path.join(CHARASSET_DIR, _g, _s), exist_ok=True)


# ── SPA ──
def spa_entry():
    """构建入口：studio.html 优先，兼容旧版 index.html。"""
    for name in ("studio.html", "index.html"):
        if os.path.isfile(os.path.join(DIST, name)):
            return os.path.join(DIST, name)
    return None


async def index(request):
    entry = spa_entry()
    if not entry:
        raise web.HTTPNotFound(text="dist/studio.html 不存在，请先执行 pnpm build")
    return web.FileResponse(entry)


# ── Graph persistence ──
def safe_name(name):
    name = (name or "").strip()
    if not name or len(name) > 50 or re.search(r'[\\/:*?"<>|\x00-\x1f]', name):
        return None
    return name

def graph_path(name):
    return os.path.join(GRAPHS_DIR, name + ".json")

async def api_graphs(request):
    items = []
    for fn in os.listdir(GRAPHS_DIR):
        if fn.endswith(".json"):
            fp = os.path.join(GRAPHS_DIR, fn)
            try:
                items.append((os.path.getmtime(fp), fn[:-5]))
            except OSError:
                pass
    items.sort(reverse=True)
    return web.json_response({"graphs": [n for _, n in items]})

async def api_graph_get(request):
    name = safe_name(request.query.get("name", ""))
    if not name:
        return web.json_response({"error": "非法名称"}, status=400)
    fp = graph_path(name)
    if not os.path.isfile(fp):
        return web.json_response({"error": "图不存在"}, status=404)
    with open(fp, encoding="utf-8") as f:
        return web.Response(text=f.read(), content_type="application/json")

async def api_graph_save(request):
    name = safe_name(request.query.get("name", ""))
    if not name:
        return web.json_response({"error": "非法名称"}, status=400)
    try:
        data = await request.json()
        if not isinstance(data, dict) or "graph" not in data:
            raise ValueError("缺少 graph 字段")
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    with open(graph_path(name), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return web.json_response({"ok": True, "savedAt": time.strftime("%H:%M:%S")})

async def api_graph_delete(request):
    name = safe_name(request.query.get("name", ""))
    if not name:
        return web.json_response({"error": "非法名称"}, status=400)
    fp = graph_path(name)
    if os.path.isfile(fp):
        os.remove(fp)
    return web.json_response({"ok": True})


# ── 故事模拟器存档（simgraphs/，形状同 outlinegraphs 但数据独立） ──
SIM_GRAPHS_DIR = os.path.join(BASE, "simgraphs")
os.makedirs(SIM_GRAPHS_DIR, exist_ok=True)


def sim_graph_path(name):
    return os.path.join(SIM_GRAPHS_DIR, name + ".json")


async def api_simgraphs(request):
    items = []
    for fn in os.listdir(SIM_GRAPHS_DIR):
        if fn.endswith(".json"):
            fp = os.path.join(SIM_GRAPHS_DIR, fn)
            try:
                items.append((os.path.getmtime(fp), fn[:-5]))
            except OSError:
                pass
    items.sort(reverse=True)
    return web.json_response({"graphs": [n for _, n in items]})


async def api_simgraph_get(request):
    name = safe_name(request.query.get("name", ""))
    if not name:
        return web.json_response({"error": "非法名称"}, status=400)
    fp = sim_graph_path(name)
    if not os.path.isfile(fp):
        return web.json_response({"error": "存档不存在"}, status=404)
    with open(fp, encoding="utf-8") as f:
        return web.Response(text=f.read(), content_type="application/json")


async def api_simgraph_save(request):
    name = safe_name(request.query.get("name", ""))
    if not name:
        return web.json_response({"error": "非法名称"}, status=400)
    try:
        data = await request.json()
        if not isinstance(data, dict) or "graph" not in data:
            raise ValueError("缺少 graph 字段")
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    with open(sim_graph_path(name), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return web.json_response({"ok": True, "savedAt": time.strftime("%H:%M:%S")})


async def api_simgraph_delete(request):
    name = safe_name(request.query.get("name", ""))
    if not name:
        return web.json_response({"error": "非法名称"}, status=400)
    fp = sim_graph_path(name)
    if os.path.isfile(fp):
        os.remove(fp)
    return web.json_response({"ok": True})


# ── 生图系统（双轨）：🏠 私有 = ComfyUI（标准 txt2img 工作流）；🌐 公共 = 中转变体协议（/draw + 任务轮询） ──
DEFAULT_IMGCONF = {
    "default": "public",  # 默认生图轨（前端读此字段决定 rail；服务端 rail 缺省恒为 public，旧前端零破坏）
    # 私有轨：ComfyUI 控制面板地址 + 工作流 ID（workflow API）；model 为旧版 checkpoint 兼容字段
    "private": {"base_url": "", "workflow_id": "", "model": ""},
    "public": {
        "base_url": "https://www.rightapi.ai",
        "api_key": "",
        # 模型一律用中转的真实模型 ID，不做别名映射；默认 gpt-image-2.5（便宜）
        "model_list": ["gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"],
    },
    "sizes": ["1:1", "16:9", "9:16", "4:3"],
    "image_sizes": ["1K", "2K", "4K"],
    "max_refs": 8,
}

img_task_files = {}  # task_id -> [本地文件名]（completed 结果缓存，避免重复下载）


def load_imgconf():
    try:
        with open(IMGCONF_PATH, encoding="utf-8") as f:
            conf = json.load(f)
    except Exception:
        conf = {}
    # 旧档迁移：平铺 base_url/api_key/model_list → public 轨（生图双轨化，旧数据无缝延续）
    pub = conf.get("public") if isinstance(conf.get("public"), dict) else {}
    for k in ("base_url", "api_key", "model_list"):
        if k in conf:
            v = conf.pop(k)
            if v and not pub.get(k):
                pub[k] = v
    conf["public"] = pub
    merged = {**DEFAULT_IMGCONF, **{k: v for k, v in conf.items() if k != "public"}}
    pub = {**DEFAULT_IMGCONF["public"], **conf.get("public", {})}
    if isinstance(pub.get("model_list"), list) and pub["model_list"]:
        pub["model_list"] = [str(m) for m in pub["model_list"] if str(m).strip()]
    merged["public"] = pub
    priv = conf.get("private") if isinstance(conf.get("private"), dict) else {}
    merged["private"] = {**DEFAULT_IMGCONF["private"], **priv}
    if merged.get("default") not in ("public", "private"):
        merged["default"] = "public"
    return merged


def mask_key(key):
    if not key:
        return ""
    return key[:6] + "****" + key[-4:] if len(key) > 12 else "****"


def _mask_imgconf(conf):
    """public.api_key 打码 + 旧版前端兼容别名（镜像 public 轨到平铺字段）"""
    pub = conf["public"]
    pub["api_key"] = mask_key(pub.get("api_key", ""))
    pub["key_set"] = bool(pub.get("api_key"))
    conf["base_url"] = pub["base_url"]
    conf["api_key"] = pub["api_key"]
    conf["key_set"] = pub["key_set"]
    conf["model_list"] = pub["model_list"]
    return conf


async def api_imgconf_get(request):
    return web.json_response(_mask_imgconf(load_imgconf()))


async def api_imgconf_set(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    conf = load_imgconf()
    # 旧版前端兼容：平铺 base_url/api_key/model_list 视作 public 轨 patch
    for k in ("base_url", "api_key", "model_list"):
        if k in body and not isinstance(body.get("public"), dict):
            body.setdefault("public", {})[k] = body[k]
    pub_body = body.get("public")
    if isinstance(pub_body, dict):
        pub = conf["public"]
        new_key = (pub_body.get("api_key") or "").strip()
        if new_key and "*" not in new_key:  # 打码值回传 = 不修改
            pub["api_key"] = new_key
        if isinstance(pub_body.get("base_url"), str) and pub_body["base_url"].strip():
            pub["base_url"] = pub_body["base_url"].strip().rstrip("/")
        if isinstance(pub_body.get("model_list"), list):
            ml = [str(m).strip() for m in pub_body["model_list"] if str(m).strip()]
            if ml:
                pub["model_list"] = ml
    if body.get("default") in ("public", "private"):
        conf["default"] = body["default"]
    priv_body = body.get("private")
    if isinstance(priv_body, dict):
        priv = conf["private"]
        if isinstance(priv_body.get("base_url"), str):
            priv["base_url"] = priv_body["base_url"].strip()
        if isinstance(priv_body.get("workflow_id"), str):
            priv["workflow_id"] = priv_body["workflow_id"].strip()
        if isinstance(priv_body.get("model"), str):
            priv["model"] = priv_body["model"].strip()
    with open(IMGCONF_PATH, "w", encoding="utf-8") as f:
        json.dump(conf, f, ensure_ascii=False)
    return web.json_response(_mask_imgconf(conf))


# ── 脚本节点技能库 ──
# 基础技能：skills/ 目录下的 *.md（YAML frontmatter: name/kind/description），随部署分发；
# 专家技能：skills.json（用户自行添加/从 GitHub 安装）。两者都注入脚本生成的 system prompt。
def _parse_frontmatter(text):
    """返回 (meta dict, 正文)；无 frontmatter 时 meta 为空。"""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, text[m.end():]


def _builtin_skills():
    out = []
    try:
        for fn in sorted(os.listdir(SKILLS_DIR)):
            if not fn.endswith(".md"):
                continue
            with open(os.path.join(SKILLS_DIR, fn), encoding="utf-8") as f:
                meta, body = _parse_frontmatter(f.read())
            out.append({
                "id": fn[:-3],
                "name": meta.get("name") or fn[:-3],
                "desc": meta.get("description", ""),
                "kind": "basic",
                "content": body.strip(),
            })
    except OSError:
        pass
    return out


def load_skills():
    expert = []
    try:
        with open(SKILLS_JSON, encoding="utf-8") as f:
            expert = [s for s in json.load(f) if isinstance(s, dict) and s.get("id")]
    except Exception:
        expert = []
    return _builtin_skills() + expert


def save_expert_skills(skills):
    with open(SKILLS_JSON, "w", encoding="utf-8") as f:
        json.dump(skills, f, ensure_ascii=False, indent=1)
    os.chmod(SKILLS_JSON, 0o600)


async def api_skills_list(request):
    return web.json_response({"skills": load_skills()})


async def api_skill_add(request):
    """添加专家技能：{name, content, desc?}"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    name = (body.get("name") or "").strip()
    content = (body.get("content") or "").strip()
    if not name or not content:
        return web.json_response({"error": "缺少 name 或 content"}, status=400)
    skills = [s for s in load_skills() if s["kind"] == "expert"]
    skills.append({
        "id": f"u-{int(time.time()*1000)}",
        "name": name,
        "desc": (body.get("desc") or "").strip(),
        "kind": "expert",
        "content": content,
        "installedAt": int(time.time()),
    })
    save_expert_skills(skills)
    return web.json_response({"skills": load_skills()})


async def api_skill_delete(request):
    sid = request.query.get("id", "")
    skills = [s for s in load_skills() if s["kind"] == "expert"]
    if not any(s["id"] == sid for s in skills):
        return web.json_response({"error": "专家技能不存在（基础技能不可删除）"}, status=404)
    save_expert_skills([s for s in skills if s["id"] != sid])
    return web.json_response({"skills": load_skills()})


async def api_skill_install(request):
    """从 GitHub 安装技能：{url} —— 仓库/SKILL.md 链接转 raw，服务端抓取存为专家技能。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    url = (body.get("url") or "").strip()
    m = re.match(r"^https://github\.com/([^/]+)/([^/]+)(?:/(?:blob|tree)/(.+))?", url)
    if m:
        owner, repo, ref = m.group(1), m.group(2), m.group(3) or "main"
        url = f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/SKILL.md"
    if not re.match(r"^https://raw\.githubusercontent\.com/\S+\.md$", url):
        return web.json_response({"error": "需要 GitHub 仓库链接或 raw SKILL.md URL"}, status=400)
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=60)) as upstream:
                text = await upstream.text()
                if upstream.status != 200:
                    return web.json_response({"error": f"GitHub HTTP {upstream.status}"}, status=502)
    except asyncio.TimeoutError:
        return web.json_response({"error": "抓取 GitHub 超时（服务器网络可能无法直连 GitHub）"}, status=504)
    except Exception as e:
        return web.json_response({"error": f"抓取失败：{type(e).__name__}: {e}（服务器可能无法直连 GitHub，可手动放置 skills/ 目录）"}, status=502)
    meta, body_text = _parse_frontmatter(text)
    name = (meta.get("name") or url.rstrip("/").split("/")[-1][:-3] or "未命名技能").strip()
    skills = [s for s in load_skills() if s["kind"] == "expert"]
    skills.append({
        "id": f"u-{int(time.time()*1000)}",
        "name": name,
        "desc": meta.get("description", ""),
        "kind": "expert",
        "content": body_text.strip(),
        "source": url,
        "installedAt": int(time.time()),
    })
    save_expert_skills(skills)
    return web.json_response({"skills": load_skills()})


# ── 脚本生成器（DeepSeek 中转，OpenAI chat 协议） ──
DEFAULT_SCRIPTCONF = {
    # 在 scriptconfig.json 中填写兼容 OpenAI chat 协议的服务地址与模型
    "base_url": "",
    "api_key": "",
    "model_list": ["deepseek-flash"],
}


def load_scriptconf():
    try:
        with open(SCRIPTCONF_PATH, encoding="utf-8") as f:
            conf = json.load(f)
    except Exception:
        conf = {}
    merged = {**DEFAULT_SCRIPTCONF, **{k: v for k, v in conf.items() if k != "model_list"}}
    if isinstance(conf.get("model_list"), list) and conf["model_list"]:
        merged["model_list"] = [str(m) for m in conf["model_list"] if str(m).strip()]
    return merged


async def api_scriptconf_get(request):
    conf = load_scriptconf()
    conf["api_key"] = mask_key(conf.get("api_key", ""))
    conf["key_set"] = bool(conf.get("api_key"))
    return web.json_response(conf)


async def api_scriptconf_set(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    conf = load_scriptconf()
    new_key = (body.get("api_key") or "").strip()
    if new_key and "*" not in new_key:  # 打码值回传 = 不修改
        conf["api_key"] = new_key
    if isinstance(body.get("base_url"), str) and body["base_url"].strip():
        conf["base_url"] = body["base_url"].strip().rstrip("/")
    if isinstance(body.get("model_list"), list):
        ml = [str(m).strip() for m in body["model_list"] if str(m).strip()]
        if ml:
            conf["model_list"] = ml
    with open(SCRIPTCONF_PATH, "w", encoding="utf-8") as f:
        json.dump(conf, f, ensure_ascii=False)
    os.chmod(SCRIPTCONF_PATH, 0o600)
    conf["api_key"] = mask_key(conf.get("api_key", ""))
    conf["key_set"] = bool(conf.get("api_key"))
    return web.json_response(conf)


async def api_script_chat(request):
    """脚本生成 chat 代理：{model?, messages:[{role,content}]} → {text, model, elapsedMs}
    非流式一次性返回（分镜文本量不大）；key 只在服务端。"""
    conf = load_scriptconf()
    if not conf.get("api_key"):
        return web.json_response({"error": "未配置脚本生成 API Key（服务端 scriptconfig.json）"}, status=400)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return web.json_response({"error": "缺少 messages"}, status=400)
    model = (body.get("model") or conf["model_list"][0]).strip()
    payload = {"model": model, "messages": messages, "stream": False}
    headers = {"Authorization": f"Bearer {conf['api_key']}", "Content-Type": "application/json"}
    started = time.time()
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{conf['base_url']}/v1/chat/completions", headers=headers,
                              data=json.dumps(payload).encode(),
                              timeout=aiohttp.ClientTimeout(total=300)) as upstream:
                text = await upstream.text()
                if upstream.status != 200:
                    log.warning(f"script chat HTTP {upstream.status}: {text[:300]}")
                    return web.json_response({"error": f"中转 HTTP {upstream.status}: {text[:300]}"}, status=502)
                data = json.loads(text)
                content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
                if not content:
                    return web.json_response({"error": f"中转返回空内容: {text[:300]}"}, status=502)
                return web.json_response({
                    "text": content,
                    "model": data.get("model", model),
                    "elapsedMs": int((time.time() - started) * 1000),
                })
    except asyncio.TimeoutError:
        return web.json_response({"error": "脚本生成超时"}, status=504)
    except Exception as e:
        log.exception("script chat error")
        return web.json_response({"error": str(e)}, status=500)


# ── 双模型（🏠 私有模型 = 自建/租用 GPU，OpenAI 兼容接口；常关机，用前先 ping）──
# public：🌐 公共模型（SaaS 中转，OpenAI Responses API、带 key）。手动切换，不做自动 failover
DEFAULT_QWENCONF = {
    "base_url": "",
    "model": "",
    "api_key": "",
    "public": {"base_url": "", "api_key": "", "model": ""},
}


def _norm_base(base):
    base = (base or "").strip().rstrip("/")
    if base.endswith("/v1"):  # 允许直接粘贴含 /v1 的地址，统一归一为不带 /v1
        base = base[:-3].rstrip("/")
    return base


def load_qwenconf():
    conf = {}
    try:
        with open(QWENCONF_PATH, encoding="utf-8") as f:
            conf = json.load(f)
    except Exception:
        conf = {}
    # 旧档迁移：fallback 键 → public（v2.23 命名统一，服务器现有数据无缝延续）
    if "fallback" in conf:
        legacy = conf.pop("fallback")
        if isinstance(legacy, dict) and not isinstance(conf.get("public"), dict):
            conf["public"] = legacy
    merged = {**DEFAULT_QWENCONF, **conf}
    merged["base_url"] = _norm_base(merged.get("base_url"))
    pub = merged.get("public")
    merged["public"] = {**DEFAULT_QWENCONF["public"], **pub} if isinstance(pub, dict) else dict(DEFAULT_QWENCONF["public"])
    merged["public"]["base_url"] = _norm_base(merged["public"].get("base_url"))
    return merged


def _qwen_headers(conf):
    h = {"Content-Type": "application/json"}
    if conf.get("api_key"):
        h["Authorization"] = f"Bearer {conf['api_key']}"
    return h


def _mask_qwenconf(conf):
    conf["api_key"] = mask_key(conf.get("api_key", ""))
    conf["key_set"] = bool(conf.get("api_key"))
    pub = conf.get("public") or {}
    pub["api_key"] = mask_key(pub.get("api_key", ""))
    pub["key_set"] = bool(pub.get("api_key"))
    return conf


async def api_qwenconf_get(request):
    return web.json_response(_mask_qwenconf(load_qwenconf()))


async def api_qwenconf_set(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    conf = load_qwenconf()
    new_key = (body.get("api_key") or "").strip()
    if new_key and "*" not in new_key:  # 打码值回传 = 不修改
        conf["api_key"] = new_key
    if isinstance(body.get("base_url"), str) and body["base_url"].strip():
        conf["base_url"] = body["base_url"].strip()
    if isinstance(body.get("model"), str):
        conf["model"] = body["model"].strip()
    pub_body = body.get("public")
    if isinstance(pub_body, dict):  # 🌐 公共模型：同样语义合并（key 打码值回传 = 不修改）
        pub = conf["public"]
        new_pub_key = (pub_body.get("api_key") or "").strip()
        if new_pub_key and "*" not in new_pub_key:
            pub["api_key"] = new_pub_key
        if isinstance(pub_body.get("base_url"), str):
            pub["base_url"] = pub_body["base_url"].strip()
        if isinstance(pub_body.get("model"), str):
            pub["model"] = pub_body["model"].strip()
    with open(QWENCONF_PATH, "w", encoding="utf-8") as f:
        json.dump(conf, f, ensure_ascii=False)
    os.chmod(QWENCONF_PATH, 0o600)
    return web.json_response(_mask_qwenconf(conf))


async def api_qwen_ping(request):
    """连通检查：租用服务器常关机。GET {base}/v1/models，6s 内响应视为在线。"""
    conf = load_qwenconf()
    pub = conf.get("public") or {}
    pub_ready = bool(pub.get("base_url") and pub.get("model"))
    if not conf["base_url"]:
        return web.json_response({"ok": False, "error": "未配置私有模型服务地址（服务器 qwenconfig.json）",
                                  "pub": {"configured": pub_ready, "model": pub.get("model", "")}})
    started = time.time()
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{conf['base_url']}/v1/models", headers=_qwen_headers(conf),
                             timeout=aiohttp.ClientTimeout(total=6)) as upstream:
                if upstream.status != 200:
                    text = (await upstream.content.read(200)).decode("utf-8", "replace")
                    return web.json_response({"ok": False, "error": f"HTTP {upstream.status}: {text}"})
                data = json.loads(await upstream.text())
                # OpenAI 风格 {"data":[{"id":..}]} 与 Ollama 风格 {"models":[{"name":..}]} 都认
                models = [str(m.get("id") or m.get("name") or "")
                          for m in (data.get("data") or data.get("models") or []) if isinstance(m, dict)]
                return web.json_response({"ok": True, "models": models,
                                          "latencyMs": int((time.time() - started) * 1000)})
    except asyncio.TimeoutError:
        return web.json_response({"ok": False, "error": "6 秒内无响应（服务大概率关机）"})
    except Exception as e:
        log.warning(f"qwen ping error: {type(e).__name__}: {e}")
        return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"})


async def api_qwen_models(request):
    """拉指定引擎上游支持的模型列表：GET /api/qwen/models?engine=private|public。
    上游 GET {base}/v1/models（public 带 Bearer key，private 不带）；OpenAI data[].id / Ollama models[].name 双格式都认。"""
    engine = request.query.get("engine") or "private"
    conf = load_qwenconf()
    if engine == "public":
        pub = conf.get("public") or {}
        base = pub.get("base_url", "")
        if not base:
            return web.json_response({"error": "未配置公共模型地址（服务器 qwenconfig.json public）"}, status=400)
        headers = {"Authorization": f"Bearer {pub['api_key']}"} if pub.get("api_key") else {}
    else:
        base = conf["base_url"]
        if not base:
            return web.json_response({"error": "未配置私有模型服务地址（服务器 qwenconfig.json）"}, status=400)
        headers = _qwen_headers(conf)
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{base}/v1/models", headers=headers,
                             timeout=aiohttp.ClientTimeout(total=10)) as upstream:
                if upstream.status != 200:
                    text = (await upstream.content.read(200)).decode("utf-8", "replace")
                    return web.json_response({"error": f"上游 HTTP {upstream.status}: {text}"}, status=502)
                data = json.loads(await upstream.text())
                models = [str(m.get("id") or m.get("name") or "")
                          for m in (data.get("data") or data.get("models") or []) if isinstance(m, dict)]
                return web.json_response({"models": [m for m in models if m]})
    except asyncio.TimeoutError:
        return web.json_response({"error": "10 秒内无响应（上游大概率关机）"}, status=504)
    except Exception as e:
        log.warning(f"qwen models error: {type(e).__name__}: {e}")
        return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=502)


async def api_qwen_chat(request):
    """双模型代理（SSE 流式透传）：{messages, model?, max_tokens?, temperature?, engine?, reasoning_effort?}
    engine=private（默认）走私有模型（自建/租用 GPU）；engine=public 走公共模型（SaaS 中转，qwenconfig.json public，需 key）。
    纯手动切换，不做自动 failover。
    推理强度 reasoning_effort：off/low/medium/high（缺省/非法时回退旧布尔 thinking：true→medium，false→off）。
    私有轨 llama.cpp 只认布尔 → 低/中/高都开 enable_thinking（预算由前端 max_tokens 拉开）；公共轨 Responses API 按档下发
    reasoning={effort}，被上游 400/422 拒绝时去字段重试一次（部分中转不认该字段，不能因此让生成失败）。"""
    conf = load_qwenconf()
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return web.json_response({"error": "缺少 messages"}, status=400)
    eng = body.get("engine") or "private"
    use_public = eng in ("public", "fallback")  # fallback 为旧版前端缓存值，兼容映射
    effort = body.get("reasoning_effort")
    if effort not in ("off", "low", "medium", "high"):
        # 旧前端只发布尔 thinking；非法值同样按旧语义兜底
        effort = "medium" if body.get("thinking") is True else "off"
    headers = {"Content-Type": "application/json"}
    if use_public:
        pub = conf.get("public") or {}
        base, model = pub.get("base_url", ""), (pub.get("model") or "").strip()
        if not base or not model:
            return web.json_response({"error": "未配置公共模型（服务器 qwenconfig.json public）"}, status=400)
        if pub.get("api_key"):
            headers["Authorization"] = f"Bearer {pub['api_key']}"
        used_engine = "public"
    else:
        base, model = conf["base_url"], (body.get("model") or conf["model"]).strip()
        if not base:
            return web.json_response({"error": "未配置私有模型服务地址（服务器 qwenconfig.json）"}, status=400)
        if not model:
            return web.json_response({"error": "未配置私有模型名（服务器 qwenconfig.json）"}, status=400)
        if conf.get("api_key"):
            headers["Authorization"] = f"Bearer {conf['api_key']}"
        used_engine = "private"
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "max_tokens": int(body.get("max_tokens") or 8192),
        "temperature": float(body.get("temperature") or 0.7),
        # OpenAI 标准扩展：上游会在流末尾追加一条 choices=[] 且带 usage 的 chunk，前端据此显示上下文用量。
        # chat_template_kwargs 是 llama.cpp 特有（关 Qwen3 思考），备用中转不发送
        "stream_options": {"include_usage": True},
    }
    if not use_public:
        # llama.cpp 只支持布尔思考开关：低/中/高都开，强度体现在前端补全预算
        payload["chat_template_kwargs"] = {"enable_thinking": effort != "off"}
    if use_public:
        # 公共模型只支持 openai-response 协议（/v1/responses，不支持 /v1/chat/completions）：
        # 以 Responses API 请求，流式翻译回 chat completions SSE，前端解析器不变
        sys_txt = "\n\n".join(m.get("content", "") for m in messages if m.get("role") == "system" and isinstance(m.get("content"), str))
        r_input = [{"role": m.get("role"), "content": m.get("content", "")} for m in messages if m.get("role") != "system"]
        payload = {
            "model": model,
            "stream": True,
            "input": r_input,
            "max_output_tokens": int(body.get("max_tokens") or 8192),
            "temperature": float(body.get("temperature") or 0.7),
        }
        if sys_txt:
            payload["instructions"] = sys_txt
        if effort != "off":
            payload["reasoning"] = {"effort": effort}
    try:
        async with aiohttp.ClientSession() as s:
            url = f"{base}/{'v1/responses' if use_public else 'v1/chat/completions'}"
            timeout = aiohttp.ClientTimeout(total=600)

            async def send(p):
                return await s.post(url, headers=headers, data=json.dumps(p).encode(), timeout=timeout)

            upstream = await send(payload)
            # 兼容回退：部分中转不认 reasoning 字段（400/422）——读错误体、去掉 reasoning 重试一次
            if upstream.status in (400, 422) and "reasoning" in payload:
                err0 = (await upstream.content.read(300)).decode("utf-8", "replace")
                upstream.release()
                log.warning(f"{used_engine} 上游拒绝 reasoning（HTTP {upstream.status}）: {err0}；去掉该字段重试一次")
                payload.pop("reasoning", None)
                upstream = await send(payload)
            async with upstream:
                if upstream.status != 200:
                    err = (await upstream.content.read(300)).decode("utf-8", "replace")
                    log.warning(f"{used_engine} upstream HTTP {upstream.status}: {err}")
                    label = "🌐 公共模型" if use_public else "🏠 私有模型"
                    return web.json_response({"error": f"{label} HTTP {upstream.status} {err}"}, status=502)
                resp = web.StreamResponse(status=200)
                resp.headers["Content-Type"] = "text/event-stream; charset=utf-8"
                resp.headers["Cache-Control"] = "no-cache"
                resp.headers["X-Qwen-Engine"] = used_engine  # 前端据此给消息打引擎标
                await resp.prepare(request)
                if not use_public:
                    async for chunk in upstream.content.iter_chunked(4096):
                        await resp.write(chunk)
                    return resp
                # ── Responses API → chat completions SSE 翻译 ──
                buf = b""
                async for chunk in upstream.content.iter_any():
                    parts = buf + chunk
                    lines = parts.split(b"\n")
                    buf = lines.pop()
                    for raw in lines:
                        line = raw.strip()
                        if not line.startswith(b"data:"):
                            continue
                        data = line[5:].strip()
                        if not data:
                            continue
                        try:
                            ev = json.loads(data)
                        except Exception:
                            continue
                        t = ev.get("type")
                        if t in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
                            out = {"choices": [{"delta": {"reasoning_content": ev.get("delta", "")}}]}
                        elif t == "response.output_text.delta":
                            out = {"choices": [{"delta": {"content": ev.get("delta", "")}}]}
                        elif t == "response.completed":
                            u = (ev.get("response") or {}).get("usage") or {}
                            out = {"choices": [], "usage": {"prompt_tokens": u.get("input_tokens", 0),
                                                            "completion_tokens": u.get("output_tokens", 0),
                                                            "total_tokens": u.get("total_tokens", 0)}}
                        elif t in ("response.failed", "error"):
                            msg_txt = ((ev.get("response") or {}).get("error")) or ev.get("message") or "未知错误"
                            out = {"choices": [{"delta": {"content": f"\n\n[公共模型错误: {msg_txt}]"}}]}
                        else:
                            continue
                        await resp.write(b"data: " + json.dumps(out, ensure_ascii=False).encode() + b"\n\n")
                await resp.write(b"data: [DONE]\n\n")
                return resp
    except asyncio.TimeoutError:
        return web.json_response({"error": "生成超时"}, status=504)
    except Exception as e:
        log.exception("qwen chat error")
        return web.json_response({"error": str(e)}, status=500)


async def api_qwen_meta(request):
    """读取上游模型信息（Agent 面板用量条/思考开关用）：GET {base}/v1/models。
    llama.cpp 的响应带 meta（n_ctx 为启动参数生效后的真实上下文、n_ctx_train、ftype），透传精简字段。"""
    conf = load_qwenconf()
    if not conf["base_url"]:
        return web.json_response({"ok": False, "error": "未配置 Qwen 服务地址（服务器 qwenconfig.json）"}, status=400)
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{conf['base_url']}/v1/models", headers=_qwen_headers(conf),
                             timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status != 200:
                    return web.json_response({"ok": False, "error": f"HTTP {r.status}"})
                d = await r.json()
                m = (d.get("data") or [{}])[0]
                meta = m.get("meta") or {}
                return web.json_response({
                    "ok": True,
                    "model": m.get("id") or "",
                    "n_ctx": int(meta.get("n_ctx") or 0),
                    "n_ctx_train": int(meta.get("n_ctx_train") or 0),
                    "ftype": meta.get("ftype") or "",
                })
    except asyncio.TimeoutError:
        return web.json_response({"ok": False, "error": "6 秒内无响应（服务大概率关机）"})
    except Exception as e:
        log.warning(f"qwen meta error: {type(e).__name__}: {e}")
        return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"})


async def api_img_submit(request):
    """提交生图任务（双轨）：{model, prompt, n?, size?, imageSize?, image?: [dataURL], rail?: 'public'|'private'}
    rail 缺省 public（旧版前端副本零破坏）。public=中转变体协议（/draw 提交 + /v1/tasks 轮询）；
    private=ComfyUI 工作流 API（/api/workflow/generate，task_id 前缀 wf-；旧 checkpoint 模式前缀 comfy-）。"""
    conf = load_imgconf()
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    model = (body.get("model") or "").strip()
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return web.json_response({"error": "缺少 prompt"}, status=400)
    rail = body.get("rail") if body.get("rail") in ("public", "private") else "public"
    if rail == "private":
        return await _img_submit_comfy(conf, body, model, prompt)
    if not model:
        return web.json_response({"error": "缺少 model"}, status=400)
    pub = conf["public"]
    if not pub.get("api_key"):
        return web.json_response({"error": "未配置公共生图 API Key，请先在「⚙ 设置」填写"}, status=400)
    payload = {"model": model, "prompt": prompt, "async": True}
    for k in ("n", "size"):
        if body.get(k):
            payload[k] = body[k]
    # 中转要求请求体字段名全小写（驼峰 imageSize 会被 400 拒绝、不转发上游）：
    # 前端仍传 imageSize，出站时改名为 image_size。
    if body.get("imageSize"):
        payload["image_size"] = body["imageSize"]
    imgs = body.get("image") or []
    if len(imgs) > int(conf.get("max_refs", 8)):
        return web.json_response({"error": f"参考图数量超过上限 {conf.get('max_refs')}"}, status=400)
    if imgs:
        payload["image"] = imgs
    headers = {"Authorization": f"Bearer {pub['api_key']}", "Content-Type": "application/json"}
    target = f"{pub['base_url']}/draw/v1/images/generations"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(target, headers=headers, data=json.dumps(payload).encode(),
                              timeout=aiohttp.ClientTimeout(total=120)) as upstream:
                text = await upstream.text()
                if upstream.status != 200:
                    log.warning(f"img submit HTTP {upstream.status}: {text[:300]}")
                    return web.json_response({"error": f"中转 HTTP {upstream.status}: {text[:300]}"}, status=502)
                data = json.loads(text)
                if not data.get("task_id"):
                    return web.json_response({"error": f"中转未返回 task_id: {text[:300]}"}, status=502)
                return web.json_response({"task_id": data["task_id"]})
    except asyncio.TimeoutError:
        return web.json_response({"error": "提交任务超时"}, status=504)
    except Exception as e:
        log.exception("img submit error")
        return web.json_response({"error": str(e)}, status=500)


# 工作流 API（ComfyUI 控制面板）：前端比例 → 面板 aspect_ratio 标签；清晰度档位 → 总像素（megapixels）
_WORKFLOW_ASPECT_RATIOS = {
    "1:1": "1:1 (Square)",
    "2:3": "2:3 (Portrait Photo)",
    "3:2": "3:2 (Photo)",
    "3:4": "3:4 (Portrait Standard)",
    "4:3": "4:3 (Standard)",
    "9:16": "9:16 (Portrait Widescreen)",
    "16:9": "16:9 (Widescreen)",
    "21:9": "21:9 (Ultrawide)",
}
# 1K≈1280×720、2K≈2560×1440、4K≈3840×2160 的总像素；最终由前端裁切/缩放到精确预设
_WORKFLOW_MEGAPIXELS = {"1K": 1, "2K": 4, "4K": 8}


def _workflow_aspect_ratio(size):
    """'16:9' → '16:9 (Widescreen)'；像素串/未知比例按宽高比就近匹配，兜底 1:1"""
    s = str(size or "1:1").strip().lower().replace("：", ":")
    if s in _WORKFLOW_ASPECT_RATIOS:
        return _WORKFLOW_ASPECT_RATIOS[s]
    m = re.match(r"^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$", s)
    if m:
        w, h = max(float(m.group(1)), 0.01), max(float(m.group(2)), 0.01)
        for key, label in _WORKFLOW_ASPECT_RATIOS.items():
            kw, kh = (float(x) for x in key.split(":"))
            if abs(w / h - kw / kh) < 0.02:
                return label
    return _WORKFLOW_ASPECT_RATIOS["1:1"]


def _workflow_megapixels(image_size):
    return _WORKFLOW_MEGAPIXELS.get(str(image_size or "1K").upper(), 1)


def _comfy_size_px(size, image_size):
    """比例字符串（'1:1'/'16:9'…）+ 档位（'1K'/'2K'/'4K'）→ (宽, 高)，64 的倍数、面积≈档位²"""
    base = {"1K": 1024, "2K": 1536, "4K": 2048}.get(str(image_size or "1K"), 1024)
    try:
        w_r, h_r = (size or "1:1").split(":")
        w_r, h_r = max(float(w_r), 0.01), max(float(h_r), 0.01)
    except Exception:
        w_r, h_r = 1.0, 1.0
    scale = base / ((w_r * h_r) ** 0.5)
    w = max(256, int(round(w_r * scale / 64)) * 64)
    h = max(256, int(round(h_r * scale / 64)) * 64)
    return w, h


def _comfy_txt2img_workflow(model, prompt, w, h):
    """标准节点 txt2img 工作流（API 格式）。若实例装了自定义节点模板不适用，按报错调。"""
    return {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": model}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "lowres, bad anatomy, bad hands, watermark, worst quality, low quality", "clip": ["4", 1]}},
        "3": {"class_type": "KSampler",
              "inputs": {"seed": random.randint(0, 2**31 - 1), "steps": 20, "cfg": 6.0,
                         "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0,
                         "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "novels", "images": ["8", 0]}},
    }


async def _img_submit_workflow(priv, body, prompt):
    """私有轨（工作流 API）：POST {base}/api/workflow/generate → prompt_id，前端轮询任务 id = wf-{prompt_id}。
    input_values 的键来自工作流参数面板（steps/prompt/negative_prompt/aspect_ratio/megapixels）。"""
    base = (priv.get("base_url") or "").rstrip("/")
    wid = (priv.get("workflow_id") or "").strip()
    if not base or not wid:
        return web.json_response({"error": "未配置私有生图工作流（面板地址 + 工作流 ID），请先在「⚙ 设置」选择"}, status=400)
    if body.get("image"):
        return web.json_response({"error": "私有轨（ComfyUI 工作流）暂不支持参考图"}, status=400)
    try:
        steps = int(body.get("steps") or 20)
    except (TypeError, ValueError):
        steps = 20
    payload = {
        "workflow_id": wid,
        "client_id": "novels-studio",
        "input_values": {
            "steps": max(1, min(100, steps)),
            "prompt": prompt,
            "negative_prompt": str(body.get("negativePrompt") or ""),
            "aspect_ratio": _workflow_aspect_ratio(body.get("size")),
            "megapixels": _workflow_megapixels(body.get("imageSize")),
        },
    }
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{base}/api/workflow/generate", data=json.dumps(payload).encode(),
                              headers={"Content-Type": "application/json"},
                              timeout=aiohttp.ClientTimeout(total=60)) as r:
                text = await r.text()
                if r.status != 200:
                    log.warning(f"workflow submit HTTP {r.status}: {text[:300]}")
                    return web.json_response({"error": f"ComfyUI 工作流 HTTP {r.status}: {text[:300]}"}, status=502)
                data = json.loads(text)
        if data.get("success") is False:
            return web.json_response({"error": f"工作流提交失败: {data.get('error') or text[:300]}"}, status=502)
        pid = data.get("prompt_id")
        if not pid:
            return web.json_response({"error": f"工作流未返回 prompt_id: {text[:300]}"}, status=502)
        return web.json_response({"task_id": f"wf-{pid}"})
    except asyncio.TimeoutError:
        return web.json_response({"error": "提交 ComfyUI 工作流超时"}, status=504)
    except Exception as e:
        log.exception("img workflow submit error")
        return web.json_response({"error": str(e)}, status=500)


async def _img_submit_comfy(conf, body, model, prompt):
    """私有轨提交：配置了 workflow_id → 工作流 API；否则回落旧版原生 ComfyUI /prompt（兼容旧配置）。
    旧版返回任务 id = comfy-{prompt_id}。"""
    priv = conf.get("private") or {}
    if (priv.get("workflow_id") or "").strip():
        return await _img_submit_workflow(priv, body, prompt)
    base = (priv.get("base_url") or "").rstrip("/")
    if not base or not model:
        return web.json_response({"error": "未配置私有生图工作流（面板地址 + 工作流 ID），请先在「⚙ 设置」选择"}, status=400)
    if body.get("image"):
        return web.json_response({"error": "私有轨（ComfyUI）暂不支持参考图"}, status=400)
    w, h = _comfy_size_px(body.get("size"), body.get("imageSize"))
    payload = {"prompt": _comfy_txt2img_workflow(model, prompt, w, h), "client_id": "novels-studio"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{base}/prompt", data=json.dumps(payload).encode(),
                              headers={"Content-Type": "application/json"},
                              timeout=aiohttp.ClientTimeout(total=30)) as r:
                text = await r.text()
                if r.status != 200:
                    log.warning(f"comfy submit HTTP {r.status}: {text[:300]}")
                    return web.json_response({"error": f"ComfyUI HTTP {r.status}: {text[:300]}"}, status=502)
                data = json.loads(text)
        pid = data.get("prompt_id")
        if not pid:
            return web.json_response({"error": f"ComfyUI 未返回 prompt_id: {text[:300]}"}, status=502)
        return web.json_response({"task_id": f"comfy-{pid}"})
    except asyncio.TimeoutError:
        return web.json_response({"error": "提交 ComfyUI 任务超时"}, status=504)
    except Exception as e:
        log.exception("img comfy submit error")
        return web.json_response({"error": str(e)}, status=500)


def _extract_image_urls(data):
    urls = [d.get("url") for d in (data.get("data") or []) if isinstance(d, dict) and d.get("url")]
    if not urls:  # Gemini 形状回退：candidates[].content.parts[].text
        for cand in (data.get("candidates") or []):
            for part in (((cand.get("content") or {}).get("parts")) or []):
                t = part.get("text") or ""
                if t.startswith("http"):
                    urls.append(t)
    return urls


async def api_img_task(request):
    """轮询任务；completed 时把结果图下载落盘，换成 /api/img/file/ 本地 URL（防 CDN 过期）。
    wf- 前缀走工作流面板 /api/workflow/result；comfy- 前缀走原生 ComfyUI /history + /view；其余走中转 /v1/tasks/{id}。"""
    tid = request.match_info["task_id"]
    conf = load_imgconf()
    cached = img_task_files.get(tid)
    if cached:
        return web.json_response({"status": "completed", "images": [f"/api/img/file/{f}" for f in cached]})
    if tid.startswith("wf-"):
        return await _img_task_workflow(conf, tid)
    if tid.startswith("comfy-"):
        return await _img_task_comfy(conf, tid)
    pub = conf["public"]
    headers = {"Authorization": f"Bearer {pub.get('api_key', '')}"}
    target = f"{pub['base_url']}/v1/tasks/{tid}"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(target, headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as upstream:
                text = await upstream.text()
                if upstream.status != 200:
                    return web.json_response({"error": f"查询 HTTP {upstream.status}: {text[:300]}"}, status=502)
                data = json.loads(text)
        status = data.get("status")
        if status == "failed":
            msg = (data.get("error") or {}).get("message") or "生成失败"
            return web.json_response({"status": "failed", "error": msg})
        # 中转实际响应可能不带 status 字段（Images 任务完成时直接给 data[].url），
        # 与文档的 status:"completed" 形状并存：只要有可提取的图片 URL 即视为完成
        urls = _extract_image_urls(data)
        if urls:
            files = []
            async with aiohttp.ClientSession() as s:
                for i, u in enumerate(urls):
                    ext = ".jpg" if ".jpg" in u.lower() or ".jpeg" in u.lower() else ".png"
                    fn = f"img_{re.sub(r'[^A-Za-z0-9]', '', tid)[-16:]}_{i}{ext}"
                    fp = os.path.join(IMG_DIR, fn)
                    if not os.path.isfile(fp):
                        async with s.get(u, timeout=aiohttp.ClientTimeout(total=120)) as r:
                            if r.status != 200:
                                continue
                            with open(fp, "wb") as f:
                                f.write(await r.read())
                    files.append(fn)
            if files:
                img_task_files[tid] = files
                return web.json_response({"status": "completed", "images": [f"/api/img/file/{f}" for f in files]})
            return web.json_response({"status": "failed", "error": "任务完成但未取得图片 URL"})
        return web.json_response({"status": status or "in_progress", "progress": data.get("progress", 0)})
    except Exception as e:
        log.exception("img task poll error")
        return web.json_response({"error": str(e)}, status=500)


async def _img_task_workflow(conf, tid):
    """私有轨（工作流 API）轮询：GET {base}/api/workflow/result?prompt_id=…
    pending=true = 仍在执行；pending=false 时从 results[] 取图片 URL 下载落盘。"""
    pid = tid[len("wf-"):]
    base = ((conf.get("private") or {}).get("base_url") or "").rstrip("/")
    if not base:
        return web.json_response({"error": "未配置私有生图工作流地址"}, status=400)
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{base}/api/workflow/result", params={"prompt_id": pid},
                            timeout=aiohttp.ClientTimeout(total=30)) as r:
                text = await r.text()
                if r.status != 200:
                    return web.json_response({"error": f"ComfyUI 工作流 HTTP {r.status}: {text[:200]}"}, status=502)
                data = json.loads(text)
            if data.get("success") is False or data.get("error"):
                return web.json_response({"status": "failed",
                                          "error": str(data.get("error") or "ComfyUI 工作流执行出错")})
            pending = data.get("pending")
            if pending is None:  # 兼容不带 pending 的旧响应：有 results 即视为完成
                pending = not bool(data.get("results"))
            if pending:
                return web.json_response({"status": "in_progress"})
            imgs = [it for it in (data.get("results") or [])
                    if isinstance(it, dict) and it.get("type") == "image"
                    and (it.get("url") or it.get("filename") or (isinstance(it.get("raw"), dict) and it["raw"].get("filename")))]
            files = []
            safe = re.sub(r"[^A-Za-z0-9]", "", tid)[-16:]
            for i, im in enumerate(imgs):
                fn = f"img_wf_{safe}_{i}.png"
                fp = os.path.join(IMG_DIR, fn)
                if not os.path.isfile(fp):
                    raw = im.get("raw") if isinstance(im.get("raw"), dict) else {}
                    src = str(im.get("url") or "")
                    try:
                        if src.startswith("/"):
                            src = base + src
                        if src.startswith("http"):
                            async with s.get(src, timeout=aiohttp.ClientTimeout(total=120)) as r2:
                                blob = await r2.read() if r2.status == 200 else b""
                        else:
                            fname = im.get("filename") or raw.get("filename")
                            if not fname:
                                continue
                            async with s.get(f"{base}/view", params={
                                    "filename": fname,
                                    "subfolder": raw.get("subfolder", ""),
                                    "type": raw.get("type", "output")},
                                    timeout=aiohttp.ClientTimeout(total=120)) as r2:
                                blob = await r2.read() if r2.status == 200 else b""
                        if blob:
                            with open(fp, "wb") as f:
                                f.write(blob)
                    except Exception as e:
                        log.warning(f"workflow image download failed: {type(e).__name__}: {e}")
                if os.path.isfile(fp):
                    files.append(fn)
        if files:
            img_task_files[tid] = files
            return web.json_response({"status": "completed", "images": [f"/api/img/file/{f}" for f in files]})
        return web.json_response({"status": "failed", "error": "工作流完成但未取得图片"})
    except Exception as e:
        log.exception("img workflow task error")
        return web.json_response({"error": str(e)}, status=500)


async def _img_task_comfy(conf, tid):
    """私有轨轮询：GET {base}/history/{prompt_id}（执行中返回 {} = in_progress）→ outputs 图片经 /view 下载落盘"""
    pid = tid[len("comfy-"):]
    base = ((conf.get("private") or {}).get("base_url") or "").rstrip("/")
    if not base:
        return web.json_response({"error": "未配置私有生图（ComfyUI）地址"}, status=400)
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{base}/history/{pid}", timeout=aiohttp.ClientTimeout(total=30)) as r:
                if r.status != 200:
                    return web.json_response({"error": f"ComfyUI HTTP {r.status}"}, status=502)
                data = await r.json()
        entry = data.get(pid)
        if not isinstance(entry, dict):
            return web.json_response({"status": "in_progress"})  # history 无记录 = 仍在排队/执行
        if entry.get("status", {}).get("status_str") == "error":
            return web.json_response({"status": "failed", "error": "ComfyUI 执行出错（查看 ComfyUI 控制台日志）"})
        files = []
        async with aiohttp.ClientSession() as s:
            for node in (entry.get("outputs") or {}).values():
                for im in node.get("images") or []:
                    if im.get("type") not in (None, "output"):
                        continue
                    fn = f"img_comfy_{re.sub(r'[^A-Za-z0-9]', '', tid)[-16:]}_{len(files)}.png"
                    fp = os.path.join(IMG_DIR, fn)
                    if not os.path.isfile(fp):
                        async with s.get(f"{base}/view", params={"filename": im.get("filename", ""),
                                                                 "subfolder": im.get("subfolder", ""),
                                                                 "type": im.get("type", "output")},
                                         timeout=aiohttp.ClientTimeout(total=120)) as r2:
                            if r2.status != 200:
                                continue
                            with open(fp, "wb") as f:
                                f.write(await r2.read())
                    if os.path.isfile(fp):
                        files.append(fn)
        if files:
            img_task_files[tid] = files
            return web.json_response({"status": "completed", "images": [f"/api/img/file/{f}" for f in files]})
        return web.json_response({"status": "in_progress"})
    except Exception as e:
        log.exception("img comfy task error")
        return web.json_response({"error": str(e)}, status=500)


async def api_img_models(request):
    """拉生图上游列表：rail=private → ComfyUI 控制面板已保存的工作流列表（/api/workflow/list）；
    public（默认）→ 中转 /draw/v1/models。返回 models 为 ID 数组，private 另附 workflows 元数据。"""
    rail = request.query.get("rail") if request.query.get("rail") in ("public", "private") else "public"
    conf = load_imgconf()
    try:
        async with aiohttp.ClientSession() as s:
            if rail == "private":
                base = ((conf.get("private") or {}).get("base_url") or "").rstrip("/")
                if not base:
                    return web.json_response({"error": "未配置私有生图（ComfyUI 面板）地址"}, status=400)
                async with s.get(f"{base}/api/workflow/list",
                                 timeout=aiohttp.ClientTimeout(total=20)) as upstream:
                    text = await upstream.text()
                    if upstream.status != 200:
                        return web.json_response({"error": f"工作流面板 HTTP {upstream.status}: {text[:200]}"}, status=502)
                    data = json.loads(text)
                if data.get("success") is False:
                    return web.json_response({"error": f"工作流面板返回错误: {data.get('error') or text[:200]}"}, status=502)
                flows = [w for w in (data.get("workflows") or []) if isinstance(w, dict)]
                ids = [str(w.get("id")) for w in flows if w.get("id")]
                return web.json_response({
                    "models": ids,
                    "workflows": [{"id": w.get("id"), "name": w.get("name"), "kind": w.get("kind")} for w in flows],
                })
            else:
                pub = conf["public"]
                if not pub.get("api_key"):
                    return web.json_response({"error": "未配置中转 API Key"}, status=400)
                headers = {"Authorization": f"Bearer {pub['api_key']}"}
                async with s.get(f"{pub['base_url']}/draw/v1/models", headers=headers,
                                 timeout=aiohttp.ClientTimeout(total=30)) as upstream:
                    text = await upstream.text()
                    if upstream.status != 200:
                        return web.json_response({"error": f"HTTP {upstream.status}: {text[:200]}"}, status=502)
                    data = json.loads(text)
                ids = [m.get("id") for m in (data.get("data") or []) if isinstance(m, dict) and m.get("id")]
        return web.json_response({"models": ids})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_img_upload(request):
    """上传参考图：{dataUrl} → 落盘 images/ → {url}"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    data_url = body.get("dataUrl") or ""
    m = re.match(r"^data:image/(png|jpe?g|webp);base64,(.+)$", data_url, re.S)
    if not m:
        return web.json_response({"error": "仅支持 png/jpg/webp 的 dataURL"}, status=400)
    ext = "jpg" if m.group(1).startswith("jp") else m.group(1)
    try:
        raw = base64.b64decode(m.group(2))
    except Exception:
        return web.json_response({"error": "base64 解码失败"}, status=400)
    if len(raw) > 20 * 1024 * 1024:
        return web.json_response({"error": "图片超过 20MB 上限"}, status=400)
    fn = f"up_{int(time.time() * 1000)}.{ext}"
    with open(os.path.join(IMG_DIR, fn), "wb") as f:
        f.write(raw)
    return web.json_response({"url": f"/api/img/file/{fn}"})


async def api_img_fetch(request):
    """抓取远程图片（网页图片 URL 粘贴）：{url} → 服务端下载落盘 → {url}（绕过浏览器 CORS）"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    src = (body.get("url") or "").strip()
    if not re.match(r"^https?://", src):
        return web.json_response({"error": "仅支持 http(s) 图片 URL"}, status=400)
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(src, timeout=aiohttp.ClientTimeout(total=30),
                             headers={"User-Agent": "Mozilla/5.0 (novels-studio)"}) as r:
                if r.status != 200:
                    return web.json_response({"error": f"抓取失败 HTTP {r.status}"}, status=502)
                ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                raw = await r.read()
    except Exception as e:
        return web.json_response({"error": f"抓取失败：{e}"}, status=502)
    if not ctype.startswith("image/") or len(raw) > 20 * 1024 * 1024:
        return web.json_response({"error": "目标不是图片或超过 20MB"}, status=400)
    ext = {"image/png": "png", "image/webp": "webp"}.get(ctype, "jpg")
    fn = f"fetch_{int(time.time() * 1000)}.{ext}"
    with open(os.path.join(IMG_DIR, fn), "wb") as f:
        f.write(raw)
    return web.json_response({"url": f"/api/img/file/{fn}"})


async def api_img_file(request):
    name = safe_name(request.match_info["name"])
    if not name:
        return web.json_response({"error": "非法名称"}, status=400)
    fp = os.path.join(IMG_DIR, name)
    if not os.path.isfile(fp):
        return web.json_response({"error": "文件不存在"}, status=404)
    ctype = "image/png" if name.endswith(".png") else "image/webp" if name.endswith(".webp") else "image/jpeg"
    return web.FileResponse(fp, headers={"Content-Type": ctype, "Cache-Control": "max-age=31536000"})


# ── 人物资源素材库（charassets/{性别}/{年龄段}/）：人物节点形象图。素材 id = 文件名（去扩展名），全库唯一；性别/年龄段由所在目录决定 ──
CHARASSET_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
CHARASSET_TYPES = {"png": "image/png", "webp": "image/webp", "jpg": "image/jpeg", "jpeg": "image/jpeg"}


def charasset_index():
    index = {}
    for g in CHARASSET_GENDERS:
        for s in CHARASSET_STAGES:
            d = os.path.join(CHARASSET_DIR, g, s)
            for fn in sorted(os.listdir(d)):
                aid, ext = os.path.splitext(fn)
                if ext[1:].lower() in CHARASSET_TYPES and CHARASSET_NAME_RE.match(aid) and aid not in index:
                    index[aid] = (os.path.join(d, fn), g, s)
    return index


async def api_charassets_list(request):
    items = [{"id": aid, "gender": g, "stage": s} for aid, (_, g, s) in charasset_index().items()]
    return web.json_response({"assets": items})


async def api_charasset_upload(request):
    """上传人物形象：{name, gender, stage, dataUrl}（png/jpg/webp）→ charassets/{gender}/{stage}/{name}.{ext}；全库同名拒绝（不覆盖）"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    aid = str(body.get("name") or "").strip()
    if not CHARASSET_NAME_RE.match(aid):
        return web.json_response({"error": "素材名仅支持 1-40 位字母、数字、下划线、连字符"}, status=400)
    gender, stage = body.get("gender"), body.get("stage")
    if gender not in CHARASSET_GENDERS or stage not in CHARASSET_STAGES:
        return web.json_response({"error": "上传需指定性别与年龄段"}, status=400)
    m = re.match(r"^data:image/(png|jpe?g|webp);base64,(.+)$", body.get("dataUrl") or "", re.S)
    if not m:
        return web.json_response({"error": "仅支持 png/jpg/webp 的 dataURL"}, status=400)
    ext = "jpg" if m.group(1).startswith("jp") else m.group(1)
    try:
        raw = base64.b64decode(m.group(2))
    except Exception:
        return web.json_response({"error": "base64 解码失败"}, status=400)
    if len(raw) > 5 * 1024 * 1024:
        return web.json_response({"error": "素材超过 5MB 上限"}, status=400)
    if aid in charasset_index():
        return web.json_response({"error": f"已存在同名素材「{aid}」"}, status=409)
    with open(os.path.join(CHARASSET_DIR, gender, stage, f"{aid}.{ext}"), "wb") as f:
        f.write(raw)
    return web.json_response({"ok": True, "id": aid})


async def api_charasset_delete(request):
    aid = request.query.get("id", "")
    if not CHARASSET_NAME_RE.match(aid):
        return web.json_response({"error": "非法 id"}, status=400)
    hit = charasset_index().get(aid)
    if hit:
        os.remove(hit[0])
    return web.json_response({"ok": True})


async def api_charasset_file(request):
    aid = request.match_info["aid"]
    if not CHARASSET_NAME_RE.match(aid):
        return web.json_response({"error": "非法 id"}, status=400)
    hit = charasset_index().get(aid)
    if not hit:
        return web.json_response({"error": "素材不存在"}, status=404)
    fp = hit[0]
    # 同名可删后重传，不能长期缓存
    return web.FileResponse(fp, headers={"Content-Type": CHARASSET_TYPES[os.path.splitext(fp)[1][1:].lower()], "Cache-Control": "no-cache"})


# ── 视频生成系统：AutoDL.Art ComfyUI（H3 图生视频）反代 ──
# 令牌存服务端 vidconfig.json（不入 git），Authorization 直接放令牌原文（不要 Bearer 前缀）
# 工作流模式：
#   single  1 张参考图  → minimax_h3_lightx2v_v5（ref_image_0）
#   flf     2 张首尾帧  → minimax_h3_lightx2v（first_frame + last_frame）
#   fast    1-9 张多图  → minimax_h3_zm_u08（快速多图参考，ref_image_0..8）
#   quality 1-9 张多图  → minimax_h3_zm_u24（质量多图参考，ref_image_0..8）
DEFAULT_VIDCONF = {
    "base_url": "https://autodl.art",
    "token": "",
    "workflow_single": "minimax_h3_lightx2v_v5",
    "workflow_flf": "minimax_h3_lightx2v",
    "workflow_multi_fast": "minimax_h3_zm_u08",
    "workflow_multi_quality": "minimax_h3_zm_u24",
    "resolutions": ["768p横", "768p竖", "480p"],
    "durations": [5, 6, 10],
}

vid_task_files = {}  # task_id -> [本地文件名]（SUCCESS 结果缓存，避免重复下载）


def load_vidconf():
    try:
        with open(VIDCONF_PATH, encoding="utf-8") as f:
            conf = json.load(f)
    except Exception:
        conf = {}
    return {**DEFAULT_VIDCONF, **conf}


async def api_vid_submit(request):
    """提交视频生成任务：{prompt, image: [dataURL], mode?: single|flf|fast|quality, duration?, resolution?} → {task_id}
    mode 省略时按图片数自动选择（1 张=single，2 张=flf）。"""
    conf = load_vidconf()
    if not conf.get("token"):
        return web.json_response({"error": "未配置视频生成令牌（服务端 vidconfig.json）"}, status=400)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    prompt = (body.get("prompt") or "").strip()
    imgs = body.get("image") or []
    if not prompt:
        return web.json_response({"error": "缺少 prompt"}, status=400)
    if not imgs or not isinstance(imgs, list):
        return web.json_response({"error": "图生视频需要 1-9 张参考图"}, status=400)
    if len(imgs) > 9:
        return web.json_response({"error": "最多 9 张参考图"}, status=400)
    for u in imgs:
        if not (isinstance(u, str) and u.startswith("data:image/")):
            return web.json_response({"error": "图片必须为带 data:image/...;base64, 前缀的 dataURI"}, status=400)
    mode = (body.get("mode") or "").strip() or ("flf" if len(imgs) >= 2 else "single")
    mode_limits = {"single": 1, "flf": 2, "fast": 9, "quality": 9}
    mode_workflows = {
        "single": conf["workflow_single"],
        "flf": conf["workflow_flf"],
        "fast": conf.get("workflow_multi_fast", "minimax_h3_zm_u08"),
        "quality": conf.get("workflow_multi_quality", "minimax_h3_zm_u24"),
    }
    if mode not in mode_limits:
        return web.json_response({"error": f"未知生成模式: {mode}"}, status=400)
    if len(imgs) > mode_limits[mode]:
        return web.json_response({"error": f"该模式最多 {mode_limits[mode]} 张参考图"}, status=400)
    if mode == "flf" and len(imgs) != 2:
        return web.json_response({"error": "首尾帧模式需要 2 张参考图（图1=首帧，图2=尾帧）"}, status=400)
    workflow = mode_workflows[mode]
    payload = {"prompt": prompt, "duration": int(body.get("duration") or 6),
               "resolution": body.get("resolution") or "768p横"}
    if mode == "single":
        payload["ref_image_0"] = imgs[0]
    elif mode == "flf":
        payload["first_frame"], payload["last_frame"] = imgs[0], imgs[1]
    else:  # fast / quality：多图参考 ref_image_0..N
        for i, u in enumerate(imgs):
            payload[f"ref_image_{i}"] = u
    headers = {"Authorization": conf["token"], "Content-Type": "application/json"}
    target = f"{conf['base_url']}/api/v1/comfyui/comfyui_workflow/{workflow}"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(target, headers=headers, data=json.dumps(payload).encode(),
                              timeout=aiohttp.ClientTimeout(total=120)) as upstream:
                text = await upstream.text()
                if upstream.status != 200:
                    log.warning(f"vid submit HTTP {upstream.status}: {text[:300]}")
                    return web.json_response({"error": f"AutoDL HTTP {upstream.status}: {text[:300]}"}, status=502)
                data = json.loads(text)
        if str(data.get("code")) != "Success" or not (data.get("data") or {}).get("task_id"):
            return web.json_response({"error": f"AutoDL 未返回 task_id: {text[:300]}"}, status=502)
        return web.json_response({"task_id": data["data"]["task_id"], "workflow": workflow})
    except asyncio.TimeoutError:
        return web.json_response({"error": "提交任务超时"}, status=504)
    except Exception as e:
        log.exception("vid submit error")
        return web.json_response({"error": str(e)}, status=500)


async def api_vid_task(request):
    """轮询视频任务：QUEUED/RUNNING → running；SUCCESS → 结果视频立即下载落盘（URL 有效期短）"""
    tid = request.match_info["task_id"]
    conf = load_vidconf()
    cached = vid_task_files.get(tid)
    if cached:
        return web.json_response({"status": "completed", "videos": [f"/api/vid/file/{f}" for f in cached]})
    headers = {"Authorization": conf["token"]}
    target = f"{conf['base_url']}/api/v1/comfyui/comfyui_workflow/result/{tid}"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(target, headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as upstream:
                text = await upstream.text()
                if upstream.status != 200:
                    return web.json_response({"error": f"查询 HTTP {upstream.status}: {text[:300]}"}, status=502)
                data = (json.loads(text).get("data") or {})
        status = str(data.get("status") or "").upper()
        if status == "FAILED":
            return web.json_response({"status": "failed", "error": str(data.get("error") or "生成失败")[:300]})
        if status == "SUCCESS":
            urls = [r.get("url") for r in (data.get("results") or [])
                    if isinstance(r, dict) and r.get("url")]
            files = []
            async with aiohttp.ClientSession() as s:
                for i, u in enumerate(urls):
                    fn = f"vid_{re.sub(r'[^A-Za-z0-9]', '', tid)[-16:]}_{i}.mp4"
                    fp = os.path.join(VID_DIR, fn)
                    if not os.path.isfile(fp):
                        async with s.get(u, timeout=aiohttp.ClientTimeout(total=600)) as r:
                            if r.status != 200:
                                continue
                            with open(fp, "wb") as f:
                                f.write(await r.read())
                    files.append(fn)
            if files:
                vid_task_files[tid] = files
                return web.json_response({"status": "completed", "videos": [f"/api/vid/file/{f}" for f in files]})
            return web.json_response({"status": "failed", "error": "任务成功但未取得视频 URL"})
        # QUEUED / RUNNING（无百分比进度，前端显示阶段文字）；其余未知状态按失败处理（防无限轮询）
        if status in ("QUEUED", "PENDING"):
            return web.json_response({"status": "running", "stage": "排队中"})
        if status == "RUNNING":
            return web.json_response({"status": "running", "stage": "生成中"})
        return web.json_response({"status": "failed", "error": f"未知任务状态: {status or text[:200]}"})
    except Exception as e:
        log.exception("vid task poll error")
        return web.json_response({"error": str(e)}, status=500)


async def api_vid_file(request):
    name = safe_name(request.match_info["name"])
    if not name or not name.endswith(".mp4"):
        return web.json_response({"error": "非法名称"}, status=400)
    fp = os.path.join(VID_DIR, name)
    if not os.path.isfile(fp):
        return web.json_response({"error": "文件不存在"}, status=404)
    return web.FileResponse(fp, headers={"Content-Type": "video/mp4", "Cache-Control": "max-age=31536000",
                                         "Accept-Ranges": "bytes"})


# ── 音频生成系统：AutoDL.Art ComfyUI（IndexTTS2 语音合成）反代，复用 vidconfig 令牌与网关 ──
# 参考音频（prompt_simple 音色参考）支持外链 URL 或 dataURI（本地音频由前端转 base64）。
# 上游 schema 实测（2026-09）：emo_surprised 为枚举型且不接受任何已测值——一律省略不传；
# 情感滑条仅传非零值；emo_random 传布尔（仅 true 时携带）；必填 prompt_text / prompt_simple / emo_control_method。

aud_task_files = {}  # task_id -> [本地文件名]（避免重复下载）


async def api_aud_submit(request):
    """提交音频生成任务：{prompt_text, ref, emo_ref?, emo?, emo_random?, emo_control_method?} → {task_id}"""
    conf = load_vidconf()
    if not conf.get("token"):
        return web.json_response({"error": "未配置音频生成令牌（服务端 vidconfig.json）"}, status=400)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    prompt_text = (body.get("prompt_text") or "").strip()
    ref = (body.get("ref") or "").strip()
    if not prompt_text:
        return web.json_response({"error": "缺少要念的文本"}, status=400)
    if not ref:
        return web.json_response({"error": "缺少参考音频（连接上游音频节点或在属性栏填写参考音频 URL）"}, status=400)
    if not (ref.startswith("data:audio/") or ref.startswith("http://") or ref.startswith("https://")):
        return web.json_response({"error": "参考音频必须为 URL 或 dataURI"}, status=400)
    payload = {
        "prompt_text": prompt_text,
        "prompt_simple": ref,
        "emo_control_method": (body.get("emo_control_method") or "").strip() or "与音色参考音频相同",
    }
    emo_ref = (body.get("emo_ref") or "").strip()
    if emo_ref:
        payload["emo_ref_audio"] = emo_ref
    emo = body.get("emo") or {}
    for k in ("emo_happy", "emo_calm", "emo_sad", "emo_angry", "emo_afraid", "emo_disgusted", "emo_melancholic"):
        v = emo.get(k)
        if isinstance(v, (int, float)) and v > 0:
            payload[k] = round(float(v), 3)
    if body.get("emo_random"):
        payload["emo_random"] = True
    headers = {"Authorization": conf["token"], "Content-Type": "application/json"}
    target = f"{conf['base_url']}/api/v1/comfyui/comfyui_workflow/indextts2-v1"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(target, headers=headers, data=json.dumps(payload).encode(),
                              timeout=aiohttp.ClientTimeout(total=120)) as upstream:
                text = await upstream.text()
                if upstream.status != 200:
                    log.warning(f"aud submit HTTP {upstream.status}: {text[:300]}")
                    return web.json_response({"error": f"AutoDL HTTP {upstream.status}: {text[:300]}"}, status=502)
                data = json.loads(text)
        if str(data.get("code")) != "Success" or not (data.get("data") or {}).get("task_id"):
            msg = str(data.get("msg") or text[:300])
            return web.json_response({"error": f"AutoDL 未返回 task_id: {msg}"}, status=502)
        return web.json_response({"task_id": data["data"]["task_id"]})
    except asyncio.TimeoutError:
        return web.json_response({"error": "提交任务超时"}, status=504)
    except Exception as e:
        log.exception("aud submit error")
        return web.json_response({"error": str(e)}, status=500)


async def api_aud_task(request):
    """轮询音频任务：QUEUED/RUNNING → running；SUCCESS → 结果音频立即下载落盘（签名 URL 短时效）"""
    tid = request.match_info["task_id"]
    conf = load_vidconf()
    cached = aud_task_files.get(tid)
    if cached:
        return web.json_response({"status": "completed", "audios": [f"/api/aud/file/{f}" for f in cached]})
    headers = {"Authorization": conf["token"]}
    target = f"{conf['base_url']}/api/v1/comfyui/comfyui_workflow/result/{tid}"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(target, headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as upstream:
                text = await upstream.text()
                if upstream.status != 200:
                    return web.json_response({"error": f"查询 HTTP {upstream.status}: {text[:300]}"}, status=502)
                data = (json.loads(text).get("data") or {})
        status = str(data.get("status") or "").upper()
        if status == "FAILED":
            return web.json_response({"status": "failed", "error": str(data.get("error") or "生成失败")[:300]})
        if status == "SUCCESS":
            urls = [r.get("url") for r in (data.get("results") or [])
                    if isinstance(r, dict) and r.get("url")]
            files = []
            async with aiohttp.ClientSession() as s:
                for i, u in enumerate(urls):
                    fn = f"aud_{re.sub(r'[^A-Za-z0-9]', '', tid)[-16:]}_{i}.wav"
                    fp = os.path.join(AUD_DIR, fn)
                    if not os.path.isfile(fp):
                        async with s.get(u, timeout=aiohttp.ClientTimeout(total=600)) as r:
                            if r.status != 200:
                                continue
                            with open(fp, "wb") as f:
                                f.write(await r.read())
                    files.append(fn)
            if files:
                aud_task_files[tid] = files
                return web.json_response({"status": "completed", "audios": [f"/api/aud/file/{f}" for f in files]})
            return web.json_response({"status": "failed", "error": "任务成功但未取得音频 URL"})
        if status in ("QUEUED", "PENDING"):
            return web.json_response({"status": "running", "stage": "排队中"})
        if status == "RUNNING":
            return web.json_response({"status": "running", "stage": "生成中"})
        return web.json_response({"status": "failed", "error": f"未知任务状态: {status or text[:200]}"})
    except Exception as e:
        log.exception("aud task poll error")
        return web.json_response({"error": str(e)}, status=500)


AUD_FILE_TYPES = {
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
    ".aac": "audio/aac", ".flac": "audio/flac", ".webm": "audio/webm",
}


async def api_aud_file(request):
    name = safe_name(request.match_info["name"])
    ext = os.path.splitext(name)[1].lower()
    if not name or ext not in AUD_FILE_TYPES:
        return web.json_response({"error": "非法名称"}, status=400)
    fp = os.path.join(AUD_DIR, name)
    if not os.path.isfile(fp):
        return web.json_response({"error": "文件不存在"}, status=404)
    return web.FileResponse(fp, headers={"Content-Type": AUD_FILE_TYPES[ext], "Cache-Control": "max-age=31536000",
                                         "Accept-Ranges": "bytes"})


async def api_aud_fetch(request):
    """抓取远程音频（音频素材节点 URL 导入）：{url} → 服务端下载落盘 → {url}（绕过浏览器 CORS）"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    src_url = (body.get("url") or "").strip()
    if not re.match(r"^https?://", src_url):
        return web.json_response({"error": "仅支持 http(s) 音频 URL"}, status=400)
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(src_url, timeout=aiohttp.ClientTimeout(total=60),
                             headers={"User-Agent": "Mozilla/5.0 (novels-studio)"}) as r:
                if r.status != 200:
                    return web.json_response({"error": f"抓取失败 HTTP {r.status}"}, status=502)
                ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                raw = await r.read()
    except Exception as e:
        return web.json_response({"error": f"抓取失败：{e}"}, status=502)
    ext = {"audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
           "audio/wave": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/m4a": "m4a",
           "audio/aac": "aac", "audio/flac": "flac", "audio/webm": "webm"}.get(ctype, "")
    if not ext:
        # Content-Type 不标准时按 URL 扩展名兜底
        m = re.search(r"\.(mp3|wav|ogg|m4a|aac|flac|webm)(?:[?#]|$)", src_url, re.I)
        ext = m.group(1).lower() if m else ""
    if not ext or len(raw) > 20 * 1024 * 1024:
        return web.json_response({"error": "目标不是可识别的音频或超过 20MB"}, status=400)
    fn = f"fetch_{int(time.time() * 1000)}.{ext}"
    with open(os.path.join(AUD_DIR, fn), "wb") as f:
        f.write(raw)
    return web.json_response({"url": f"/api/aud/file/{fn}"})


async def api_aud_upload(request):
    """上传参考音频：{dataUrl}（data:audio/…;base64）→ 落盘 audiofiles/ → {url}"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    data_url = body.get("dataUrl") or ""
    m = re.match(r"^data:audio/(mpeg|mp3|wav|x-wav|wave|ogg|mp4|m4a|aac|flac|webm);base64,(.+)$", data_url, re.S)
    if not m:
        return web.json_response({"error": "仅支持 mp3/wav/ogg/m4a/aac/flac/webm 音频"}, status=400)
    kind = m.group(1)
    ext = {"mpeg": "mp3", "mp3": "mp3", "wav": "wav", "x-wav": "wav", "wave": "wav",
           "ogg": "ogg", "mp4": "m4a", "m4a": "m4a", "aac": "aac", "flac": "flac", "webm": "webm"}[kind]
    try:
        raw = base64.b64decode(m.group(2))
    except Exception:
        return web.json_response({"error": "base64 解码失败"}, status=400)
    if len(raw) > 20 * 1024 * 1024:
        return web.json_response({"error": "音频超过 20MB 上限"}, status=400)
    fn = f"ref_{int(time.time() * 1000)}.{ext}"
    with open(os.path.join(AUD_DIR, fn), "wb") as f:
        f.write(raw)
    return web.json_response({"url": f"/api/aud/file/{fn}"})


# ── 媒体垃圾清理：删除节点不会立即删文件（复制的节点共享同一文件），
#    由 GC 扫描全部存档（graphs/ + imagegraphs/）中引用的文件，未引用且超过 10 分钟的才删 ──
MEDIA_GC_MIN_AGE = 600  # 秒。刚生成的文件可能还没被自动保存到存档，保护窗口


def _collect_referenced_media():
    refs = set()
    for d in (GRAPHS_DIR, IMG_GRAPHS_DIR):
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for fn in names:
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(d, fn), encoding="utf-8") as f:
                    text = f.read()
            except OSError:
                continue
            for m in re.finditer(r"/api/(?:img|vid|aud)/file/([A-Za-z0-9_.\-]+)", text):
                refs.add(m.group(1))
    return refs


async def api_media_gc(request):
    """POST /api/media/gc：删除 images/ 与 videos/ 中未被任何存档引用且超过保护窗口的文件 → {deleted, files}"""
    refs = _collect_referenced_media()
    cutoff = time.time() - MEDIA_GC_MIN_AGE
    deleted = []
    for d in (IMG_DIR, VID_DIR):
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for fn in names:
            fp = os.path.join(d, fn)
            if fn in refs or not os.path.isfile(fp):
                continue
            try:
                if os.path.getmtime(fp) > cutoff:
                    continue  # 刚生成，等自动保存落盘后再看
                os.remove(fp)
                deleted.append(fn)
            except OSError:
                pass
    # 清理内存里指向已删文件的任务结果缓存（避免轮询接口返回 404 的 URL）
    for cache in (img_task_files, vid_task_files):
        for tid in [t for t, fl in cache.items() if any(f in deleted for f in fl)]:
            cache.pop(tid, None)
    log.info(f"media gc: deleted {len(deleted)} files")
    return web.json_response({"deleted": len(deleted), "files": deleted[:50]})


# 生图画布存档（与小说 graphs 同模式，独立目录）
def _img_graph_path(name):
    return os.path.join(IMG_GRAPHS_DIR, name + ".json")


async def api_imagegraphs(request):
    items = []
    for fn in os.listdir(IMG_GRAPHS_DIR):
        if fn.endswith(".json"):
            fp = os.path.join(IMG_GRAPHS_DIR, fn)
            try:
                items.append((os.path.getmtime(fp), fn[:-5]))
            except OSError:
                pass
    items.sort(reverse=True)
    return web.json_response({"graphs": [n for _, n in items]})


async def api_imagegraph_get(request):
    name = safe_name(request.query.get("name", ""))
    if not name:
        return web.json_response({"error": "非法名称"}, status=400)
    fp = _img_graph_path(name)
    if not os.path.isfile(fp):
        return web.json_response({"error": "画布不存在"}, status=404)
    with open(fp, encoding="utf-8") as f:
        return web.Response(text=f.read(), content_type="application/json")


async def api_imagegraph_save(request):
    name = safe_name(request.query.get("name", ""))
    if not name:
        return web.json_response({"error": "非法名称"}, status=400)
    try:
        data = await request.json()
        if not isinstance(data, dict) or "graph" not in data:
            raise ValueError("缺少 graph 字段")
    except Exception:
        return web.json_response({"error": "请求格式错误"}, status=400)
    with open(_img_graph_path(name), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return web.json_response({"ok": True, "savedAt": time.strftime("%H:%M:%S")})


async def api_imagegraph_delete(request):
    name = safe_name(request.query.get("name", ""))
    if not name:
        return web.json_response({"error": "非法名称"}, status=400)
    fp = _img_graph_path(name)
    if os.path.isfile(fp):
        os.remove(fp)
    return web.json_response({"ok": True})


# 文本素材库（提示词片段，跨画布共用）：单文件存储，按名称 upsert
SNIPPETS_PATH = os.path.join(BASE, "text_snippets.json")


def _load_snippets():
    try:
        with open(SNIPPETS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


async def api_snippet_list(request):
    return web.json_response({"snippets": _load_snippets()})


async def api_snippet_save(request):
    try:
        body = await request.json()
        name = str(body.get("name") or "").strip()[:60]
        text = str(body.get("text") or "")
        if not name or not text.strip():
            raise ValueError("名称与内容不能为空")
    except Exception:
        return web.json_response({"error": "请求格式错误（需要 name/text）"}, status=400)
    items = [s for s in _load_snippets() if s.get("name") != name]
    items.insert(0, {"name": name, "text": text, "createdAt": int(time.time() * 1000)})
    with open(SNIPPETS_PATH, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    return web.json_response({"ok": True, "snippets": items})


async def api_snippet_delete(request):
    name = request.query.get("name", "")
    items = [s for s in _load_snippets() if s.get("name") != name]
    with open(SNIPPETS_PATH, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    return web.json_response({"ok": True, "snippets": items})


CLIENTLOG_PATH = os.path.join(BASE, "clientlog.txt")

@web.middleware
async def cache_headers_mw(request, handler):
    """静态资源缓存策略：带内容哈希的 assets 永久缓存；HTML 入口不缓存。
    否则重新部署后浏览器仍用旧入口引用已删除的旧 chunk → lazy import 404 → 白屏。"""
    resp = await handler(request)
    path = request.path
    if path.startswith("/assets/"):
        resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    elif path == "/" or path.endswith(".html"):
        resp.headers.setdefault("Cache-Control", "no-cache")
    return resp

async def api_log(request):
    """前端诊断上报（手绘窗口自动刷新排查）：body 任意文本，带时间戳追加落盘。"""
    try:
        body = await request.text()
        from datetime import datetime
        line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] [{request.remote}] {body[:2000]}\n"
        with open(CLIENTLOG_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    return web.json_response({"ok": True})


def build_app():
    app = web.Application(client_max_size=64 * 1024 * 1024, middlewares=[cache_headers_mw])
    # 1) API 路由（注册顺序即匹配顺序，先于静态）
    app.router.add_get("/api/graphs", api_graphs)
    app.router.add_get("/api/graph", api_graph_get)
    app.router.add_post("/api/graph", api_graph_save)
    app.router.add_delete("/api/graph", api_graph_delete)
    app.router.add_get("/api/simgraphs", api_simgraphs)
    app.router.add_get("/api/simgraph", api_simgraph_get)
    app.router.add_post("/api/simgraph", api_simgraph_save)
    app.router.add_delete("/api/simgraph", api_simgraph_delete)
    app.router.add_get("/api/imgconfig", api_imgconf_get)
    app.router.add_post("/api/imgconfig", api_imgconf_set)
    app.router.add_get("/api/scriptconfig", api_scriptconf_get)
    app.router.add_post("/api/scriptconfig", api_scriptconf_set)
    app.router.add_get("/api/qwenconfig", api_qwenconf_get)
    app.router.add_post("/api/qwenconfig", api_qwenconf_set)
    app.router.add_get("/api/qwen/ping", api_qwen_ping)
    app.router.add_get("/api/qwen/models", api_qwen_models)
    app.router.add_get("/api/qwen/meta", api_qwen_meta)
    app.router.add_post("/api/qwen/chat", api_qwen_chat)
    app.router.add_post("/api/script/chat", api_script_chat)
    app.router.add_get("/api/skills", api_skills_list)
    app.router.add_post("/api/skill", api_skill_add)
    app.router.add_delete("/api/skill", api_skill_delete)
    app.router.add_post("/api/skill/install", api_skill_install)
    app.router.add_post("/api/img/submit", api_img_submit)
    app.router.add_get("/api/img/task/{task_id}", api_img_task)
    app.router.add_get("/api/img/models", api_img_models)
    app.router.add_post("/api/img/upload", api_img_upload)
    app.router.add_post("/api/img/fetch", api_img_fetch)
    app.router.add_get("/api/img/file/{name}", api_img_file)
    app.router.add_post("/api/vid/submit", api_vid_submit)
    app.router.add_get("/api/vid/task/{task_id}", api_vid_task)
    app.router.add_get("/api/vid/file/{name}", api_vid_file)
    app.router.add_post("/api/aud/submit", api_aud_submit)
    app.router.add_post("/api/aud/upload", api_aud_upload)
    app.router.add_post("/api/aud/fetch", api_aud_fetch)
    app.router.add_get("/api/aud/task/{task_id}", api_aud_task)
    app.router.add_get("/api/aud/file/{name}", api_aud_file)
    app.router.add_post("/api/media/gc", api_media_gc)
    app.router.add_get("/api/imagegraphs", api_imagegraphs)
    app.router.add_get("/api/imagegraph", api_imagegraph_get)
    app.router.add_post("/api/imagegraph", api_imagegraph_save)
    app.router.add_delete("/api/imagegraph", api_imagegraph_delete)
    app.router.add_get("/api/snippets", api_snippet_list)
    app.router.add_post("/api/snippet", api_snippet_save)
    app.router.add_delete("/api/snippet", api_snippet_delete)
    app.router.add_get("/api/charassets", api_charassets_list)
    app.router.add_post("/api/charasset", api_charasset_upload)
    app.router.add_delete("/api/charasset", api_charasset_delete)
    app.router.add_get("/api/charasset/file/{aid}", api_charasset_file)
    app.router.add_post("/api/log", api_log)
    # 2) SPA 入口（nginx rewrite /<部署子路径>/ → /）
    if spa_entry():
        app.router.add_get("/", index)
        # 3) 静态资产最后注册（/assets/* 等）
        app.router.add_static("/", path=DIST, show_index=False)
    else:
        log.warning("dist/studio.html 不存在，仅提供 API；请先执行 pnpm build")
    return app


if __name__ == "__main__":
    web.run_app(build_app(), host=HOST, port=PORT)
