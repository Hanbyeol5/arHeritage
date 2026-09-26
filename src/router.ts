export type Tab = 'camera' | 'map' | 'home' | 'qa' | 'menu';

export interface Screen {
  /** 하단 탭에서 강조할 항목 */
  tab?: Tab;
  /** 카메라·AR·대화처럼 하단 탭 없이 전체 화면을 쓰는 화면 */
  fullscreen?: boolean;
  mount(root: HTMLElement, params: string[], query: URLSearchParams): void | (() => void);
}

type Route = [RegExp, Screen];

export class Router {
  private routes: Route[] = [];
  private cleanup?: () => void;
  private fallback = '#/home';

  constructor(
    private view: HTMLElement,
    private onChange: (screen: Screen) => void,
  ) {
    window.addEventListener('hashchange', () => this.render());
  }

  add(pattern: RegExp, screen: Screen) {
    this.routes.push([pattern, screen]);
    return this;
  }

  render() {
    const [path, qs = ''] = location.hash.replace(/^#/, '').split('?');
    for (const [re, screen] of this.routes) {
      const m = path.match(re);
      if (!m) continue;
      this.cleanup?.();
      this.cleanup = undefined;
      this.view.replaceChildren();
      this.onChange(screen);
      this.cleanup = screen.mount(this.view, m.slice(1).map(decodeURIComponent), new URLSearchParams(qs)) ?? undefined;
      return;
    }
    location.replace(this.fallback);
  }
}

export const go = (hash: string) => {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
};
