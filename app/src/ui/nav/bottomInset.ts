import { createContext, useContext } from "react";

/**
 * The bottom safe-area inset (home indicator) that a DeskScreen gives to its scroll content.
 * The scroll content adds it as bottom padding, so the last row scrolls clear of the home
 * indicator and the screen shows no empty band below the content. 0 outside a DeskScreen.
 */
export const BottomInsetContext = createContext(0);

export function useBottomInset(): number {
  return useContext(BottomInsetContext);
}
