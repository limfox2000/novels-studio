#!/usr/bin/env bash
# novels-studio 一键部署：构建 + 上传 server.py/dist + 重启 8768 + 冒烟验证
# 配置读仓库根 .env（DEPLOY_HOST/USER/REMOTE_DIR/BASE_PATH，参考 .env.example）。
# SSH 认证优先走本机 key（免密）。
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "✗ 缺少 .env（参考 .env.example）"; exit 1; }
set -a; source .env; set +a
SSH_TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
BASE_PATH="${DEPLOY_BASE_PATH:-/novels-studio}"
BASE_PATH="${BASE_PATH%/}"

echo "==> 1/5 pnpm install + build"
pnpm install --frozen-lockfile
pnpm build

echo "==> 2/5 本地产物标记检查（含 Qwen 引擎代码）"
grep -rl "api/qwen" dist/assets/*.js >/dev/null || { echo "✗ dist 未包含 qwen 代码"; exit 1; }

echo "==> 3/5 上传 server.py + dist/"
ssh "$SSH_TARGET" "mkdir -p $DEPLOY_REMOTE_DIR/dist"
scp -q server.py "$SSH_TARGET:$DEPLOY_REMOTE_DIR/server.py"
scp -q -r dist/* "$SSH_TARGET:$DEPLOY_REMOTE_DIR/dist/"

echo "==> 4/5 服务器侧：校验产物 + 写 qwenconfig + 重启 8768"
ssh "$SSH_TARGET" bash -s <<REMOTE
set -e
cd $DEPLOY_REMOTE_DIR
# 产物校验：远程 assets 必须同样含 qwen 标记
grep -rl "api/qwen" dist/assets/*.js >/dev/null || { echo "✗ 服务器 dist 校验失败"; exit 1; }
# qwenconfig（已存在则保留）
if [ ! -f qwenconfig.json ]; then
  cat > qwenconfig.json <<'CONF'
{"base_url": "", "model": "", "api_key": ""}
CONF
  chmod 600 qwenconfig.json
  echo "已创建 qwenconfig.json 模板（需填入 base_url/model）"
fi
# 重启：只杀 8768 对应 PID（严禁 broad pkill）
PID=\$(ss -tlnp | grep ':8768 ' | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "\$PID" ]; then cp server.py server.py.bak.\$PID; kill \$PID; sleep 1; fi
setsid nohup python3 server.py >> /tmp/novels_canvas.log 2>&1 &
sleep 2
ss -tlnp | grep ':8768 ' || { echo "✗ 8768 未监听"; tail -20 /tmp/novels_canvas.log; exit 1; }
REMOTE

echo "==> 5/5 冒烟验证（公网入口 + qwen ping）"
curl -sk "https://$DEPLOY_HOST$BASE_PATH/api/graphs" | head -c 120; echo
curl -sk "https://$DEPLOY_HOST$BASE_PATH/api/qwen/ping"; echo
echo "✓ 部署完成"
