/**
 * ALB が渡す JWT（x-amzn-oidc-data）の検証。鍵はテスト内で生成した ES256 の鍵ペアを使う。
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { albPublicKeyFetcher, verifyAlbOidc } from './auth/albOidc';
import { ALB_ARN, EMAIL, NOW, KID, privateKey, fetchKey, pem, signAlbJwt, type SignOpts } from './testing/albJwt';

const opts = { albArn: ALB_ARN, allowedEmail: EMAIL, fetchKey, now: NOW };

describe('verifyAlbOidc', () => {
  it.each<[string, SignOpts, Record<string, unknown>]>([
    ['正しい JWT', {}, { ok: true }],
    ['末尾に = が付いた JWT', { padding: true }, { ok: true }],
    ['= を外した文字列に署名し = 付きで届いた JWT', { padding: true, signStripped: true }, { ok: true }],
    ['署名が違う', { tamper: true }, { ok: false, reason: 'bad_signature' }],
    ['signer が別の ALB', { header: { signer: 'arn:aws:elasticloadbalancing:ap-northeast-1:1:loadbalancer/app/other/x' } }, { ok: false, reason: 'wrong_signer' }],
    ['期限切れ', { header: { exp: NOW / 1000 - 1 } }, { ok: false, reason: 'expired' }],
    ['別のメール', { payload: { email: 'someone@fenrir.co.jp' } }, { ok: false, reason: 'not_allowed' }],
    ['大文字のメール', { payload: { email: 'T.Arai@Fenrir.co.jp' } }, { ok: true }],
    ['未確認のメール', { payload: { email_verified: false } }, { ok: false, reason: 'unverified_email' }],
    ['alg が ES256 でない', { header: { alg: 'HS256' } }, { ok: false, reason: 'malformed' }],
  ])('%s', async (_name, o, expected) => {
    const r = await verifyAlbOidc(signAlbJwt(privateKey, o), opts);
    expect(r).toMatchObject(expected);
    if (r.ok) expect(r.identity).toEqual({ email: EMAIL, name: 'Arai' });
  });

  it('別の鍵で署名した JWT は bad_signature', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(await verifyAlbOidc(signAlbJwt(other), opts)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('name が無ければ null', async () => {
    const r = await verifyAlbOidc(signAlbJwt(privateKey, { payload: { name: undefined } }), opts);
    expect(r).toEqual({ ok: true, identity: { email: EMAIL, name: null } });
  });

  it('ヘッダーが無ければ missing', async () => {
    expect(await verifyAlbOidc(undefined, opts)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyAlbOidc('', opts)).toEqual({ ok: false, reason: 'missing' });
  });

  it('3 つに分かれない文字列は malformed', async () => {
    expect(await verifyAlbOidc('a.b', opts)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyAlbOidc('a.b.c.d', opts)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('鍵の取得に失敗したら key_unavailable で、例外を投げない', async () => {
    const r = await verifyAlbOidc(signAlbJwt(privateKey), {
      ...opts,
      fetchKey: async () => {
        throw new Error('network');
      },
    });
    expect(r).toEqual({ ok: false, reason: 'key_unavailable' });
  });
});

describe('albPublicKeyFetcher', () => {
  it('同じ kid を 2 回目は取りに行かず、不正な kid を拒む', async () => {
    const fetchImpl = vi.fn(async () => new Response(pem, { status: 200 }));
    const f = albPublicKeyFetcher('ap-northeast-1', fetchImpl as unknown as typeof fetch);
    expect(await f(KID)).toBe(pem);
    expect(await f(KID)).toBe(pem);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`https://public-keys.auth.elb.ap-northeast-1.amazonaws.com/${KID}`, { signal: expect.any(AbortSignal) });
    await expect(f('../etc/passwd')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('取得に失敗したらキャッシュせず例外を投げる', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 404 }));
    const f = albPublicKeyFetcher('ap-northeast-1', fetchImpl as unknown as typeof fetch);
    await expect(f(KID)).rejects.toThrow();
    await expect(f(KID)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('PEM として読めない 200 応答はキャッシュせず例外を投げる', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>not a key</html>', { status: 200 }));
    const f = albPublicKeyFetcher('ap-northeast-1', fetchImpl as unknown as typeof fetch);
    await expect(f(KID)).rejects.toThrow();
    await expect(f(KID)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
