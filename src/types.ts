/** 지도·AR에서 쓰는 경량 항목 (public/data/index.json) */
export interface HeritageSummary {
  id: string;
  name: string;
  /** 국보, 보물, 사적, 경기도 유형문화유산 등 */
  designation: string;
  /** 유적건조물, 유물, 자연유산 등 */
  category: string;
  era: string;
  city: string;
  lat: number;
  lng: number;
  thumb?: string;
}

export interface HeritageIndex {
  region: string;
  generatedAt: string;
  source: string;
  count: number;
  items: HeritageSummary[];
}

/** 초상이 없을 때 쓰는 목업 일러스트 종류 */
export type FigureStyle = 'king' | 'scholar' | 'lady' | 'general';

/** 역사 인물 (public/data/figures.json) */
export interface Figure {
  id: string;
  name: string;
  hanja: string;
  /** 호 또는 직함 */
  title: string;
  years: string;
  /** 메달 우하단 낙관 글자 */
  seal: string;
  style: FigureStyle;
  bio: string;
  portrait?: string;
  /** 배경을 제거한 AR 용 초상 (없으면 목업 일러스트 컷아웃) */
  cutout?: string;
  portraitCredit?: string;
  /** 서버 음성(Azure) 이름 */
  voice?: string;
  /** 초상 정보가 없을 때 AR 에 세울 전신 모습 */
  fullBody?: 'guide' | 'king' | 'scholar';
  /** 역사 인물이 아닌 유적지 해설사 */
  role?: 'guide';
  /** 진본 초상이 없어 새로 그린 상상 초상 */
  imagined?: boolean;
  sites: { id: string; note: string }[];
}

/** LLM 보강 단계에서 채워질 관련 인물 */
export interface RelatedPerson {
  name: string;
  hanja?: string;
  years?: string;
  role: string;
  portrait?: { url: string; credit: string };
  wikidataId?: string;
}

/** 상세 카드용 (public/data/detail/<id>.json) */
export interface HeritageDetail {
  id: string;
  name: string;
  nameHanja: string;
  designation: string;
  category: string;
  subCategory: string;
  era: string;
  city: string;
  address: string;
  designatedAt: string;
  lat: number;
  lng: number;
  image?: string;
  images: { url: string; desc: string }[];
  description: string;
  sourceUrl: string;
  /** LLM 보강 단계(빌드 시점)에서 추가 */
  summary?: string;
  persons?: RelatedPerson[];
}
