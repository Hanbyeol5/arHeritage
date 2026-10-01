#!/usr/bin/env bash
# 새 PC 개발 환경 준비 (macOS · Linux · Windows Git Bash)
#   bash scripts/setup.sh          # 웹앱
#   bash scripts/setup.sh --all    # + Worker, 보조 도구(tools)
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s\n' "$1"; }

step 'Node.js 확인 (24 이상 필요)'
command -v node >/dev/null || { echo 'Node.js 가 없습니다. https://nodejs.org 에서 24 LTS 를 설치하세요.'; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || { echo "Node.js $(node -v) — 24 이상이 필요합니다."; exit 1; }
echo "node $(node -v), npm $(npm -v)"

step '웹앱 의존성 설치 (npm ci)'
npm ci

step '.env.local 준비'
if [ -f .env.local ]; then echo '.env.local 이 이미 있어 그대로 둡니다.'
else cp .env.example .env.local; echo '.env.example → .env.local 복사 (네이버 지도 키·API 주소 기본값 포함)'; fi

if [ "${1:-}" = "--all" ]; then
  step 'Worker 의존성 설치'
  (cd worker && npm ci && { [ -f .dev.vars ] || { cp .dev.vars.example .dev.vars; echo 'worker/.dev.vars 생성 — ANTHROPIC_API_KEY 등을 채워야 로컬 Worker 가 동작합니다.'; }; } && npm run typecheck)
  step '보조 도구(tools) 의존성 설치 — 화면 캡처·초상 배경 제거'
  (cd tools && npm install)
fi

step '타입 검사·빌드 확인'
npm run build

printf '\n준비 완료. 개발 서버: npm run dev  →  http://localhost:5173/?lat=37.2818&lng=127.0137#/home\n자세한 내용은 docs/SETUP.md 를 보세요.\n'
