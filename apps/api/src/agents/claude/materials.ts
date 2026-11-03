/**
 * 資料モード: 人が話して決める Issue には、コードを変えずに会議の判断材料を Issue コメントとして書く。
 * 形式（1 行目の印・見出しの順・推奨を書かない）は夜間 Routine の資料コメントと同じにし、
 * どちらが書いた資料でも「その後に人のコメントがあれば実装に進む」判定が同じように効くようにする。
 */
import type { GithubComment } from '../../github/app';

/** 資料コメントの 1 行目に置く印 */
export const MATERIALS_MARKER = '<!-- nightly-materials -->';
/** 資料コメントの見出し（この順に並べる） */
export const MATERIALS_HEADINGS = ['## 決めること', '## 現状', '## 選択肢', '## 会議で確かめる問い'] as const;
/** 推奨・結論の見出しとみなす語（どれにするかは会議で人が決めるので、資料には書かない） */
const FORBIDDEN_HEADING = /推奨|結論|おすすめ|オススメ|recommend|conclusion/i;
/** Developer が設計の判断が要ると分かったときに要約へ書く行 */
const NEEDS_DESIGN_DECISION_LINE = /^[ \t]*NEEDS_DESIGN_DECISION:[ \t]*(.*)$/m;

const firstLine = (body: string) => body.replace(/^﻿/, '').split(/\r?\n/, 1)[0].trim();

/** 1 行目が印で始まるコメントは資料コメント */
export function isMaterialsComment(body: string): boolean {
  return firstLine(body).startsWith(MATERIALS_MARKER);
}

/**
 * 以前に資料を書いた Issue で、いちばん新しい資料コメントの後に人のコメントがあれば、
 * それを会議の決定とみなして 'implement' を返す（人が決めた後も本文の「検討」で毎回資料に戻るのを防ぐ）。
 * 人のコメントには Bot のコメントと資料コメントを含めない。それ以外は null（Planner の判断に任せる）。
 */
export function decideFromComments(comments: GithubComment[]): 'implement' | null {
  // API の返却順に依らず、作成時刻の順に並べる（同時刻は元の順を保つ）
  const sorted = comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) => Date.parse(a.c.createdAt) - Date.parse(b.c.createdAt) || a.i - b.i)
    .map((x) => x.c);
  let latest = -1;
  sorted.forEach((c, i) => {
    if (isMaterialsComment(c.body)) latest = i;
  });
  if (latest < 0) return null;
  const human = sorted.slice(latest + 1).some((c) => c.userType !== 'Bot' && !isMaterialsComment(c.body));
  return human ? 'implement' : null;
}

/**
 * 資料の形式を確かめ、問題を日本語で返す（空なら問題なし）。
 * 1 行目の印、4 つの見出しが 1 回ずつこの順にあること、推奨・結論の見出しが無いことを見る。
 */
export function validateMaterials(md: string): string[] {
  const problems: string[] = [];
  if (firstLine(md) !== MATERIALS_MARKER) problems.push(`1 行目は ${MATERIALS_MARKER} だけにしてください`);
  const headings = md
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^#{1,6}\s/.test(l));
  const level2 = headings.filter((h) => /^##\s/.test(h)).map((h) => h.replace(/\s+/g, ' '));
  const found = level2.filter((h) => (MATERIALS_HEADINGS as readonly string[]).includes(h));
  const countOf = (h: string) => found.filter((f) => f === h).length;
  for (const h of MATERIALS_HEADINGS) {
    const n = countOf(h);
    if (n === 0) problems.push(`見出し「${h}」がありません`);
    else if (n > 1) problems.push(`見出し「${h}」が ${n} 回あります（1 回だけにしてください）`);
  }
  if (MATERIALS_HEADINGS.every((h) => countOf(h) === 1) && found.some((h, i) => h !== MATERIALS_HEADINGS[i])) {
    problems.push(`見出しの順が違います（${MATERIALS_HEADINGS.join(' → ')} の順にしてください）`);
  }
  for (const h of headings) {
    if (FORBIDDEN_HEADING.test(h)) problems.push(`推奨・結論の見出し「${h}」は書かないでください（どれにするかは会議で人が決めます）`);
  }
  return problems;
}

/** GitHub のコメント本文の上限（65536 文字）に、隠し行の分の余裕を残した長さ */
const MAX_MATERIALS = 60_000;

/**
 * Issue に投稿する本文。最後に Run の ID を隠し行で入れ、投稿の再試行で同じ資料を二重に書かないようにする。
 * 長すぎる資料は先に切り詰め、隠し行が切れないようにする
 */
export function materialsCommentBody(markdown: string, runId: string): string {
  return `${markdown.trimEnd().slice(0, MAX_MATERIALS)}\n\n<!-- run: ${runId} -->\n`;
}

/** 同じ Run が投稿した資料コメントか（印付きで、本文に run: <runId> を含む） */
export function isMaterialsCommentOf(body: string, runId: string): boolean {
  return isMaterialsComment(body) && body.includes(`run: ${runId}`);
}

/** Developer の要約から NEEDS_DESIGN_DECISION: の行の中身を取り出す（無ければ null） */
export function designDecisionOf(summary: string): string | null {
  const m = summary.match(NEEDS_DESIGN_DECISION_LINE);
  if (!m) return null;
  return m[1].trim() || '設計の判断が必要です';
}
