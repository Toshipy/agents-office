/**
 * GitHub ポーリングの時間帯。平日の勤務時間だけ GitHub を読み、夜間・休日は API を叩かない。
 * 書式: `Mon-Fri 09:00-19:00 Asia/Tokyo`（曜日は範囲 or 列挙、開始を含み終了を含まない）。`always` で制限なし。
 */
export interface PollWindow {
  /** 0=日〜6=土 */
  days: number[];
  startMinute: number;
  endMinute: number;
  timeZone: string;
}

const DEFAULT_WINDOW = 'Mon-Fri 09:00-19:00 Asia/Tokyo';
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function dayIndex(name: string): number {
  const i = DAY_NAMES.indexOf(name.toLowerCase());
  if (i < 0) throw new Error(`PAW_GITHUB_POLL_WINDOW: 曜日を読めません: ${name}`);
  return i;
}

function parseDays(spec: string): number[] {
  const days = new Set<number>();
  for (const part of spec.split(',')) {
    const range = part.split('-');
    if (range.length === 1) {
      days.add(dayIndex(range[0]));
    } else if (range.length === 2) {
      const from = dayIndex(range[0]);
      const to = dayIndex(range[1]);
      // Sat-Mon のように週をまたぐ範囲も許す
      for (let d = from; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === to) break;
      }
    } else {
      throw new Error(`PAW_GITHUB_POLL_WINDOW: 曜日を読めません: ${part}`);
    }
  }
  return [...days].sort((a, b) => a - b);
}

function parseMinute(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`PAW_GITHUB_POLL_WINDOW: 時刻を読めません: ${s}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`PAW_GITHUB_POLL_WINDOW: 時刻が範囲外です: ${s}`);
  return h * 60 + min;
}

/** 解析できなければ例外（起動時に気づけるようにする） */
export function parsePollWindow(v: string | undefined): PollWindow | 'always' {
  const raw = (v ?? '').trim() || DEFAULT_WINDOW;
  if (raw.toLowerCase() === 'always') return 'always';
  const m = /^(\S+)\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\s+(\S+)$/.exec(raw);
  if (!m) throw new Error(`PAW_GITHUB_POLL_WINDOW の書式が不正です（例: ${DEFAULT_WINDOW}）: ${raw}`);
  const startMinute = parseMinute(m[2]);
  const endMinute = parseMinute(m[3]);
  if (startMinute >= endMinute) throw new Error(`PAW_GITHUB_POLL_WINDOW: 開始は終了より前にしてください: ${raw}`);
  const timeZone = m[4];
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`PAW_GITHUB_POLL_WINDOW: タイムゾーンを読めません: ${timeZone}`);
  }
  return { days: parseDays(m[1]), startMinute, endMinute, timeZone };
}

/** `at` が時間帯の中か。サーバーが UTC でも timeZone で曜日と時刻を出す */
export function inPollWindow(at: Date, w: PollWindow | 'always'): boolean {
  if (w === 'always') return true;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: w.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = DAY_NAMES.indexOf(get('weekday').toLowerCase());
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  return w.days.includes(day) && w.startMinute <= minute && minute < w.endMinute;
}
