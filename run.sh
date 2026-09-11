#!/usr/bin/env bash
# coral 一键启动：优先使用已具备依赖的系统 Python，否则创建 venv 安装
set -e
cd "$(dirname "$0")"

deps_ok() {
  "$1" -c "import fastapi, uvicorn, jinja2, yaml, httpx, multipart, markdown, pygments" \
    >/dev/null 2>&1
}

PYTHON=""
for cand in "${CORAL_PYTHON:-}" python3 python; do
  [ -z "$cand" ] && continue
  if command -v "$cand" >/dev/null 2>&1 && deps_ok "$cand"; then
    PYTHON="$cand"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  # 系统 Python 缺依赖 → 建 venv（需要网络可达 PyPI/镜像）
  if [ ! -d venv ]; then
    echo "[coral] 创建虚拟环境 venv ..."
    python3 -m venv venv
  fi
  # shellcheck disable=SC1091
  source venv/bin/activate
  echo "[coral] 安装依赖 ..."
  pip install -q -r requirements.txt
  PYTHON=python
fi

if [ ! -f static/pygments.css ]; then
  echo "[coral] 生成代码高亮样式 ..."
  "$PYTHON" -m tools.gen_pygments_css
fi

HOST=${CORAL_HOST:-0.0.0.0}
PORT=${CORAL_PORT:-8300}
echo "[coral] 使用: $PYTHON"
echo "[coral] 启动: http://127.0.0.1:${PORT}"
exec "$PYTHON" -m uvicorn app.main:app --host "$HOST" --port "$PORT"
