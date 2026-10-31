/**
 * 成果物ビューア。HTML を直接挿入せず React 要素として描画する（XSS 対策）。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Icon } from './Icon';
import { relTime } from './format';

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) out.push(<code key={`${keyBase}-${i++}`}>{tok.slice(1, -1)}</code>);
    else out.push(<strong key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++} className="md-code">{body.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const Tag = (`h${Math.min(level + 1, 5)}`) as 'h2';
      blocks.push(<Tag key={k++} className={`md-h md-h${level}`}>{inline(h[2], `h${k}`)}</Tag>);
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(
        <blockquote key={k++} className="md-quote">
          {body.map((b, j) => (
            <p key={j}>{inline(b, `q${k}-${j}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...rest] = rows;
      blocks.push(
        <table key={k++} className="md-table">
          <thead>
            <tr>{head?.map((c, j) => <th key={j}>{inline(c, `th${j}`)}</th>)}</tr>
          </thead>
          <tbody>
            {rest.map((r, ri) => (
              <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `td${ri}-${j}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (/^\s*-\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*-\s/, ''));
      blocks.push(
        <ul key={k++} className="md-list">
          {items.map((it, j) => {
            const task = /^\[( |x)\]\s(.*)$/.exec(it);
            return (
              <li key={j} className={task ? 'md-task' : undefined}>
                {task ? <span className={`md-box${task[1] === 'x' ? ' done' : ''}`} aria-hidden /> : null}
                {inline(task ? task[2] : it, `li${k}-${j}`)}
              </li>
            );
          })}
        </ul>,
      );
      continue;
    }
    if (line.trim() === '---') {
      blocks.push(<hr key={k++} />);
      i++;
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    blocks.push(<p key={k++}>{inline(line, `p${k}`)}</p>);
    i++;
  }
  return <div className="md">{blocks}</div>;
}

export function DiffView({ source }: { source: string }) {
  return (
    <pre className="diff">
      {source.split('\n').map((l, i) => {
        const cls = l.startsWith('diff --git')
          ? 'd-file'
          : l.startsWith('+++') || l.startsWith('---')
            ? 'd-meta'
            : l.startsWith('@@')
              ? 'd-hunk'
              : l.startsWith('+')
                ? 'd-add'
                : l.startsWith('-')
                  ? 'd-del'
                  : l.startsWith('#')
                    ? 'd-comment'
                    : '';
        return (
          <span key={i} className={`d-line ${cls}`}>
            {l || ' '}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

interface ArtifactContent {
  id: string;
  kind: string;
  title: string;
  mediaType: string;
  checksum: string;
  createdAt: string;
  content: string;
}

export function ArtifactBody({ artifactId }: { artifactId: string }) {
  const q = useQuery({ queryKey: ['artifact', artifactId], queryFn: () => api.get<ArtifactContent>(`/v1/artifacts/${artifactId}`) });
  if (q.isLoading) return <div className="muted pad">読み込み中…</div>;
  if (q.error || !q.data) return <div className="error-text pad">成果物を取得できませんでした</div>;
  const a = q.data;
  return (
    <div className="artifact-body">
      <div className="artifact-meta">
        <span className="mono">{a.mediaType}</span>
        <span className="mono" title={a.checksum}>{a.checksum.slice(0, 19)}…</span>
        <span>{relTime(a.createdAt)}</span>
      </div>
      {a.mediaType === 'text/markdown' ? (
        <Markdown source={a.content} />
      ) : a.mediaType === 'text/x-diff' ? (
        <DiffView source={a.content} />
      ) : (
        <pre className="json">{a.content}</pre>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose(): void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" tabIndex={-1} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="閉じる" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );
}

const KIND_ICON: Record<string, string> = {
  plan: 'map',
  diff: 'diff',
  test_report: 'flask',
  review: 'search',
  draft_pr: 'git-pr',
  log: 'terminal',
};

export function artifactIcon(kind: string) {
  return KIND_ICON[kind] ?? 'file';
}
