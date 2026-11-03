/**
 * Claude Code CLI バックエンド（`claude -p`）。利用者がこの PC でログイン済みの Claude Code を呼び出すため、
 * claude.ai のサブスク（Pro / Max など）でログインしていれば、その利用枠で動く（API キー不要・API 課金なし）。
 *
 * 安全のための構成（すべて公式ドキュメントに記載のオプション）:
 *  - `--restricted`: コマンド実行系ツールと WebFetch を外し、ファイル操作を作業ディレクトリ（= Run の worktree）に限定。
 *    利用者・リポジトリの設定ファイル（hooks・権限・.mcp.json）を読まない（--settings と管理設定のみ）
 *  - `--tools`: 工程ごとに Read / Grep / Glob（+ Developer のみ Edit / Write）だけを渡す。シェルは渡さない
 *  - `--disallowedTools mcp__*` + `--strict-mcp-config`: MCP ツールを使わせない
 *  - `--settings`: hooks 無効・自動メモリ無効・作業ディレクトリ外の読み取り禁止・秘密値/CI 設定等への拒否ルール
 *  - 子プロセスには ANTHROPIC_* などの秘密値を渡さない（API キーがあるとサブスクではなく API 課金になるため）
 *  - init で API キー課金（apiKeySource）を検出したら、既定では実行を止める
 *  - 実行後に変更されたパスを検査し、禁止パスへの変更があれば変更を破棄する（ClaudeRunner 側）
 *
 * 出力は `--output-format stream-json`（1 行 1 JSON）で受け取り、進行状況を工程ログに流す。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, relative } from 'node:path';
import { z } from 'zod';
import type { StepExecutionContext } from '../runner';
import { RunnerError, UsageLimitError } from '../runner';
import { CLAUDE_CODE_DENY_RULES, safeEnv } from './git';
import { STRUCTURED_LABEL, type DevelopRequest, type ModelBackend, type StructuredRequest } from './shared';

export interface ClaudeCodeBackendOptions {
  /** `claude` コマンドのパス（既定: PATH 上の claude） */
  bin: string;
  /** null の場合は CLI の既定モデル */
  model: string | null;
  effort: string | null;
  /** --restricted で起動する（既定 true） */
  restricted: boolean;
  /** API キー課金（ANTHROPIC_API_KEY / apiKeyHelper / Console ログイン）で動く構成を許可するか（既定 false） */
  allowApiBilling: boolean;
  maxTurns: { plan: number; review: number; develop: number };
}

/** 位置引数で渡す短い指示。依頼本文や差分は標準入力で渡す（引数長の上限を避けるため） */
const INSTRUCTION = '標準入力で渡す依頼と資料を読み、システムプロンプトの役割に従って作業してください。';
const API_KEY_SOURCES = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key']);

/**
 * Claude Code 用の環境変数。safeEnv（PATH・HOME など最小限）に、CLI の動作に必要なものだけを足す。
 * ANTHROPIC_API_KEY 等は渡さない（渡すとサブスクより優先され API 課金になる）。
 */
export function claudeCliEnv(): NodeJS.ProcessEnv {
  const env = safeEnv();
  delete env.GIT_TERMINAL_PROMPT;
  const pass = [
    'CLAUDE_CONFIG_DIR',
    // `claude setup-token` で作るサブスク用トークン（利用者が自分で設定している場合のみ）
    'CLAUDE_CODE_OAUTH_TOKEN',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'LOGNAME',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
  ];
  for (const k of pass) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

interface CliResultMessage {
  type: 'result';
  subtype: string;
  is_error: boolean;
  result?: string;
  errors?: string[];
  stop_reason?: string | null;
  api_error_status?: number | null;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>;
  permission_denials?: { tool_name: string }[];
  structured_output?: unknown;
}

interface Invocation {
  purpose: 'plan' | 'review' | 'materials' | 'develop';
  worktree: string;
  system: string;
  stdin: string;
  tools: string[];
  permissionMode: 'dontAsk' | 'acceptEdits';
  maxTurns: number;
  jsonSchema?: Record<string, unknown>;
}

interface StreamState {
  result: CliResultMessage | null;
  model: string | null;
  apiKeySource: string | null;
  billingBlocked: string | null;
  usageLimit: { resetsAt: string | null; creditsRequired: boolean } | null;
  assistantError: string | null;
  refusal: boolean;
}

/**
 * --json-schema に渡すスキーマ。Zod が付ける `$schema`（draft 2020-12 の URL）を、
 * Claude Code 2.1.295 は「no schema with key or ref」として受け付けなかった（利用者の環境で確認）。
 * 使っているキーワード（type / properties / required / items / enum / additionalProperties）は
 * draft-07 と共通なので、`$schema` を外して渡す。
 */
export function cliJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/** rate_limit_event.resetsAt（数値）を ISO 文字列に。秒・ミリ秒のどちらでも受け、ありえない値は捨てる */
export function resetsAtToIso(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  const ms = v < 1e12 ? v * 1000 : v;
  if (ms < Date.now() - 24 * 3600_000 || ms > Date.now() + 40 * 24 * 3600_000) return null;
  return new Date(ms).toISOString();
}

function formatReset(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  return `（リセット予定: ${d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）`;
}

function describeToolInput(worktree: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const rel = (p: unknown) => {
    if (typeof p !== 'string') return '';
    if (!isAbsolute(p)) return p;
    const r = relative(worktree, p);
    return r.startsWith('..') ? p : r || '.';
  };
  const parts = [rel(o.file_path ?? o.path), typeof o.pattern === 'string' ? `「${o.pattern.slice(0, 60)}」` : ''].filter(Boolean);
  return parts.join(' ');
}

export class ClaudeCodeBackend implements ModelBackend {
  readonly runtime = 'claude_code' as const;

  constructor(private readonly opts: ClaudeCodeBackendOptions) {}

  get label() {
    return `Claude Code${this.opts.model ? `（${this.opts.model}）` : ''}`;
  }

  async structured<T>(ctx: StepExecutionContext, req: StructuredRequest<T>): Promise<{ output: T; model: string }> {
    const read = await ctx.tool('repo.read', { scope: 'worktree' }, 'Claude Code に Read / Grep / Glob を許可（作業コピー内・読み取りのみ）');
    const { result, model } = await this.invoke(ctx, {
      purpose: req.purpose,
      worktree: req.worktree,
      system: `${req.system}\nこの工程ではファイルを変更しないでください（読み取りのみ）。結果は指定された JSON スキーマで返してください。`,
      stdin: req.user,
      tools: read.allowed ? ['Read', 'Grep', 'Glob'] : [],
      permissionMode: 'dontAsk',
      // 資料は Planner が書くので、計画と同じターン上限にする
      maxTurns: req.purpose === 'review' ? this.opts.maxTurns.review : this.opts.maxTurns.plan,
      jsonSchema: cliJsonSchema(req.schema),
    });
    const parsed = req.schema.safeParse(result.structured_output);
    if (!parsed.success) {
      throw new RunnerError(`${STRUCTURED_LABEL[req.purpose]}の構造化出力がスキーマに合いません`, 'CLAUDE_BAD_OUTPUT', true);
    }
    return { output: parsed.data, model };
  }

  async develop(ctx: StepExecutionContext, req: DevelopRequest): Promise<{ summary: string }> {
    const read = await ctx.tool('repo.read', { scope: 'worktree' }, 'Claude Code に Read / Grep / Glob を許可（作業コピー内）');
    const write = await ctx.tool('worktree.write', { scope: 'worktree' }, 'Claude Code に Edit / Write を許可（作業コピー内）');
    if (!read.allowed || !write.allowed) throw new RunnerError('ポリシーで Developer のファイル操作が許可されていません', 'POLICY_DENIED', false);
    const { result } = await this.invoke(ctx, {
      purpose: 'develop',
      worktree: req.worktree,
      system: `${req.system}\n作業ディレクトリ（リポジトリの作業コピー）の外のファイルには触れないでください。`,
      stdin: req.user,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
      permissionMode: 'acceptEdits',
      maxTurns: this.opts.maxTurns.develop,
    });
    const denials = result.permission_denials ?? [];
    if (denials.length) await ctx.log(`権限ルールで拒否された操作: ${denials.length} 件（${Array.from(new Set(denials.map((d) => d.tool_name))).join(', ')}）`, 'error');
    return { summary: (result.result ?? '').trim() };
  }

  /* ---------------------------------------------------------------- */

  private args(inv: Invocation): string[] {
    const settings = {
      disableAllHooks: true,
      autoMemoryEnabled: false,
      permissions: { deny: CLAUDE_CODE_DENY_RULES, blockReadsOutsideWorkingDirectories: true },
    };
    return [
      '-p',
      INSTRUCTION,
      // --restricted は利用者・リポジトリの設定を読まない。無効化した場合も、リポジトリ側の設定（hooks・.mcp.json）は読まない
      ...(this.opts.restricted ? ['--restricted'] : ['--setting-sources', 'user']),
      '--tools',
      inv.tools.join(','),
      '--disallowedTools',
      'mcp__*',
      '--strict-mcp-config',
      '--permission-mode',
      inv.permissionMode,
      '--settings',
      JSON.stringify(settings),
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--max-turns',
      String(inv.maxTurns),
      '--append-system-prompt',
      inv.system,
      ...(inv.jsonSchema ? ['--json-schema', JSON.stringify(inv.jsonSchema)] : []),
      ...(this.opts.model ? ['--model', this.opts.model] : []),
      ...(this.opts.effort ? ['--effort', this.opts.effort] : []),
    ];
  }

  private async invoke(ctx: StepExecutionContext, inv: Invocation): Promise<{ result: CliResultMessage; model: string }> {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const started = Date.now();
    const state: StreamState = { result: null, model: null, apiKeySource: null, billingBlocked: null, usageLimit: null, assistantError: null, refusal: false };
    await ctx.log(`Claude Code を起動（${inv.purpose === 'develop' ? 'Edit/Write 可' : '読み取りのみ'}・最大 ${inv.maxTurns} ターン）`);

    const child = spawn(this.opts.bin, this.args(inv), {
      cwd: inv.worktree,
      env: claudeCliEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const done = new Promise<{ code: number | null; error: NodeJS.ErrnoException | null }>((resolve) => {
      child.once('error', (error: NodeJS.ErrnoException) => resolve({ code: null, error }));
      child.once('close', (code) => resolve({ code, error: null }));
    });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-8000);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(inv.stdin);

    const timers: NodeJS.Timeout[] = [];
    const stop = () => {
      // SIGINT で現在のターンを終わらせ、応答がなければ段階的に強制終了する
      child.kill('SIGINT');
      timers.push(setTimeout(() => child.kill('SIGTERM'), 3000), setTimeout(() => child.kill('SIGKILL'), 10_000));
    };
    ctx.signal.addEventListener('abort', stop, { once: true });

    try {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        await this.onMessage(ctx, inv, msg, state);
        if (state.billingBlocked && child.exitCode === null) stop();
      }
      const exit = await done;
      if (exit.error) {
        if (exit.error.code === 'ENOENT') {
          throw new RunnerError(
            `Claude Code CLI（${this.opts.bin}）が見つかりません。Claude Code をインストールして \`claude\` でログインするか、PAW_CLAUDE_CODE_BIN でパスを指定してください`,
            'CLAUDE_CODE_NOT_FOUND',
            false,
          );
        }
        throw new RunnerError(`Claude Code を起動できません: ${exit.error.message.slice(0, 300)}`, 'CLAUDE_CODE_FAILED', false);
      }
      if (ctx.signal.aborted) throw ctx.signal.reason;
      const r = state.result;
      // 失敗した呼び出しでも消費したトークンは記録する（API 課金で動いてしまった場合も含めて）
      if (r) await this.recordUsage(ctx, r, state, started);
      if (state.billingBlocked) {
        throw new RunnerError(
          `Claude Code が API キー（${state.billingBlocked}）で動こうとしたため停止しました。サブスクで使うには \`claude auth login\` で claude.ai アカウントにログインしてください（API 課金を許可する場合は PAW_CLAUDE_CODE_ALLOW_API_BILLING=1）`,
          'CLAUDE_CODE_NOT_SUBSCRIPTION',
          false,
        );
      }
      return { result: this.evaluate(r, state, exit.code, stderr), model: this.modelOf(r, state) };
    } finally {
      ctx.signal.removeEventListener('abort', stop);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      for (const t of timers) clearTimeout(t);
    }
  }

  private async onMessage(ctx: StepExecutionContext, inv: Invocation, msg: Record<string, unknown>, state: StreamState) {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          state.model = typeof msg.model === 'string' ? msg.model : null;
          state.apiKeySource = typeof msg.apiKeySource === 'string' ? msg.apiKeySource : null;
          const billing = state.apiKeySource && API_KEY_SOURCES.has(state.apiKeySource) ? `API キー（${state.apiKeySource}）` : 'ログイン中のアカウント';
          await ctx.log(`Claude Code ${String(msg.claude_code_version ?? '')} · ${state.model ?? '既定モデル'} · 認証: ${billing}`);
          if (state.apiKeySource && API_KEY_SOURCES.has(state.apiKeySource) && !this.opts.allowApiBilling) state.billingBlocked = state.apiKeySource;
        } else if (msg.subtype === 'api_retry') {
          await ctx.log(`Claude への接続を再試行中（${String(msg.attempt ?? '?')}/${String(msg.max_retries ?? '?')}・${String(msg.error ?? 'unknown')}）`, 'error');
        } else if (msg.subtype === 'permission_denied') {
          await ctx.log(`拒否: ${String(msg.tool_name ?? '')} — ${String(msg.message ?? msg.decision_reason ?? '').slice(0, 160)}`, 'error');
        } else if (msg.subtype === 'model_refusal_no_fallback') {
          state.refusal = true;
        }
        return;
      }
      case 'assistant': {
        if (typeof msg.error === 'string') state.assistantError = msg.error;
        const content = ((msg.message as { content?: unknown[] } | undefined)?.content ?? []) as { type: string; text?: string; name?: string; input?: unknown }[];
        for (const b of content) {
          if (b.type === 'text' && b.text?.trim()) await ctx.log(`Claude: ${b.text.trim().slice(0, 280)}`);
          else if (b.type === 'tool_use') await ctx.log(`${b.name ?? 'tool'}: ${describeToolInput(inv.worktree, b.input)}`.trim());
        }
        return;
      }
      case 'rate_limit_event': {
        const info = (msg.rate_limit_info ?? {}) as { status?: string; resetsAt?: unknown; utilization?: unknown; errorCode?: string };
        if (info.status === 'rejected') {
          state.usageLimit = { resetsAt: resetsAtToIso(info.resetsAt), creditsRequired: info.errorCode === 'credits_required' };
        } else if (info.status === 'allowed_warning') {
          const u = typeof info.utilization === 'number' ? Math.round(info.utilization <= 1 ? info.utilization * 100 : info.utilization) : null;
          await ctx.log(`サブスクの利用上限に近づいています${u !== null ? `（使用率 ${u}%）` : ''}${formatReset(resetsAtToIso(info.resetsAt))}`, 'error');
        }
        return;
      }
      case 'result':
        state.result = msg as unknown as CliResultMessage;
        return;
    }
  }

  private modelOf(r: CliResultMessage | null, state: StreamState) {
    const used = Object.keys(r?.modelUsage ?? {});
    return used[0] ?? state.model ?? 'claude-code';
  }

  /** トークン数を記録。サブスク枠（API キー不使用）なら費用は 0 とし、API 換算の目安だけログに出す */
  private async recordUsage(ctx: StepExecutionContext, r: CliResultMessage, state: StreamState, started: number) {
    const apiBilled = Boolean(state.apiKeySource && API_KEY_SOURCES.has(state.apiKeySource));
    const entries = Object.entries(r.modelUsage ?? {});
    if (entries.length === 0) {
      const u = r.usage ?? {};
      entries.push([
        state.model ?? 'claude-code',
        { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadInputTokens: u.cache_read_input_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens, costUSD: r.total_cost_usd },
      ]);
    }
    let first = true;
    for (const [model, mu] of entries) {
      const input = (mu.inputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0);
      const duration = first ? (r.duration_ms ?? Date.now() - started) : 0;
      first = false;
      await ctx.usage(model, input, mu.outputTokens ?? 0, duration, apiBilled ? { costUsd: mu.costUSD ?? 0, measurement: 'estimated' } : { costUsd: 0, measurement: 'subscription' });
    }
    if (!apiBilled && typeof r.total_cost_usd === 'number' && r.total_cost_usd > 0) {
      await ctx.log(`サブスク枠で実行（API 料金に換算した目安 $${r.total_cost_usd.toFixed(3)}・API の請求は発生しません）`);
    }
  }

  /** CLI の終了状態を、コードと再試行可否つきの失敗に分類する */
  private evaluate(r: CliResultMessage | null, state: StreamState, exitCode: number | null, stderr: string): CliResultMessage {
    const text = `${r?.result ?? ''}\n${(r?.errors ?? []).join('\n')}`;
    const failed = r === null || r.is_error || r.subtype !== 'success';
    // 上限の判定は CLI の構造化イベント（rate_limit_event / error: rate_limit / 429）を優先し、
    // 文言での判定は「usage limit」「5-hour limit」等の明確な表現に限る
    const limited =
      failed &&
      (state.usageLimit !== null ||
        state.assistantError === 'rate_limit' ||
        r?.api_error_status === 429 ||
        /usage limit|(5-hour|weekly|session) limit/i.test(text));
    if (limited) {
      const resetsAt = state.usageLimit?.resetsAt ?? null;
      const credits = state.usageLimit?.creditsRequired ? '（含まれる利用量を使い切りました。追加クレジットの購入が必要な状態です）' : '';
      throw new UsageLimitError(`Claude のサブスク利用上限に達しました${credits}${formatReset(resetsAt)}`, resetsAt);
    }
    if (!r) {
      const tail = stderr.trim().slice(-600);
      if (/unknown option|unknown command|unknown argument|error: option|too many arguments|invalid value|is not a valid JSON Schema/i.test(tail)) {
        throw new RunnerError(
          `Claude Code がオプションを受け付けませんでした。バージョンが古い可能性があります（\`claude update\` で更新してください）: ${tail}`,
          'CLAUDE_CODE_CLI_ERROR',
          false,
        );
      }
      throw new RunnerError(`Claude Code が結果を返さずに終了しました（exit ${exitCode ?? '?'}）${tail ? `: ${tail}` : ''}`, 'CLAUDE_CODE_FAILED', true);
    }
    if (state.refusal || r.stop_reason === 'refusal') throw new RunnerError('Claude が応答を拒否しました', 'MODEL_REFUSAL', false);
    if (r.subtype === 'success' && !r.is_error) return r;
    const detail = text.trim().slice(0, 300);
    switch (state.assistantError) {
      case 'authentication_failed':
      case 'oauth_org_not_allowed':
      case 'account_on_hold':
        throw new RunnerError(`Claude Code の認証に失敗しました（\`claude auth login\` でログインしてください）: ${detail}`, 'CLAUDE_AUTH_ERROR', false);
      case 'billing_error':
        throw new RunnerError(`Claude の請求・契約に関するエラーです: ${detail}`, 'CLAUDE_BILLING_ERROR', false);
      case 'model_not_found':
        throw new RunnerError(`指定したモデルを利用できません（PAW_CLAUDE_CODE_MODEL を確認してください）: ${detail}`, 'CLAUDE_MODEL_UNAVAILABLE', false);
      case 'invalid_request':
        throw new RunnerError(`Claude がリクエストを拒否しました: ${detail}`, 'CLAUDE_BAD_REQUEST', false);
    }
    if (/not logged in|please run \/login|\/login|invalid api key|authentication/i.test(text)) {
      throw new RunnerError(`Claude Code にログインしていません（\`claude auth login\` でログインしてください）: ${detail}`, 'CLAUDE_AUTH_ERROR', false);
    }
    if (r.subtype === 'error_max_turns') throw new RunnerError(`Claude Code のターン上限に達しました（${r.num_turns ?? '?'} ターン）`, 'CLAUDE_CODE_MAX_TURNS', false);
    if (r.subtype === 'error_max_structured_output_retries') throw new RunnerError('構造化出力を生成できませんでした', 'CLAUDE_BAD_OUTPUT', true);
    throw new RunnerError(`Claude Code の実行に失敗しました（${r.subtype}）${detail ? `: ${detail}` : ''}`, 'CLAUDE_CODE_FAILED', true);
  }
}
