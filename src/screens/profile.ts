import { josa } from '../ui/josa.ts';
import { app } from '../app.ts';
import { openBottomSheet } from '../heritageSheet.ts';
import type { Screen } from '../router.ts';
import { store, type ChatMode, type Discovery, type DiscoveryType } from '../store.ts';
import { titleTopbar } from '../ui/chrome.ts';
import { esc } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { imageMedal, medal, monoMedal } from '../ui/medal.ts';

const TABS: [DiscoveryType, string][] = [
  ['site', '유적지'],
  ['figure', '인물'],
  ['relic', '유물'],
];
let tab: DiscoveryType = 'figure';

/** 도감 항목의 메달: 인물 데이터가 있으면 초상, 이미지가 있으면 사진, 없으면 첫 글자 */
function discoveryMedal(d: Discovery, size: number): string {
  const f = d.type === 'figure' ? app.figureById.get(d.refId) : undefined;
  if (f) return medal(f, { size });
  return d.imageUrl ? imageMedal(d.imageUrl, size, d.name) : monoMedal(d.name, size);
}

/** 8. 내 프로필 · 역사의 전당 (수집 · 분류 · 삭제) */
export const profileScreen: Screen = {
  tab: 'menu',
  mount(root) {
    const render = () => {
      const all = store.discoveries();
      const current = all.filter((d) => d.type === tab);
      const label = TABS.find(([t]) => t === tab)![1];
      root.innerHTML = `<div class="scr">
        ${titleTopbar('내 프로필', `<button class="icbtn ghost more" aria-label="닉네임 바꾸기">${icons.more}</button>`)}
        <div class="prof">
          <div class="me-card">
            ${monoMedal(store.nickname, 62)}
            <div class="mi"><b>${esc(store.nickname)}</b><small>역사 탐험가</small>
              <div class="lv">${icons.star} 만난 인물 ${all.filter((d) => d.type === 'figure').length}명</div></div>
          </div>
          ${settingsCard()}
          <div class="hall">
            <div class="ht"><span class="em">堂</span><b>역사의 전당</b></div>
            <div class="tabs">${TABS.map(([t, l]) => {
              const n = all.filter((d) => d.type === t).length;
              return `<button data-tab="${t}" class="${t === tab ? 'on' : ''}">${l}${n ? ` ${n}` : ''}</button>`;
            }).join('')}</div>
            ${
              current.length
                ? `<div class="gal">${current
                    .map(
                      (d, i) =>
                        `<button class="g" data-i="${i}">${discoveryMedal(d, 64)}<span>${esc(d.name)}</span></button>`,
                    )
                    .join('')}</div>`
                : `<p class="hall-empty">아직 발견한 ${label}${label === '인물' ? '이' : '가'} 없어요.<br />카메라로 문화재를 촬영해 보세요.</p>`
            }
          </div>
        </div>
      </div>`;

      root.querySelectorAll<HTMLElement>('.tabs button').forEach((b) =>
        b.addEventListener('click', () => {
          tab = b.dataset.tab as DiscoveryType;
          render();
        }),
      );
      root.querySelectorAll<HTMLElement>('.gal [data-i]').forEach((b) =>
        b.addEventListener('click', () => openDiscovery(current[Number(b.dataset.i)])),
      );
      bindSettings(root);
      root.querySelector('.more')!.addEventListener('click', () => {
        const name = prompt('닉네임을 입력하세요', store.nickname);
        if (name) store.setNickname(name);
      });
    };
    render();
    return store.onChange(render);
  },
};

const fmt = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

/** 도감 항목 상세 — 이미지 + 명칭 + 설명 다시 보기 + 삭제 */
function openDiscovery(d: Discovery) {
  const sheet = openBottomSheet(
    `<div class="disc">
      ${d.imageUrl ? `<img class="disc-img" src="${esc(d.imageUrl)}" alt="${esc(d.name)}" referrerpolicy="no-referrer" />` : `<div class="disc-med">${discoveryMedal(d, 96)}</div>`}
      <h2>${esc(d.name)}</h2>
      ${d.subtitle ? `<div class="meta">${esc(d.subtitle)}</div>` : ''}
      ${d.description ? `<p class="disc-desc">${esc(d.description)}</p>` : ''}
      <div class="credit">${fmt.format(d.at)} 발견</div>
      <div class="sheet-actions">
        <button class="pill outline danger" data-act="del">삭제</button>
        <button class="pill solid" data-act="close">닫기</button>
      </div>
    </div>`,
    'center',
  );
  sheet.querySelector('[data-act=close]')!.addEventListener('click', () => sheet.remove());
  sheet.querySelector('[data-act=del]')!.addEventListener('click', () => {
    if (!confirm(`${josa(`'${d.name}'`, '을/를')} 역사의 전당에서 삭제할까요?`)) return;
    store.remove(d);
    sheet.remove();
  });
}

// ---------- 설정: 인물 대화 방식 ----------
const MODES: [ChatMode, string, string][] = [
  ['basic', '기본', '인물에 연결된 유적 자료를 통째로 참고해 답해요.'],
  ['rag', 'RAG 서버 (역사담 내장)', '질문마다 경기도 유적 1,486곳 자료에서 관련 내용을 검색해 답하고, 근거 유적을 보여 줘요.'],
  ['custom', '외부 RAG 서버 (historydam 호환)', '직접 운영하는 RAG 서버에 질문을 보내요. POST /chat {question} → {answer, referenced_data}'],
];
const modeLabel = (m: ChatMode) => MODES.find(([k]) => k === m)![1];
let settingsOpen = false;

function settingsCard(): string {
  return `<details class="settings" ${settingsOpen ? 'open' : ''}>
    <summary>⚙ 설정 · 인물 대화 방식: <b>${esc(modeLabel(store.chatMode))}</b></summary>
    <div class="set-body">
      ${MODES.map(
        ([k, name, desc]) => `<label class="set-opt">
          <input type="radio" name="chat-mode" value="${k}" ${store.chatMode === k ? 'checked' : ''} />
          <span><b>${esc(name)}</b><small>${esc(desc)}</small></span>
        </label>`,
      ).join('')}
      <div class="set-url" ${store.chatMode === 'custom' ? '' : 'hidden'}>
        <input type="url" inputmode="url" placeholder="https://내-rag-서버.example.com" value="${esc(store.ragUrl)}" />
        <button class="pill outline sm set-test">연결 확인</button>
        <p class="set-msg"></p>
      </div>
    </div>
  </details>`;
}

function bindSettings(root: HTMLElement) {
  const box = root.querySelector<HTMLDetailsElement>('.settings')!;
  box.addEventListener('toggle', () => (settingsOpen = box.open));
  const url = box.querySelector<HTMLInputElement>('.set-url input')!;

  box.querySelectorAll<HTMLInputElement>('input[name=chat-mode]').forEach((r) =>
    r.addEventListener('change', () => store.setChat(r.value as ChatMode, url.value)),
  );
  url.addEventListener('change', () => store.setChat('custom', url.value));
  box.querySelector('.set-test')!.addEventListener('click', async () => {
    store.setChat('custom', url.value);
    const base = url.value.trim().replace(/\/+$/, '');
    const m = root.querySelector<HTMLElement>('.set-msg')!;
    if (!/^https?:\/\//.test(base)) return void (m.textContent = '주소를 https:// 로 시작하게 입력해 주세요.');
    if (location.protocol === 'https:' && base.startsWith('http:')) return void (m.textContent = 'HTTPS 웹앱에서는 http 서버를 부를 수 없어요 (혼합 콘텐츠 차단).');
    m.textContent = '확인 중…';
    try {
      const res = await fetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '안녕하세요' }) });
      const data = (await res.json()) as { answer?: string };
      m.textContent = res.ok && data.answer ? `✅ 연결됨 — "${data.answer.slice(0, 40)}…"` : `⚠️ 응답 형식이 달라요 (${res.status})`;
    } catch {
      m.textContent = '❌ 연결 실패 — 주소, HTTPS, CORS 허용 여부를 확인해 주세요.';
    }
  });
}
