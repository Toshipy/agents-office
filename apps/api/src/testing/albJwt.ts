/**
 * ALB 風の JWT（x-amzn-oidc-data）をテスト内で署名するための道具。鍵は ES256（P-256）をその場で生成する。
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export const ALB_ARN = 'arn:aws:elasticloadbalancing:ap-northeast-1:111122223333:loadbalancer/app/agents-office/abc';
export const EMAIL = 't.arai@fenrir.co.jp';
export const NOW = 1_800_000_000_000;
export const KID = '01234567-89ab-cdef-0123-456789abcdef';

export const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
export const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
export const fetchKey = async () => pem;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const pad = (s: string) => s + '='.repeat((4 - (s.length % 4)) % 4);

export interface SignOpts {
  padding?: boolean;
  /** 署名は = を外した文字列に対して作り、送る文字列にだけ = を付ける */
  signStripped?: boolean;
  tamper?: boolean;
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export function signAlbJwt(key: KeyObject, o: SignOpts = {}): string {
  const header = { typ: 'JWT', alg: 'ES256', kid: KID, signer: ALB_ARN, iss: 'https://accounts.google.com', client: 'x', exp: NOW / 1000 + 60, ...o.header };
  const payload = { sub: '1', email: EMAIL, email_verified: true, name: 'Arai', ...o.payload };
  let h = b64(header);
  let p = b64(payload);
  const stripped = `${h}.${p}`;
  if (o.padding) {
    h = pad(h);
    p = pad(p);
  }
  const data = o.signStripped ? stripped : `${h}.${p}`;
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  if (o.tamper) sig[0] ^= 0xff;
  const s = o.padding ? pad(sig.toString('base64url')) : sig.toString('base64url');
  return `${h}.${p}.${s}`;
}

