import { test } from 'node:test';
import assert from 'node:assert/strict';
import { I18N, LANGS, initialLang, translate } from '../js/i18n.js';

test('every language has every English key', () => {
  const keys = Object.keys(I18N.en);
  for (const l of LANGS) {
    const missing = keys.filter(k => !(k in I18N[l]));
    assert.deepEqual(missing, [], `${l} is missing ${missing.join(', ')}`);
    const extra = Object.keys(I18N[l]).filter(k => !keys.includes(k));
    assert.deepEqual(extra, [], `${l} has extra ${extra.join(', ')}`);
  }
});

test('placeholders match across languages', () => {
  const ph = s => (s.match(/\{\w+\}/g) || []).sort().join(',');
  for (const k of Object.keys(I18N.en)) for (const l of LANGS) assert.equal(ph(I18N[l][k]), ph(I18N.en[k]), `${l}.${k}`);
});

test('initialLang prefers the saved choice, then the browser language', () => {
  assert.equal(initialLang('fr', 'it-IT'), 'fr');
  assert.equal(initialLang(null, 'it-IT'), 'it');
  assert.equal(initialLang('xx', 'de-DE'), 'en');
  assert.equal(initialLang(undefined, undefined), 'en');
});

test('translate substitutes placeholders and falls back to English', () => {
  assert.equal(translate('it', 'statusFound', { p: '42' }), 'Parete rilevata: 42% della foto.');
  assert.equal(translate('it', 'nope'), 'nope');
});
