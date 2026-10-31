import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256';

describe('sha256Hex', () => {
  it('matches node:crypto for various inputs', () => {
    for (const s of ['', 'abc', 'ローカル版シミュレーション', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'w'.repeat(1000)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
    }
  });
});
