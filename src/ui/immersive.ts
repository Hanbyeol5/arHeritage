/**
 * 몰입 모드 — 조작 버튼을 잠시 뒤 숨기고, 화면을 터치하면 다시 보여 준다 (AR·대화 화면).
 * 숨겨진 버튼은 pointer-events 가 꺼져 있어 첫 터치는 버튼을 누르지 않고 화면만 깨운다.
 */
export function immersive(root: HTMLElement, ms = 3500): () => void {
  let timer = 0;
  const hide = () => {
    // 글자를 입력하는 중에는 숨기지 않는다
    if (root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return schedule();
    root.classList.add('ui-hidden');
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(hide, ms);
  };
  const wake = () => {
    root.classList.remove('ui-hidden');
    schedule();
  };
  root.addEventListener('pointerdown', wake, true);
  root.addEventListener('keydown', wake, true);
  schedule();
  return () => {
    clearTimeout(timer);
    root.removeEventListener('pointerdown', wake, true);
    root.removeEventListener('keydown', wake, true);
  };
}

const isStandalone = () =>
  matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** 첫 터치 때 전체 화면으로 (안드로이드 등). iOS 사파리는 웹 페이지 전체 화면을 지원하지 않아 홈 화면 추가를 안내 */
export function enableFullscreenOnTouch(onIosHint: () => void) {
  if (isStandalone()) return;
  const el = document.documentElement;
  if (el.requestFullscreen && document.fullscreenEnabled) {
    const go = () => {
      if (!document.fullscreenElement) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    };
    document.addEventListener('pointerup', go, { once: true, capture: true });
    return;
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (!ios) return;
  try {
    if (localStorage.getItem('yeoksadam:ios-hint')) return;
    localStorage.setItem('yeoksadam:ios-hint', '1');
  } catch {
    /* 저장 불가 환경 */
  }
  setTimeout(onIosHint, 1500);
}
