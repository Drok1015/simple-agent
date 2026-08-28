#!/usr/bin/env bash
# simple-agent 发版脚本：本地检查 → push GitHub → 同步服务器 → 重启服务 → 健康检查
#
# 用法：./scripts/deploy.sh
# 前置：~/.ssh/config 配置 aliyun 主机别名；GitHub 推送走本机 Clash 代理(7897)
set -euo pipefail

REMOTE_HOST=aliyun
REMOTE_DIR=/opt/simple-agent
SERVICE=simple-agent
APP_PORT=13000
PROXY="https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897"
cd "$(dirname "$0")/.."

echo "==> 1/5 本地检查（typecheck + test）"
npm run check

BRANCH=$(git branch --show-current)
if [[ -n $(git status --porcelain) ]]; then
  echo "✗ 存在未提交的改动，请先 commit（脚本不做自动提交）"
  git status --short
  exit 1
fi

echo "==> 2/5 推送 $BRANCH 到 GitHub"
env $PROXY git push origin "$BRANCH"

echo "==> 3/5 同步代码到 $REMOTE_HOST:$REMOTE_DIR"
# --chown：ssh 以 root 登录，rsync -a 会把本地 uid/gid(501) 原样带过去，
# 服务运行用户 hamagent 将读不了新文件（EACCES），故强制修正属主
rsync -az \
  --exclude node_modules \
  --exclude .env \
  --exclude .git \
  --exclude dist \
  --exclude large_tool_results \
  --exclude .DS_Store \
  --chown=hamagent:hamagent \
  --chmod=D755,F644 \
  ./ "$REMOTE_HOST:$REMOTE_DIR/"

echo "==> 4/5 服务器安装依赖并重启 $SERVICE"
ssh "$REMOTE_HOST" "cd $REMOTE_DIR && npm install --no-audit --no-fund --loglevel=error \
  && sudo systemctl restart $SERVICE \
  && for i in \$(seq 1 15); do \
       sleep 2; \
       state=\$(systemctl is-active $SERVICE); \
       [[ \$state == active ]] && break; \
     done; \
  systemctl is-active $SERVICE"

echo "==> 5/5 健康检查（$REMOTE_HOST:$APP_PORT）"
sleep 2
ssh "$REMOTE_HOST" "curl -s -m 10 http://127.0.0.1:$APP_PORT/api/health" | head -c 600
echo
echo "✓ 发版完成：https://agent.ruarua520.xyz"
