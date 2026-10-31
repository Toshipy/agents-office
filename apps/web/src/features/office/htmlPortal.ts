import { createContext, useContext, type RefObject } from 'react';

/**
 * drei <Html> の描画先。Canvas の親要素ではなく専用のオーバーレイに出すことで、
 * Office 画面を離れるときのアンマウント順序による removeChild エラーを防ぐ。
 */
export const HtmlPortalContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function useHtmlPortal() {
  return useContext(HtmlPortalContext) ?? undefined;
}
