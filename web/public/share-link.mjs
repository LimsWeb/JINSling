
/**
 * Copy an exact address or one-time link. Pass a visible, readonly text field so
 * manual copying remains possible when the browser blocks both clipboard APIs.
 * Neither path parses the URL, changes its fragment, nor contacts another site.
 */
export async function copyShareText(text, {
  selectionInput,
  navigatorTarget = globalThis.navigator,
  documentTarget = globalThis.document,
} = {}) {
  try {
    if (typeof navigatorTarget?.clipboard?.writeText === 'function') {
      await navigatorTarget.clipboard.writeText(text);
      return 'copied';
    }
  } catch { /* Permission denial can still allow a user-triggered legacy copy. */ }

  if (!selectionInput || typeof selectionInput.select !== 'function') return 'manual';
  const previousFocus = documentTarget?.activeElement;
  selectionInput.value = text;
  selectionInput.readOnly = true;
  try {
    selectionInput.focus({preventScroll: true});
    selectionInput.select();
    selectionInput.setSelectionRange?.(0, text.length);
  } catch { return 'manual'; }

  let copied = false;
  try { copied = documentTarget?.execCommand?.('copy') === true; } catch { /* Keep the field selected. */ }
  if (copied) {
    try { previousFocus?.focus?.({preventScroll: true}); } catch { /* The old control may have been removed. */ }
    return 'copied';
  }
  return 'manual';
}
