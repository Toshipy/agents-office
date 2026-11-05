/** ポーリング時間帯（平日の勤務時間だけ）の判定の検証 */
import { describe, expect, it } from 'vitest';
import { inPollWindow, parsePollWindow } from './github/pollWindow';

const W = parsePollWindow('Mon-Fri 09:00-19:00 Asia/Tokyo');

describe('inPollWindow', () => {
  it.each([
    ['2026-11-09T00:00:00Z', true], // 月 9:00 JST（開始を含む）
    ['2026-11-08T23:59:00Z', false], // 月 8:59 JST
    ['2026-11-09T09:59:00Z', true], // 月 18:59 JST
    ['2026-11-09T10:00:00Z', false], // 月 19:00 JST（終了を含まない）
    ['2026-11-14T03:00:00Z', false], // 土 12:00 JST
    ['2026-11-13T03:00:00Z', true], // 金 12:00 JST
  ])('%s → %s', (iso, expected) => {
    expect(inPollWindow(new Date(iso), W)).toBe(expected);
  });

  it('always は常に true', () => {
    expect(parsePollWindow('always')).toBe('always');
    expect(inPollWindow(new Date('2026-11-14T03:00:00Z'), 'always')).toBe(true);
  });
});

describe('parsePollWindow', () => {
  it('未設定なら既定（平日 9〜19 時 JST）', () => {
    expect(parsePollWindow(undefined)).toEqual({ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1140, timeZone: 'Asia/Tokyo' });
  });
  it('曜日の列挙を読める', () => {
    expect(parsePollWindow('Mon,Wed 10:00-12:30 Asia/Tokyo')).toMatchObject({ days: [1, 3], startMinute: 600, endMinute: 750 });
  });
  it.each(['nonsense', 'Mon-Fri 19:00-09:00 Asia/Tokyo', 'Foo-Bar 09:00-19:00 Asia/Tokyo', 'Mon-Fri 09:00-19:00 Not/AZone', 'Mon-Fri 25:00-26:00 Asia/Tokyo'])('不正な書式は例外: %s', (v) => {
    expect(() => parsePollWindow(v)).toThrow();
  });
});
