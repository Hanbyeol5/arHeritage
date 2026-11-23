/**
 * 회원 · 사용자별 저장 · 대화에서 배운 RAG · 퀴즈 (Android 앱 로그인 사용자)
 *
 * DB 를 쓰지 않고 사용자마다 JSON 파일로 저장한다. 파일은 Workers KV(STORE)에 「경로 = 키」로 둔다
 * (R2 를 켜면 같은 경로로 옮길 수 있다).
 *
 *   users/<아이디>.json            계정 (이름 · 비밀번호 해시 · 가입일)
 *   users/<아이디>/chats.json      대화 기록 — 인물별 질문·답 (방식 · RAG 근거 여부 · 시각)
 *   users/<아이디>/learned.json    RAG 자료 없이 LLM 이 답한 질문·답 → 이 사용자의 RAG 자료 (다음 검색에 함께 쓰임)
 *   users/<아이디>/quiz.json       지금 퀴즈 + 지난 점수
 *   sessions/<토큰>               로그인 세션 (30일 뒤 자동 삭제)
 *
 * 비밀번호는 PBKDF2-SHA256(소금 16바이트, 30,000회)으로 해시해 저장한다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { afterDeath } from './ragText.ts';
import { StoreError, addChunks, emptyOverlay, type Overlay } from './store.ts';

export interface UserEnv {
  STORE: KVNamespace;
  SITE_BASE: string;
}

const MODEL = 'claude-opus-5';
const SESSION_TTL = 30 * 24 * 3600;
const PBKDF2_ITER = 30_000;
const MAX_MESSAGES_PER_FIGURE = 100;
const MAX_LEARNED = 300;

// ---------- 파일 ----------
const userFile = (id: string) => `users/${id}.json`;
const chatsFile = (id: string) => `users/${id}/chats.json`;
const learnedFile = (id: string) => `users/${id}/learned.json`;
const quizFile = (id: string) => `users/${id}/quiz.json`;
const sessionFile = (token: string) => `sessions/${token}`;

const readFile = <T>(env: UserEnv, path: string) => env.STORE.get<T>(path, 'json');
const writeFile = (env: UserEnv, path: string, value: unknown, ttl?: number) =>
  env.STORE.put(path, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined);

interface Account {
  id: string;
  name: string;
  salt: string;
  hash: string;
  iter: number;
  createdAt: string;
}
interface ChatLine {
  q: string;
  a: string;
  mode: string;
  grounded: boolean;
  at: string;
}
interface Chats {
  figures: Record<string, { name: string; messages: ChatLine[] }>;
}
export interface Learned {
  id: string;
  figureId: string;
  figureName: string;
  q: string;
  a: string;
  at: string;
}
interface QuizItem {
  question: string;
  choices: string[];
  answer: number;
  explanation: string;
  figureName: string;
}
interface QuizFile {
  current?: { id: string; createdAt: string; items: QuizItem[]; answers: (number | null)[] };
  history: { id: string; at: string; score: number; total: number }[];
}

// ---------- 비밀번호 · 세션 ----------
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));

async function hashPassword(password: string, salt: Uint8Array, iter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return hex(bits);
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function newSession(env: UserEnv, id: string): Promise<string> {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await writeFile(env, sessionFile(token), { id, at: new Date().toISOString() }, SESSION_TTL);
  return token;
}

/** Authorization: Bearer <토큰> → 로그인한 사용자 아이디 (없거나 만료면 undefined) */
export async function currentUser(req: Request, env: UserEnv): Promise<string | undefined> {
  const m = (req.headers.get('Authorization') ?? '').match(/^Bearer\s+([0-9a-f]{64})$/i);
  if (!m || !env.STORE) return undefined;
  const s = await readFile<{ id: string }>(env, sessionFile(m[1].toLowerCase()));
  return s?.id;
}
async function needUser(req: Request, env: UserEnv): Promise<string> {
  const id = await currentUser(req, env);
  if (!id) throw new StoreError(401, '로그인이 필요합니다.');
  return id;
}

// ---------- 사용자별 RAG (대화에서 배운 것) ----------
/** 이 사용자가 배운 질문·답을 RAG 조각으로 (출처 id 「me:<인물 id>」, 대화 상대 인물이면 가중치) */
export async function userOverlay(env: UserEnv, userId: string | undefined): Promise<Overlay> {
  const o = emptyOverlay();
  if (!userId) return o;
  const list = (await readFile<Learned[]>(env, learnedFile(userId))) ?? [];
  for (const l of list) {
    addChunks(o, { s: `me:${l.figureId}`, t: `내 대화 기록 (${l.figureName})`, head: `${l.figureName}에게 물은 것: ${l.q}`, body: `답: ${l.a}` });
  }
  o.version = `me${list.length}`;
  return o;
}

/** 거절·모른다는 답은 배우지 않는다 */
const REFUSAL = /(알지 못|모르|들어보지 못|후세의 일|답하기 어렵|기록이 분명치|떠난 뒤의 일|대답하지 못)/;

// ---------- 입력 ----------
const Id = z.string().regex(/^[a-z0-9_]{3,20}$/, '아이디는 영문 소문자·숫자·밑줄 3~20자입니다.');
const Signup = z.object({ id: Id, password: z.string().min(6, '비밀번호는 6자 이상입니다.').max(64), name: z.string().trim().min(1).max(20) });
const Login = z.object({ id: z.string().max(20), password: z.string().max(64) });
const Log = z.object({
  figureId: z.string().max(64),
  figureName: z.string().max(40).optional(),
  mode: z.string().max(16),
  question: z.string().min(1).max(500),
  answer: z.string().min(1).max(2000),
  grounded: z.boolean(),
  died: z.number().int().optional(),
});
const QuizReq = z.object({ count: z.number().int().min(3).max(10).optional() });
const QuizAnswer = z.object({ index: z.number().int().min(0), choice: z.number().int().min(0).max(3) });

const QuizSchema = z.object({
  items: z.array(
    z.object({
      question: z.string(),
      choices: z.array(z.string()),
      answer: z.number().int(),
      explanation: z.string(),
      figureName: z.string(),
    }),
  ),
});

const publicQuiz = (q: NonNullable<QuizFile['current']>) => ({
  id: q.id,
  createdAt: q.createdAt,
  items: q.items.map((it, i) => ({
    question: it.question,
    choices: it.choices,
    figureName: it.figureName,
    // 답한 문제만 정답·해설을 보여 준다
    ...(q.answers[i] != null ? { chosen: q.answers[i], answer: it.answer, explanation: it.explanation, correct: q.answers[i] === it.answer } : {}),
  })),
  score: q.answers.filter((a, i) => a != null && a === q.items[i].answer).length,
  answered: q.answers.filter((a) => a != null).length,
});

// ---------- HTTP ----------
type Reply = { body: unknown; status?: number };

/** /auth/* · /me/* 처리. 해당 경로가 아니면 undefined */
export async function handleUsers(req: Request, env: UserEnv, path: string, client: () => Anthropic): Promise<Reply | undefined> {
  if (!path.startsWith('/auth/') && !path.startsWith('/me')) return undefined;
  if (!env.STORE) throw new StoreError(503, '서버 저장소(KV)가 연결되지 않았습니다.');
  const m = req.method;

  if (path === '/auth/signup' && m === 'POST') {
    const b = Signup.parse(await req.json());
    if (await readFile(env, userFile(b.id))) throw new StoreError(409, '이미 쓰고 있는 아이디입니다.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const acc: Account = { id: b.id, name: b.name, salt: hex(salt), hash: await hashPassword(b.password, salt, PBKDF2_ITER), iter: PBKDF2_ITER, createdAt: new Date().toISOString() };
    await writeFile(env, userFile(b.id), acc);
    return { body: { token: await newSession(env, b.id), user: { id: acc.id, name: acc.name, createdAt: acc.createdAt } } };
  }
  if (path === '/auth/login' && m === 'POST') {
    const b = Login.parse(await req.json());
    const acc = await readFile<Account>(env, userFile(b.id.trim().toLowerCase()));
    const ok = acc && sameText(await hashPassword(b.password, unhex(acc.salt), acc.iter), acc.hash);
    if (!acc || !ok) throw new StoreError(401, '아이디 또는 비밀번호가 맞지 않습니다.');
    return { body: { token: await newSession(env, acc.id), user: { id: acc.id, name: acc.name, createdAt: acc.createdAt } } };
  }
  if (path === '/auth/logout' && m === 'POST') {
    const t = (req.headers.get('Authorization') ?? '').match(/^Bearer\s+([0-9a-f]{64})$/i)?.[1];
    if (t) await env.STORE.delete(sessionFile(t.toLowerCase()));
    return { body: { ok: true } };
  }

  const uid = await needUser(req, env);

  if (path === '/me' && m === 'GET') {
    const [acc, chats, learned, quiz] = await Promise.all([
      readFile<Account>(env, userFile(uid)),
      readFile<Chats>(env, chatsFile(uid)),
      readFile<Learned[]>(env, learnedFile(uid)),
      readFile<QuizFile>(env, quizFile(uid)),
    ]);
    if (!acc) throw new StoreError(404, '계정을 찾을 수 없습니다.');
    const figures = Object.entries(chats?.figures ?? {});
    return {
      body: {
        user: { id: acc.id, name: acc.name, createdAt: acc.createdAt },
        stats: {
          figures: figures.length,
          questions: figures.reduce((n, [, f]) => n + f.messages.length, 0),
          learned: learned?.length ?? 0,
          quizzes: quiz?.history.length ?? 0,
          bestScore: quiz?.history.reduce((b, h) => Math.max(b, h.total ? Math.round((h.score / h.total) * 100) : 0), 0) ?? 0,
        },
      },
    };
  }

  // 질문·답 기록 (모든 대화 방식). RAG 근거 없이 LLM 이 답했으면 이 사용자의 RAG 자료로 배운다
  if (path === '/me/log' && m === 'POST') {
    const b = Log.parse(await req.json());
    const at = new Date().toISOString();
    const chats = (await readFile<Chats>(env, chatsFile(uid))) ?? { figures: {} };
    const f = (chats.figures[b.figureId] ??= { name: b.figureName ?? b.figureId, messages: [] });
    if (b.figureName) f.name = b.figureName;
    f.messages.push({ q: b.question, a: b.answer, mode: b.mode, grounded: b.grounded, at });
    if (f.messages.length > MAX_MESSAGES_PER_FIGURE) f.messages.splice(0, f.messages.length - MAX_MESSAGES_PER_FIGURE);
    const writes: Promise<unknown>[] = [writeFile(env, chatsFile(uid), chats)];

    const ragMode = ['RAG', 'BACKEND', 'EXTERNAL', 'rag', 'custom'].includes(b.mode);
    const learn =
      ragMode &&
      !b.grounded &&
      !b.figureId.startsWith('guide:') &&
      b.question.trim().length >= 6 && // 「안녕하세요」 같은 인사는 배우지 않는다
      b.answer.length >= 20 &&
      !REFUSAL.test(b.answer) &&
      !(b.died && afterDeath(b.question, b.died));
    if (learn) {
      const list = (await readFile<Learned[]>(env, learnedFile(uid))) ?? [];
      list.push({ id: hex(crypto.getRandomValues(new Uint8Array(6))), figureId: b.figureId, figureName: f.name, q: b.question, a: b.answer, at });
      if (list.length > MAX_LEARNED) list.splice(0, list.length - MAX_LEARNED);
      writes.push(writeFile(env, learnedFile(uid), list));
    }
    await Promise.all(writes);
    return { body: { saved: true, learned: learn } };
  }

  if (path === '/me/chats' && m === 'GET') {
    const chats = (await readFile<Chats>(env, chatsFile(uid))) ?? { figures: {} };
    return { body: chats };
  }
  if (path === '/me/learned' && m === 'GET') {
    return { body: { learned: (await readFile<Learned[]>(env, learnedFile(uid))) ?? [] } };
  }
  // 백엔드 RAG(앱 안 Gemini) 용: 이 인물에 대해 배운 조각
  if (path.startsWith('/me/context/') && m === 'GET') {
    const fid = decodeURIComponent(path.slice('/me/context/'.length)).replace(/^fig_/, '');
    const list = ((await readFile<Learned[]>(env, learnedFile(uid))) ?? []).filter((l) => l.figureId === fid).slice(-6);
    return { body: { chunks: list.map((l) => ({ source: `내 대화 기록 (${l.figureName})`, text: `질문: ${l.q}\n답: ${l.a}` })) } };
  }

  // ---------- 퀴즈 ----------
  if (path === '/me/quiz' && m === 'GET') {
    const quiz = (await readFile<QuizFile>(env, quizFile(uid))) ?? { history: [] };
    return { body: { current: quiz.current ? publicQuiz(quiz.current) : null, history: quiz.history } };
  }
  if (path === '/me/quiz' && m === 'POST') {
    const { count = 5 } = QuizReq.parse(await req.json().catch(() => ({})));
    const chats = (await readFile<Chats>(env, chatsFile(uid))) ?? { figures: {} };
    const lines = Object.values(chats.figures)
      .flatMap((f) => f.messages.map((x) => ({ ...x, name: f.name })))
      .filter((x) => !REFUSAL.test(x.a))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 30);
    if (lines.length < 2) throw new StoreError(400, '퀴즈를 만들 질문이 부족해요. 인물과 대화를 몇 번 더 나눠 보세요.');
    const source = lines.map((x, i) => `${i + 1}. [${x.name}] 질문: ${x.q}\n   답: ${x.a}`).join('\n');
    const res = await client().beta.messages.parse({
      model: MODEL,
      max_tokens: 6000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: betaZodOutputFormat(QuizSchema) },
      messages: [
        {
          role: 'user',
          content: `역사 학습 앱의 복습 퀴즈를 만든다. 아래는 한 사용자가 역사 인물에게 직접 물었던 질문과 인물의 답이다.
이 대화에 나온 사실만으로 ${count}문제의 4지선다 퀴즈를 만들어라.

규칙:
- 사용자가 실제로 물었던 내용에서 고르고, 여러 인물·주제가 섞이도록 한다.
- 정답은 위 답에 적힌 사실이어야 한다. 대화에 없는 사실로 문제를 내거나 지어내지 않는다.
- choices 는 보기 4개, answer 는 정답 보기의 번호(0~3). 오답 보기도 그럴듯하게.
- question 은 한국어 한 문장, explanation 은 정답 근거를 1~2문장(100자 안팎).
- figureName 은 그 문제가 나온 대화의 인물 이름.

[사용자의 질문과 답]
${source}`,
        },
      ],
    });
    const items = (res.parsed_output?.items ?? [])
      .filter((it) => it.choices.length === 4 && it.answer >= 0 && it.answer <= 3 && it.question.trim())
      .slice(0, count);
    if (!items.length) throw new StoreError(422, '퀴즈를 만들지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    const quiz = (await readFile<QuizFile>(env, quizFile(uid))) ?? { history: [] };
    quiz.current = { id: hex(crypto.getRandomValues(new Uint8Array(6))), createdAt: new Date().toISOString(), items, answers: items.map(() => null) };
    await writeFile(env, quizFile(uid), quiz);
    return { body: { current: publicQuiz(quiz.current) } };
  }
  if (path === '/me/quiz/answer' && m === 'POST') {
    const b = QuizAnswer.parse(await req.json());
    const quiz = (await readFile<QuizFile>(env, quizFile(uid))) ?? { history: [] };
    const cur = quiz.current;
    if (!cur || b.index >= cur.items.length) throw new StoreError(404, '진행 중인 퀴즈가 없습니다.');
    if (cur.answers[b.index] == null) {
      cur.answers[b.index] = b.choice;
      // 다 풀면 기록에 남긴다
      if (cur.answers.every((a) => a != null)) {
        quiz.history.push({ id: cur.id, at: new Date().toISOString(), score: publicQuiz(cur).score, total: cur.items.length });
        if (quiz.history.length > 50) quiz.history.splice(0, quiz.history.length - 50);
      }
      await writeFile(env, quizFile(uid), quiz);
    }
    const it = cur.items[b.index];
    return { body: { correct: cur.answers[b.index] === it.answer, answer: it.answer, explanation: it.explanation, quiz: publicQuiz(cur) } };
  }
  return undefined;
}
