/**
 * ALB の OIDC 認証が `x-amzn-oidc-data` に載せる JWT（ES256）の検証。
 * 副作用は公開鍵の取得だけで、取得処理は呼び出し側から注入する。
 */
import { createPublicKey, verify } from 'node:crypto';

export interface AlbIdentity {
  email: string;
  name: string | null;
}

/** kid から PEM の公開鍵を返す */
export type AlbKeyFetcher = (kid: string) => Promise<string>;

export type AlbOidcFailure = 'missing' | 'malformed' | 'bad_signature' | 'wrong_signer' | 'expired' | 'unverified_email' | 'not_allowed' | 'key_unavailable';

export type AlbOidcResult = { ok: true; identity: AlbIdentity } | { ok: false; reason: AlbOidcFailure };

const KID_PATTERN = /^[0-9a-f-]{36}$/i;

/** ALB の公開鍵を取得し、kid ごとにメモリへ置く。失敗はキャッシュしない */
export function albPublicKeyFetcher(region: string, fetchImpl: typeof fetch = fetch): AlbKeyFetcher {
  const cache = new Map<string, string>();
  return async (kid) => {
    // kid は URL の一部になるため、形式が違うものは取りに行かない
    if (!KID_PATTERN.test(kid)) throw new Error('invalid kid');
    const hit = cache.get(kid);
    if (hit) return hit;
    // 応答が返らないと認証の要求ごと止まるため、5 秒で打ち切る
    const res = await fetchImpl(`https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`public key fetch failed: ${res.status}`);
    const pem = await res.text();
    // PEM として読めない 200 応答は、キャッシュせずに失敗として扱う（createPublicKey が例外を投げる）
    createPublicKey(pem);
    cache.set(kid, pem);
    return pem;
  };
}

const stripPad = (s: string) => s.replace(/=+$/, '');

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(stripPad(part), 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function verifyAlbOidc(
  token: string | undefined,
  opts: { albArn: string; allowedEmail: string; fetchKey: AlbKeyFetcher; now?: number },
): Promise<AlbOidcResult> {
  if (!token) return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];

  const header = decodeJson(rawHeader);
  if (!header || header.alg !== 'ES256' || typeof header.kid !== 'string') return { ok: false, reason: 'malformed' };

  let pem: string;
  try {
    pem = await opts.fetchKey(header.kid);
  } catch {
    return { ok: false, reason: 'key_unavailable' };
  }

  // 届いた文字列のまま署名を確かめ、だめなら = を外した文字列でも確かめる
  const sig = Buffer.from(stripPad(rawSig), 'base64url');
  const candidates = [`${rawHeader}.${rawPayload}`, `${stripPad(rawHeader)}.${stripPad(rawPayload)}`];
  let valid = false;
  try {
    valid = candidates.some((data) => verify('sha256', Buffer.from(data), { key: pem, dsaEncoding: 'ieee-p1363' }, sig));
  } catch {
    return { ok: false, reason: 'key_unavailable' };
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  // 署名が正しいことを確かめてから、ヘッダーとペイロードの中身を見る
  if (header.signer !== opts.albArn) return { ok: false, reason: 'wrong_signer' };
  const nowSec = (opts.now ?? Date.now()) / 1000;
  if (typeof header.exp !== 'number' || header.exp <= nowSec) return { ok: false, reason: 'expired' };

  const payload = decodeJson(rawPayload);
  if (!payload || typeof payload.email !== 'string') return { ok: false, reason: 'malformed' };
  if (payload.email_verified === false) return { ok: false, reason: 'unverified_email' };
  const email = payload.email.toLowerCase();
  if (email !== opts.allowedEmail.toLowerCase()) return { ok: false, reason: 'not_allowed' };

  return { ok: true, identity: { email, name: typeof payload.name === 'string' ? payload.name : null } };
}
