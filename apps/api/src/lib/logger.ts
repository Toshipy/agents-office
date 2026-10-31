/**
 * 構造化ログ。リクエスト本文・トークン・コード本文は出力しない（NFR-007 / 基本設計書 12.3）。
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let threshold: Level | 'silent' = 'info';

export function setLogLevel(level: Level | 'silent') {
  threshold = level;
}

const SECRET_KEYS = /(password|secret|token|authorization|cookie|signature)/i;

function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : v;
  return out;
}

function write(level: Level, msg: string, meta: Record<string, unknown> = {}) {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...redact(meta) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => write('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => write('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => write('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => write('error', m, meta),
};
