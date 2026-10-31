import { useEffect } from 'react';
import { create } from 'zustand';
import { Link } from 'react-router';
import { Icon } from './Icon';

export interface Toast {
  id: number;
  tone: 'info' | 'warn' | 'error' | 'success';
  title: string;
  body?: string;
  href?: string;
}

const useToasts = create<{ items: Toast[]; push(t: Omit<Toast, 'id'>): void; remove(id: number): void }>((set) => ({
  items: [],
  push: (t) => set((s) => ({ items: [...s.items.slice(-3), { ...t, id: Date.now() + Math.random() }] })),
  remove: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

export function toast(t: Omit<Toast, 'id'>) {
  useToasts.getState().push(t);
}

function ToastItem({ t }: { t: Toast }) {
  const remove = useToasts((s) => s.remove);
  useEffect(() => {
    const h = window.setTimeout(() => remove(t.id), 6000);
    return () => window.clearTimeout(h);
  }, [t.id, remove]);
  const icon = t.tone === 'error' ? 'x-circle' : t.tone === 'warn' ? 'alert' : t.tone === 'success' ? 'check-circle' : 'shield';
  const inner = (
    <>
      <span className={`toast-icon tone-${t.tone}`}>
        <Icon name={icon} size={16} />
      </span>
      <span className="toast-text">
        <strong>{t.title}</strong>
        {t.body ? <span>{t.body}</span> : null}
      </span>
    </>
  );
  return (
    <div className={`toast tone-${t.tone}`} role="status">
      {t.href ? (
        <Link to={t.href} className="toast-link" onClick={() => remove(t.id)}>
          {inner}
        </Link>
      ) : (
        <div className="toast-link">{inner}</div>
      )}
      <button className="toast-close" aria-label="閉じる" onClick={() => remove(t.id)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div className="toaster" aria-live="polite">
      {items.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}
