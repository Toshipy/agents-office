/**
 * テスト用の偽 claude CLI。公式ドキュメント（Agent SDK / headless）の stream-json 形式
 * （system:init / assistant / rate_limit_event / result）を再現する。本物の CLI の出力そのものではない。
 *
 * 同じディレクトリの scenario.json で工程ごとの振る舞いを指定し、呼び出し内容を calls.jsonl に記録する。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FAKE_CLAUDE_CLI = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(join(here, 'scenario.json'), 'utf8'));
if (args[0] === '--version') { console.log(scenario.version ?? '2.1.316 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  const a = scenario.auth ?? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };
  console.log(JSON.stringify(a, null, 2));
  process.exit(a.loggedIn ? 0 : 1);
}
let stdin = '';
for await (const c of process.stdin) stdin += c;
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const schema = opt('--json-schema');
// 実際の Claude Code 2.1.295 は draft 2020-12 の $schema を受け付けなかった（利用者の環境で確認）
if (schema && JSON.parse(schema).$schema) {
  process.stderr.write('Error: --json-schema is not a valid JSON Schema: no schema with key or ref "' + JSON.parse(schema).$schema + '"\n');
  process.exit(1);
}
const purpose = schema ? (schema.includes('verdict') ? 'review' : 'plan') : 'develop';
const countsFile = join(here, 'counts.json');
const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, 'utf8')) : {};
counts[purpose] = (counts[purpose] ?? 0) + 1;
writeFileSync(countsFile, JSON.stringify(counts));
appendFileSync(join(here, 'calls.jsonl'), JSON.stringify({ purpose, args, cwd: process.cwd(), stdin, envKeys: Object.keys(process.env), pid: process.pid }) + '\n');
const list = scenario[purpose] ?? [];
const b = list[counts[purpose] - 1] ?? list[list.length - 1] ?? { kind: 'ok' };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', model: 'claude-test-model', apiKeySource: b.apiKeySource ?? 'none', claude_code_version: '2.1.316', tools: (opt('--tools') ?? '').split(','), cwd: process.cwd(), permissionMode: opt('--permission-mode') });
const modelUsage = { 'claude-test-model': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, costUSD: 0.0123 } };
const result = (extra) => out({ type: 'result', subtype: 'success', is_error: false, result: 'done', duration_ms: 7, num_turns: 2, total_cost_usd: 0.0123, usage: {}, modelUsage, permission_denials: [], ...extra });
// SIGINT を受けても slow_exit_ms だけ生き続けてから終わる（中止が CLI の終了を待つことの検証用）
if (b.kind === 'slow_exit') {
  process.on('SIGINT', () => setTimeout(() => process.exit(130), b.slowExitMs ?? 1000));
  await new Promise((r) => setTimeout(r, 60000));
}
if (b.kind === 'hang') { await new Promise((r) => setTimeout(r, 60000)); }
if (b.kind === 'usage_limit') {
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
  out({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Claude AI usage limit reached' }] } });
  result({ is_error: true, result: 'Claude AI usage limit reached' });
} else if (b.kind === 'auth') {
  out({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] } });
  result({ is_error: true, result: 'Invalid API key · Please run /login' });
} else if (b.kind === 'crash') {
  process.stderr.write('segfault-ish');
  process.exit(3);
} else {
  for (const w of b.writes ?? []) {
    const p = join(process.cwd(), w.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, w.content);
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: p } }] } });
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: b.text ?? '完了しました' }] } });
  result({ structured_output: b.output, result: b.text ?? '完了しました' });
}
`;

export function installFakeClaude(dir: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'claude');
  writeFileSync(bin, FAKE_CLAUDE_CLI);
  chmodSync(bin, 0o755);
  const setScenario = (sc: Record<string, unknown>) => {
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify(sc));
    rmSync(join(dir, 'counts.json'), { force: true });
    rmSync(join(dir, 'calls.jsonl'), { force: true });
  };
  const counts = () => (existsSync(join(dir, 'counts.json')) ? (JSON.parse(readFileSync(join(dir, 'counts.json'), 'utf8')) as Record<string, number>) : {});
  const calls = () =>
    existsSync(join(dir, 'calls.jsonl'))
      ? readFileSync(join(dir, 'calls.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { purpose: string; args: string[]; cwd: string; stdin: string; envKeys: string[]; pid: number })
      : [];
  setScenario({});
  return { bin, setScenario, counts, calls };
}
