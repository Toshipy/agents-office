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
import { LOOKS, LOOK_IDS, useLook } from '../shared/look';

(window as unknown as { __PAW_DEMO__: boolean }).__PAW_DEMO__ = true;
installMockBackend();

function DemoIntro() {
  const [open, setOpen] = useState(true);
  const id = useLook((s) => s.id);
  const setLook = useLook((s) => s.setLook);
  if (!open) {
    return (
      <button className="demo-reopen" onClick={() => setOpen(true)}>
        デザイン案 {LOOKS[id].label}
      </button>
    );
  }
  return (
    <aside className="demo-intro" aria-label="デザイン案">
      <header>
        <strong>デザイン案を切り替えて比較</strong>
        <button className="icon-btn" aria-label="閉じる" onClick={() => setOpen(false)}>
          ×
        </button>
      </header>
      <div className="demo-looks">
        {LOOK_IDS.map((l) => (
          <button key={l} className={`demo-look${id === l ? ' on' : ''}`} onClick={() => setLook(l)}>
            <span className="dl-label">{LOOKS[l].label}</span>
            <span className="dl-name">{LOOKS[l].name}</span>
            <span className="dl-tag">{LOOKS[l].tagline}</span>
          </button>
        ))}
      </div>
      <p className="demo-note">
        このページはブラウザだけで動くデモです。AI の実行と GitHub はシミュレーションで、数秒ごとに Run が進み、Issue が届きます。島やキャラクターをクリックすると詳細が見られます。
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
