// Shared app state and navigation (kept separate to avoid circular imports).
import { icon } from './ui.js';

export const state = { status: null };

export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

export function aiBanner() {
  if (state.status?.ai) return '';
  return `<div class="alert warn" style="margin-bottom:18px">${icon('key')}<div><strong>AI features are not connected.</strong> Uploading, page selection and offline extractive tools work now. Book web research, real summaries, tutoring, OCR and intelligent marking need an Anthropic API key on the server. <a href="#/settings">Setup steps →</a></div></div>`;
}
