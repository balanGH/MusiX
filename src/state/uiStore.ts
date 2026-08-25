/**
 * Transient UI state: toasts, panels, and the confirmation dialog.
 *
 * Nothing here is persisted — it is all "what is open right now".
 *
 * The confirmation dialog is a store rather than a component prop because spec
 * §11 requires *every* destructive action to be previewed and confirmed, and
 * those actions are triggered from a dozen different places. One dialog, one
 * code path, no chance of a delete slipping through unconfirmed.
 */

import { create } from 'zustand';
import { uid } from '@core/utils';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  /** Optional single action, e.g. "Undo" or "Try again". */
  action?: { label: string; run(): void };
  /** Milliseconds; errors stay until dismissed. */
  durationMs: number;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  /** Extra lines shown as a preview of exactly what will change (spec §11–12). */
  preview?: string[];
  confirmLabel: string;
  destructive: boolean;
  resolve(confirmed: boolean): void;
}

export interface UiState {
  toasts: Toast[];
  /** The full-screen Now Playing view. */
  nowPlayingOpen: boolean;
  queueOpen: boolean;
  mobileNavOpen: boolean;
  confirm: ConfirmRequest | null;
  /** Tracks awaiting a playlist choice; null when the picker is closed. */
  addToPlaylistFor: string[] | null;

  toast(message: string, options?: { kind?: ToastKind; action?: Toast['action']; durationMs?: number }): string;
  dismissToast(id: string): void;
  setNowPlaying(open: boolean): void;
  setQueueOpen(open: boolean): void;
  setMobileNavOpen(open: boolean): void;
  requestConfirm(request: Omit<ConfirmRequest, 'resolve'>): Promise<boolean>;
  resolveConfirm(confirmed: boolean): void;
  openAddToPlaylist(trackIds: readonly string[]): void;
  closeAddToPlaylist(): void;
}

const DEFAULT_DURATION: Record<ToastKind, number> = {
  info: 4000,
  success: 3000,
  warn: 6000,
  // Errors do not auto-dismiss: spec §34 wants the user to see what failed and
  // be offered a way forward, which they cannot do if it vanishes.
  error: 0,
};

export const useUi = create<UiState>()((set, get) => ({
  toasts: [],
  nowPlayingOpen: false,
  queueOpen: false,
  mobileNavOpen: false,
  confirm: null,
  addToPlaylistFor: null,

  toast(message, options = {}) {
    const kind = options.kind ?? 'info';
    const id = uid('t');
    const toast: Toast = {
      id,
      kind,
      message,
      ...(options.action ? { action: options.action } : {}),
      durationMs: options.durationMs ?? DEFAULT_DURATION[kind],
    };
    // Cap the stack: a failing batch operation could otherwise fill the screen.
    set((state) => ({ toasts: [...state.toasts.slice(-4), toast] }));

    if (toast.durationMs > 0) {
      setTimeout(() => get().dismissToast(id), toast.durationMs);
    }
    return id;
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  setNowPlaying(open) {
    set({ nowPlayingOpen: open, ...(open ? { queueOpen: false } : {}) });
  },

  setQueueOpen(open) {
    set({ queueOpen: open });
  },

  setMobileNavOpen(open) {
    set({ mobileNavOpen: open });
  },

  requestConfirm(request) {
    // Any dialog already open is answered "no" rather than left dangling.
    const existing = get().confirm;
    if (existing) existing.resolve(false);

    return new Promise<boolean>((resolve) => {
      set({ confirm: { ...request, resolve } });
    });
  },

  resolveConfirm(confirmed) {
    const request = get().confirm;
    set({ confirm: null });
    request?.resolve(confirmed);
  },

  openAddToPlaylist(trackIds) {
    if (trackIds.length === 0) return;
    set({ addToPlaylistFor: [...trackIds] });
  },

  closeAddToPlaylist() {
    set({ addToPlaylistFor: null });
  },
}));

/** Convenience for use outside components. */
export const toast = (
  message: string,
  options?: Parameters<UiState['toast']>[1],
): string => useUi.getState().toast(message, options);

export const confirmAction = (request: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> =>
  useUi.getState().requestConfirm(request);
