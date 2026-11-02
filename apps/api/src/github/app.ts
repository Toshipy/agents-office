/**
 * GitHub App 連携（ADR-012 / 基本設計書 10.2）。
 *  - App の秘密鍵で RS256 の JWT を作り、Installation token（約 1 時間有効）を必要時に発行してメモリでだけ使う
 *  - 個人アクセストークンは使わない・保存しない
 *  - Claude Code（Runner）には GitHub のトークンを渡さない。push と PR 作成は API プロセス（Tool Broker の判定後）が行う
 */
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { log } from '../lib/logger';

export interface GithubAppConfig {
  appId: string;
  privateKeyPem: string;
  /** 既定 https://api.github.com（テストではモックサーバー） */
  apiUrl: string;
  /** Issue からの起動・レビューを受け付ける GitHub ユーザー（小文字） */
  allowedUsers: string[];
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(message);
  }
}

export interface GithubRepoInfo {
  id: number;
  fullName: string;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
}

export interface GithubPullRequest {
  number: number;
  htmlUrl: string;
  headSha: string;
  draft: boolean;
}

export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
}

export interface GithubComment {
  id: number;
  body: string;
  user: string;
  userType: 'User' | 'Bot';
  createdAt: string;
}

export interface GithubReview {
  id: number;
  state: string;
  body: string;
  user: string;
  commitId: string;
}

interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  labels?: (string | { name?: string })[];
  assignees?: { login: string }[];
  updated_at: string;
  pull_request?: unknown;
}

const toIssue = (i: RawIssue): GithubIssue => ({
  number: i.number,
  title: i.title,
  body: i.body ?? '',
  htmlUrl: i.html_url,
  labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
  assignees: (i.assignees ?? []).map((a) => a.login),
  updatedAt: i.updated_at,
});

const toPull = (r: { number: number; html_url: string; draft?: boolean; head: { sha: string } }): GithubPullRequest => ({
  number: r.number,
  htmlUrl: r.html_url,
  headSha: r.head.sha,
  draft: r.draft === true,
});

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class GithubApp {
  private readonly key: KeyObject;
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    readonly cfg: GithubAppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.key = createPrivateKey(cfg.privateKeyPem);
  }

  isAllowedUser(login: unknown): boolean {
    return typeof login === 'string' && this.cfg.allowedUsers.includes(login.toLowerCase());
  }

  /** App 自身の認証用 JWT（有効 9 分。時計のずれを考慮して iat を 60 秒戻す） */
  appJwt(now = Math.floor(Date.now() / 1000)): string {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.cfg.appId }));
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(this.key);
    return `${header}.${payload}.${b64url(signature)}`;
  }

  private async request<T>(method: string, path: string, auth: { app: true } | { installationId: number }, body?: unknown): Promise<T> {
    const token = 'app' in auth ? this.appJwt() : await this.installationToken(auth.installationId);
    const res = await this.fetchImpl(`${this.cfg.apiUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'personal-ai-workspace',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
        detail = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join(' / ') || detail;
      } catch {
        // JSON 以外の応答はそのまま
      }
      // トークンや本文はログに出さない
      log.warn('github api error', { method, path: path.replace(/\?.*$/, ''), status: res.status });
      throw new GithubApiError(`GitHub API ${method} ${path.replace(/\?.*$/, '')} が ${res.status} を返しました: ${detail}`, res.status, detail);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Installation token（期限の 5 分前までキャッシュ） */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const r = await this.request<{ token: string; expires_at: string }>('POST', `/app/installations/${installationId}/access_tokens`, { app: true }, {});
    const expiresAt = Date.parse(r.expires_at);
    this.tokens.set(installationId, { token: r.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 50 * 60_000 });
    return r.token;
  }

  /** リポジトリに App がインストールされているか（されていなければ 404） */
  async findRepoInstallation(owner: string, repo: string): Promise<{ id: number; account: string }> {
    const r = await this.request<{ id: number; account?: { login?: string } }>('GET', `/repos/${enc(owner)}/${enc(repo)}/installation`, { app: true });
    return { id: r.id, account: r.account?.login ?? owner };
  }

  async getRepo(installationId: number, owner: string, repo: string): Promise<GithubRepoInfo> {
    const r = await this.request<{ id: number; full_name: string; default_branch: string; clone_url: string; html_url: string; private: boolean }>(
      'GET',
      `/repos/${enc(owner)}/${enc(repo)}`,
      { installationId },
    );
    return { id: r.id, fullName: r.full_name, defaultBranch: r.default_branch, cloneUrl: r.clone_url, htmlUrl: r.html_url, private: r.private };
  }

  /** App がインストールされているアカウントと、アクセスできるリポジトリ（画面の候補表示用） */
  async listInstallations(): Promise<{ id: number; account: string; repositories: { id: number; fullName: string; private: boolean }[] }[]> {
    const installs = await this.request<{ id: number; account?: { login?: string } }[]>('GET', '/app/installations?per_page=100', { app: true });
    const out = [];
    for (const i of installs) {
      const repos = await this.request<{ repositories: { id: number; full_name: string; private: boolean }[] }>(
        'GET',
        '/installation/repositories?per_page=100',
        { installationId: i.id },
      );
      out.push({ id: i.id, account: i.account?.login ?? '', repositories: repos.repositories.map((r) => ({ id: r.id, fullName: r.full_name, private: r.private })) });
    }
    return out;
  }

  /** 一覧 API を per_page=100 で、空の配列が返るまでページを進めて集める */
  private async paginate<T>(path: string, installationId: number): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const items = await this.request<T[]>('GET', `${path}${sep}per_page=100&page=${page}`, { installationId });
      if (!Array.isArray(items) || items.length === 0) return out;
      out.push(...items);
    }
  }

  private repoPath(fullName: string): string {
    const [owner, repo] = fullName.split('/');
    return `/repos/${enc(owner)}/${enc(repo)}`;
  }

  /** Issues API は PR も返すので、pull_request を持つものは除く */
  async listOpenIssues(installationId: number, fullName: string): Promise<GithubIssue[]> {
    const raw = await this.paginate<RawIssue>(`${this.repoPath(fullName)}/issues?state=open`, installationId);
    return raw.filter((i) => !i.pull_request).map(toIssue);
  }

  async listIssuesWithLabel(installationId: number, fullName: string, label: string): Promise<GithubIssue[]> {
    const raw = await this.paginate<RawIssue>(`${this.repoPath(fullName)}/issues?state=open&labels=${enc(label)}`, installationId);
    return raw.filter((i) => !i.pull_request).map(toIssue);
  }

  async getIssue(installationId: number, fullName: string, number: number): Promise<GithubIssue> {
    return toIssue(await this.request<RawIssue>('GET', `${this.repoPath(fullName)}/issues/${number}`, { installationId }));
  }

  async listIssueComments(installationId: number, fullName: string, number: number): Promise<GithubComment[]> {
    const raw = await this.paginate<{ id: number; body?: string | null; user?: { login: string; type?: string } | null; created_at: string }>(
      `${this.repoPath(fullName)}/issues/${number}/comments`,
      installationId,
    );
    return raw.map((c) => ({ id: c.id, body: c.body ?? '', user: c.user?.login ?? '', userType: c.user?.type === 'Bot' ? 'Bot' : 'User', createdAt: c.created_at }));
  }

  /** そのラベルを最後に付けた人と時刻（events API の最新の labeled）。無ければ null */
  async lastLabeled(installationId: number, fullName: string, number: number, label: string): Promise<{ login: string; at: string } | null> {
    const events = await this.paginate<{ event: string; label?: { name?: string }; actor?: { login?: string } | null; created_at: string }>(
      `${this.repoPath(fullName)}/issues/${number}/events`,
      installationId,
    );
    let last: { login: string; at: string } | null = null;
    for (const e of events) {
      if (e.event !== 'labeled' || e.label?.name !== label || !e.actor?.login) continue;
      // 返却順に依らず、created_at が最も新しいものを採る
      if (!last || Date.parse(e.created_at) >= Date.parse(last.at)) last = { login: e.actor.login, at: e.created_at };
    }
    return last;
  }

  async addLabels(installationId: number, fullName: string, number: number, labels: string[]): Promise<void> {
    await this.request('POST', `${this.repoPath(fullName)}/issues/${number}/labels`, { installationId }, { labels });
  }

  /** 既に無いラベル（404）は成功とみなす */
  async removeLabel(installationId: number, fullName: string, number: number, label: string): Promise<void> {
    try {
      await this.request('DELETE', `${this.repoPath(fullName)}/issues/${number}/labels/${enc(label)}`, { installationId });
    } catch (e) {
      if (e instanceof GithubApiError && e.status === 404) return;
      throw e;
    }
  }

  async addAssignees(installationId: number, fullName: string, number: number, logins: string[]): Promise<void> {
    await this.request('POST', `${this.repoPath(fullName)}/issues/${number}/assignees`, { installationId }, { assignees: logins });
  }

  async removeAssignees(installationId: number, fullName: string, number: number, logins: string[]): Promise<void> {
    await this.request('DELETE', `${this.repoPath(fullName)}/issues/${number}/assignees`, { installationId }, { assignees: logins });
  }

  /** head は同じリポジトリのブランチ（`<owner>:<branch>`）で絞る */
  async findOpenPullByHead(installationId: number, fullName: string, branch: string): Promise<GithubPullRequest | null> {
    const [owner] = fullName.split('/');
    const list = await this.request<{ number: number; html_url: string; draft?: boolean; head: { sha: string } }[]>(
      'GET',
      `${this.repoPath(fullName)}/pulls?state=open&head=${enc(`${owner}:${branch}`)}`,
      { installationId },
    );
    return list.length > 0 ? toPull(list[0]) : null;
  }

  async createPullRequest(
    installationId: number,
    fullName: string,
    pr: { title: string; head: string; base: string; body: string },
  ): Promise<GithubPullRequest> {
    const r = await this.request<{ number: number; html_url: string; draft?: boolean; head: { sha: string } }>(
      'POST',
      `${this.repoPath(fullName)}/pulls`,
      { installationId },
      { ...pr, draft: false, maintainer_can_modify: false },
    );
    return toPull(r);
  }

  async getPull(installationId: number, fullName: string, number: number): Promise<{ state: 'open' | 'closed'; merged: boolean; headSha: string }> {
    const r = await this.request<{ state: string; merged?: boolean; head: { sha: string } }>('GET', `${this.repoPath(fullName)}/pulls/${number}`, { installationId });
    return { state: r.state === 'open' ? 'open' : 'closed', merged: r.merged === true, headSha: r.head.sha };
  }

  async listReviews(installationId: number, fullName: string, number: number): Promise<GithubReview[]> {
    const raw = await this.paginate<{ id: number; state: string; body?: string | null; user?: { login: string } | null; commit_id: string }>(
      `${this.repoPath(fullName)}/pulls/${number}/reviews`,
      installationId,
    );
    return raw.map((r) => ({ id: r.id, state: r.state, body: r.body ?? '', user: r.user?.login ?? '', commitId: r.commit_id }));
  }

  async commentOnIssue(installationId: number, fullName: string, issueNumber: number, body: string) {
    const [owner, repo] = fullName.split('/');
    await this.request('POST', `/repos/${enc(owner)}/${enc(repo)}/issues/${issueNumber}/comments`, { installationId }, { body });
  }
}

const enc = (s: string) => encodeURIComponent(s);
