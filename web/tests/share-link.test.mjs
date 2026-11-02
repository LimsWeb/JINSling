import test from 'node:test';
import assert from 'node:assert/strict';
import * as share from '../public/share-link.mjs';

// The browser clipboard is an external boundary. This fixture records what the
// selected editable field would copy, rather than accepting arbitrary commands.
function fieldHarness({legacy = 'success'} = {}) {
  let clipboard = null;
  const documentTarget = {activeElement: null};
  const previous = {focus() { documentTarget.activeElement = previous; }};
  const selectionInput = {
    value: 'stale address', readOnly: true, selectionStart: 0, selectionEnd: 0,
    focus() { documentTarget.activeElement = this; },
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
  previous.focus();
  if (legacy !== 'missing') documentTarget.execCommand = command => {
    assert.equal(command, 'copy');
    if (legacy === 'throws') throw new Error('copy is blocked');
    if (legacy === 'false') return false;
    if (documentTarget.activeElement !== selectionInput) return false;
    clipboard = selectionInput.value.slice(selectionInput.selectionStart, selectionInput.selectionEnd);
    return true;
  };
  return {documentTarget, selectionInput, previous, get clipboard() { return clipboard; }};
}

async function copy(text, options) {
  assert.equal(typeof share.copyShareText, 'function', 'copying must support clipboard and manual selection');
  return share.copyShareText(text, options);
}

test('native clipboard receives the exact URL including Unicode and invitation fragment', async () => {
  const h = fieldHarness();
  let clipboard;
  const navigatorTarget = {clipboard: {async writeText(value) { clipboard = value; }}};
  const text = 'https://shop.example/예약/#invite=Ab_C-09%2B%3D';
  assert.equal(await copy(text, {...h, navigatorTarget}), 'copied');
  assert.equal(clipboard, 'https://shop.example/예약/#invite=Ab_C-09%2B%3D');
  assert.equal(h.clipboard, null);
  assert.equal(h.documentTarget.activeElement, h.previous);
});

test('missing Clipboard API copies the selected exact URL through the legacy fallback and restores focus', async () => {
  const h = fieldHarness();
  assert.equal(await copy('https://shop.example/#invite=A_b-C', {...h, navigatorTarget: {}}), 'copied');
  assert.equal(h.clipboard, 'https://shop.example/#invite=A_b-C');
  assert.equal(h.documentTarget.activeElement, h.previous);
});

test('Clipboard API permission rejection still attempts copying through the visible field', async () => {
  const h = fieldHarness();
  const navigatorTarget = {clipboard: {async writeText() { throw new Error('permission denied'); }}};
  assert.equal(await copy('https://shop.example/', {...h, navigatorTarget}), 'copied');
  assert.equal(h.clipboard, 'https://shop.example/');
});

test('when both clipboard methods are unavailable the full address stays selected for manual copying', async () => {
  const h = fieldHarness({legacy: 'missing'});
  const text = 'https://shop.example/#invite=Ab_C-09%2B%3D';
  assert.equal(await copy(text, {...h, navigatorTarget: {}}), 'manual');
  assert.equal(h.clipboard, null);
  assert.equal(h.documentTarget.activeElement, h.selectionInput);
  assert.equal(h.selectionInput.value.slice(h.selectionInput.selectionStart, h.selectionInput.selectionEnd), 'https://shop.example/#invite=Ab_C-09%2B%3D');
});

test('a rejected legacy copy never reports success and leaves text available for manual copying', async () => {
  for (const legacy of ['false', 'throws']) {
    const h = fieldHarness({legacy});
    assert.equal(await copy('https://shop.example/#reset=private-token', {...h, navigatorTarget: {}}), 'manual');
    assert.equal(h.clipboard, null);
    assert.equal(h.documentTarget.activeElement, h.selectionInput);
    assert.equal(h.selectionInput.value.slice(h.selectionInput.selectionStart, h.selectionInput.selectionEnd), 'https://shop.example/#reset=private-token');
  }
});
