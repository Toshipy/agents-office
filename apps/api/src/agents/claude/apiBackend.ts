/**
 * Claude API バックエンド（@anthropic-ai/sdk）。認証は ANTHROPIC_API_KEY 等（従量課金）。
 *
 *  - 計画・レビュー: Messages API の構造化出力（betaZodOutputFormat）
 *  - Developer: Messages API のツール呼び出しループ。ツールは自前で実装し、すべて Tool Broker の判定と
 *    worktree 内へのパス制限（confine）を通す
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { StepExecutionContext } from '../runner';
import { RunnerCrashError, RunnerError } from '../runner';
import { confine, grep, listFiles } from './git';
import { STRUCTURED_LABEL, type DevelopRequest, type ModelBackend, type StructuredRequest } from './shared';

/** Anthropic の公開価格（USD / 1M tokens）。費用表示は API が返したトークン数（実測）× この単価 */
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_DEV_TURNS = 30;
const MAX_READ_BYTES = 200 * 1024;

/** 依存注入用（テストでは偽のクライアントを渡す） */
export interface ClaudeMessagesClient {
  beta: { messages: Pick<Anthropic['beta']['messages'], 'parse' | 'stream'> };
}

export interface ClaudeApiOptions {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  client?: ClaudeMessagesClient;
}

const PathInput = z.object({ path: z.string() });
const PrefixInput = z.object({ path_prefix: z.string() });
const SearchInput = z.object({ query: z.string().min(1) });
const WriteInput = z.object({ path: z.string(), content: z.string() });
const EditInput = z.object({ path: z.string(), old_text: z.string().min(1), new_text: z.string() });

const DEV_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'list_files',
    description: 'リポジトリ内のファイル一覧を返す。path_prefix で絞り込める（空文字で全体）。最大 500 件。',
    eager_input_streaming: true,
    input_schema: { type: 'object', properties: { path_prefix: { type: 'string' } }, required: ['path_prefix'], additionalProperties: false },
  },
  {
    name: 'read_file',
    description: 'リポジトリ内のテキストファイルを読む（リポジトリルートからの相対パス）。200KB まで。',
    eager_input_streaming: true,
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'search_code',
    description: 'リポジトリ内を固定文字列で検索し、ファイル名:行番号:内容 を返す（最大 200 行）。',
    eager_input_streaming: true,
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'write_file',
    description: 'ファイルを作成または全体を上書きする（相対パス）。既存ファイルの一部変更には edit_file を使う。',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description: 'ファイル内の old_text（ファイル中にちょうど 1 回だけ現れる文字列）を new_text に置き換える。',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
];

class RefusalError extends Error {}

function priceFor(model: string) {
  return PRICES[model] ?? PRICES['claude-opus-5-5'];
}

export class ClaudeApiBackend implements ModelBackend {
  readonly runtime = 'claude' as const;
  private clientInstance: ClaudeMessagesClient | null;

  constructor(private readonly opts: ClaudeApiOptions) {
    this.clientInstance = opts.client ?? null;
  }

  get label() {
    return `Claude API（${this.opts.model}）`;
  }

  /** 認証情報は ANTHROPIC_API_KEY 等から SDK が解決する（キーをコードに書かない） */
  private get client(): ClaudeMessagesClient {
    if (!this.clientInstance) {
      try {
        this.clientInstance = new Anthropic();
      } catch (err) {
        throw new RunnerError(`Claude クライアントを初期化できません: ${(err as Error).message.slice(0, 300)}`, 'CLAUDE_SDK_ERROR', false);
      }
    }
    return this.clientInstance;
  }

  /** SDK の失敗を、コードと再試行可否つきの RunnerError に変換する */
  private async guard<T>(ctx: StepExecutionContext, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      // 中止・タイムアウトはエンジン側の扱い（中止 / 上限付き再試行）に任せる
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (err instanceof RunnerError || err instanceof RunnerCrashError) throw err;
      // 再試行しても結果が変わらない失敗は、上限付き再試行に回さず即座に失敗させる
      if (err instanceof RefusalError) throw new RunnerError(err.message, 'MODEL_REFUSAL', false);
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new RunnerError('Claude API の認証に失敗しました（ANTHROPIC_API_KEY を確認してください）', 'CLAUDE_AUTH_ERROR', false);
      }
      if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
        throw new RunnerError(`Claude API がリクエストを拒否しました: ${err.message.slice(0, 300)}`, 'CLAUDE_BAD_REQUEST', false);
      }
      if (err instanceof Anthropic.APIConnectionError) throw new RunnerError(`Claude API に接続できません: ${err.message.slice(0, 200)}`, 'CLAUDE_CONNECTION_ERROR', true);
      if (err instanceof Anthropic.APIError) throw new RunnerError(`Claude API エラー: ${err.message.slice(0, 300)}`, 'CLAUDE_API_ERROR', true);
      // 認証情報が見つからない等、SDK は HTTP 以前に素の Error を投げることがある。再試行しても変わらない
      throw new RunnerError(`Claude SDK エラー: ${String((err as Error)?.message ?? err).slice(0, 300)}`, 'CLAUDE_SDK_ERROR', false);
    }
  }

  private async recordUsage(ctx: StepExecutionContext, response: Anthropic.Beta.BetaMessage, started: number) {
    const u = response.usage;
    const p = priceFor(response.model);
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cost = (u.input_tokens * p.input + u.output_tokens * p.output + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead) / 1_000_000;
    await ctx.usage(response.model, u.input_tokens + cacheWrite + cacheRead, u.output_tokens, Date.now() - started, { costUsd: cost, measurement: 'measured' });
  }

  private checkStop(response: Anthropic.Beta.BetaMessage) {
    if (response.stop_reason === 'refusal') {
      const d = response.stop_details;
      throw new RefusalError(`Claude が応答を拒否しました${d?.category ? `（${d.category}）` : ''}`);
    }
  }

  async structured<T>(ctx: StepExecutionContext, req: StructuredRequest<T>): Promise<{ output: T; model: string }> {
    return this.guard(ctx, async () => {
      const started = Date.now();
      const response = await this.client.beta.messages.parse(
        {
          model: this.opts.model,
          max_tokens: 16000,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort: this.opts.effort, format: betaZodOutputFormat(req.schema as z.ZodType<T>) },
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        },
        { signal: ctx.signal },
      );
      await this.recordUsage(ctx, response, started);
      this.checkStop(response);
      const output = response.parsed_output as T | null;
      if (!output) throw new RunnerError(`${STRUCTURED_LABEL[req.purpose]}の構造化出力を解析できませんでした`, 'CLAUDE_BAD_OUTPUT', true);
      return { output, model: response.model };
    });
  }

  private async runDevTool(ctx: StepExecutionContext, worktree: string, gitDir: string | undefined, name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
    const fail = (content: string) => ({ content, isError: true });
    switch (name) {
      case 'list_files': {
        const p = PrefixInput.safeParse(input);
        if (!p.success) return fail('INVALID_INPUT');
        const decision = await ctx.tool('repo.read', { path: p.data.path_prefix }, `ファイル一覧: ${p.data.path_prefix || '/'}`);
        if (!decision.allowed) return fail(decision.reason);
        const files = (await listFiles(gitDir ? { path: worktree, gitDir } : worktree)).filter((f) => f.startsWith(p.data.path_prefix));
        return { content: files.slice(0, 500).join('\n') + (files.length > 500 ? `\n…（他 ${files.length - 500} 件）` : ''), isError: false };
      }
      case 'read_file': {
        const p = PathInput.safeParse(input);
        if (!p.success) return fail('INVALID_INPUT');
        const c = confine(worktree, p.data.path);
        if (!c.ok) return fail(c.reason);
        const decision = await ctx.tool('repo.read', { path: c.rel }, `読む: ${c.rel}`);
        if (!decision.allowed) return fail(decision.reason);
        if (!existsSync(c.abs) || !statSync(c.abs).isFile()) return fail('ファイルが見つかりません');
        if (statSync(c.abs).size > MAX_READ_BYTES) return fail(`ファイルが大きすぎます（${MAX_READ_BYTES} バイト超）。search_code で必要な箇所を探してください`);
        return { content: await readFile(c.abs, 'utf8'), isError: false };
      }
      case 'search_code': {
        const p = SearchInput.safeParse(input);
        if (!p.success) return fail('INVALID_INPUT');
        const decision = await ctx.tool('repo.read', { query: p.data.query }, `検索: ${p.data.query.slice(0, 60)}`);
        if (!decision.allowed) return fail(decision.reason);
        const lines = (await grep(gitDir ? { path: worktree, gitDir } : worktree, p.data.query)).split('\n').filter(Boolean);
        return { content: lines.slice(0, 200).join('\n') || '（該当なし）', isError: false };
      }
      case 'write_file': {
        const p = WriteInput.safeParse(input);
        if (!p.success) return fail('INVALID_INPUT');
        const c = confine(worktree, p.data.path);
        if (!c.ok) return fail(c.reason);
        const before = existsSync(c.abs) ? (await readFile(c.abs, 'utf8')).split('\n').length : 0;
        const decision = await ctx.tool('worktree.write', { path: c.rel }, `${before ? '上書き' : '作成'}: ${c.rel}（${p.data.content.split('\n').length} 行）`);
        if (!decision.allowed) return fail(decision.reason);
        await mkdir(dirname(c.abs), { recursive: true });
        await writeFile(c.abs, p.data.content, 'utf8');
        return { content: 'OK', isError: false };
      }
      case 'edit_file': {
        const p = EditInput.safeParse(input);
        if (!p.success) return fail('INVALID_INPUT');
        const c = confine(worktree, p.data.path);
        if (!c.ok) return fail(c.reason);
        if (!existsSync(c.abs)) return fail('ファイルが見つかりません');
        const text = await readFile(c.abs, 'utf8');
        const count = text.split(p.data.old_text).length - 1;
        if (count !== 1) return fail(count === 0 ? 'old_text が見つかりません' : `old_text が ${count} 回見つかりました。一意になるよう前後を含めてください`);
        const decision = await ctx.tool('worktree.write', { path: c.rel }, `編集: ${c.rel}`);
        if (!decision.allowed) return fail(decision.reason);
        await writeFile(c.abs, text.replace(p.data.old_text, () => p.data.new_text), 'utf8');
        return { content: 'OK', isError: false };
      }
      default:
        return fail(`未知のツール: ${name}`);
    }
  }

  async develop(ctx: StepExecutionContext, req: DevelopRequest): Promise<{ summary: string }> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: req.user }];
    let jsonRetries = 0;
    for (let turn = 0; turn < MAX_DEV_TURNS; turn++) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      const started = Date.now();
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await this.guard(ctx, () =>
          this.client.beta.messages
            .stream(
              {
                model: this.opts.model,
                max_tokens: 64000,
                betas: [FALLBACK_BETA],
                fallbacks: 'default',
                output_config: { effort: this.opts.effort },
                cache_control: { type: 'ephemeral' },
                system: req.system,
                tools: DEV_TOOLS,
                messages,
              },
              { signal: ctx.signal },
            )
            .finalMessage(),
        );
        jsonRetries = 0;
      } catch (err) {
        // ツール入力の JSON が壊れていた等（SDK エラー）はターンをやり直す。API エラー・中止はそのまま
        if (ctx.signal.aborted || !(err instanceof RunnerError) || err.code !== 'CLAUDE_SDK_ERROR' || jsonRetries++ >= 2) throw err;
        await ctx.log('ツール入力を解析できなかったため、このターンをやり直します', 'error');
        continue;
      }
      await this.recordUsage(ctx, response, started);
      await this.guard(ctx, async () => this.checkStop(response));
      const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) await ctx.log(`Claude: ${text.slice(0, 280)}`);
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) return { summary: text };
      if (response.stop_reason === 'max_tokens') throw new RunnerError('ツール入力が max_tokens で途切れました', 'CLAUDE_BAD_OUTPUT', true);
      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const r = await this.runDevTool(ctx, req.worktree, req.gitDir, tu.name, tu.input);
        if (r.isError) await ctx.log(`ツール ${tu.name} を拒否/失敗: ${r.content.slice(0, 160)}`, 'error');
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, is_error: r.isError || undefined });
      }
      messages.push({ role: 'user', content: results });
    }
    throw new RunnerCrashError(`Developer のターン上限（${MAX_DEV_TURNS}）に達しました`);
  }
}
