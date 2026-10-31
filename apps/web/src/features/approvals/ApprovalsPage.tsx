/**
 * Approvals（UI-05 / FR-016）: 承認待ちの統一表示。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ApprovalDto } from '../../shared/api/client';
import { Icon } from '../../shared/ui/Icon';
import { ApprovalCard } from './ApprovalCard';

export function ApprovalsPage() {
  const [scope, setScope] = useState<'pending' | 'all'>('pending');
  const q = useQuery({ queryKey: ['approvals', scope], queryFn: () => api.get<{ items: ApprovalDto[] }>(`/v1/approvals?status=${scope}`) });
  const items = q.data?.items ?? [];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>承認</h1>
          <p className="muted">AI が人の判断を求めている項目。承認は内容ハッシュ・版数・期限をサーバー側で検証します。</p>
        </div>
        <div className="seg">
          <button className={scope === 'pending' ? 'on' : ''} onClick={() => setScope('pending')}>
            承認待ち
          </button>
          <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
            履歴を含む
          </button>
        </div>
      </header>
      <div className="approval-list">
        {items.map((a) => (
          <ApprovalCard key={a.id} approval={a} />
        ))}
        {!q.isLoading && items.length === 0 ? (
          <div className="empty-state">
            <Icon name="check-circle" size={28} />
            <h2>承認待ちはありません</h2>
            <p className="muted">AI が Draft PR を作成したり、危険な操作を検知すると、ここに表示されます。</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
