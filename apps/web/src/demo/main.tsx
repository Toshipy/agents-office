import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/fraunces';
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/manrope';
import '../styles.css';
import { installMockBackend } from './mockBackend';
import { App } from '../app/App';

(window as unknown as { __PAW_DEMO__: boolean }).__PAW_DEMO__ = true;
installMockBackend();

function DemoIntro() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <aside className="demo-intro compact" aria-label="デモについて">
      <header>
        <strong>ブラウザ内デモ（デザイン B: Neon Control）</strong>
        <button className="icon-btn" aria-label="閉じる" onClick={() => setOpen(false)}>
          ×
        </button>
      </header>
      <p className="demo-note">
        AI の実行と GitHub はブラウザ内のシミュレーションです。数秒ごとに Run が進み、Issue が届きます。島やキャラクターをクリックすると詳細が見られます。ローカル版では ANTHROPIC_API_KEY を設定すると Claude が実際のリポジトリで作業します。
      </p>
    </aside>
  );
}

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 2_000 } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/office']}>
        <App />
        <DemoIntro />
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
