# 새 PC 개발 환경 준비 (Windows PowerShell)
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1          # 웹앱
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -All     # + Worker, 보조 도구(tools)
param([switch]$All)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Yellow }

Step 'Node.js 확인 (24 이상 필요)'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 가 없습니다. https://nodejs.org 에서 24 LTS 를 설치한 뒤 다시 실행하세요.' }
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 24) { throw "Node.js $(node -v) — 24 이상이 필요합니다." }
Write-Host "node $(node -v), npm $(npm -v)"

Step '웹앱 의존성 설치 (npm ci)'
npm ci
if (-not $?) { throw 'npm ci 실패' }

Step '.env.local 준비'
if (Test-Path .env.local) { Write-Host '.env.local 이 이미 있어 그대로 둡니다.' }
else { Copy-Item .env.example .env.local; Write-Host '.env.example → .env.local 복사 (네이버 지도 키·API 주소 기본값 포함)' }

if ($All) {
  Step 'Worker 의존성 설치'
  Push-Location worker
  npm ci
  if (-not (Test-Path .dev.vars)) { Copy-Item .dev.vars.example .dev.vars; Write-Host 'worker\.dev.vars 생성 — ANTHROPIC_API_KEY 등을 채워야 로컬 Worker 가 동작합니다.' }
  npm run typecheck
  Pop-Location

  Step '보조 도구(tools) 의존성 설치 — 화면 캡처·초상 배경 제거'
  Push-Location tools
  npm install
  Pop-Location
}

Step '타입 검사·빌드 확인'
npm run build
if (-not $?) { throw '빌드 실패' }

Write-Host "`n준비 완료. 개발 서버: npm run dev  →  http://localhost:5173/?lat=37.2818&lng=127.0137#/home" -ForegroundColor Green
Write-Host '자세한 내용은 docs\SETUP.md 를 보세요.'
