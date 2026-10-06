import test from 'node:test';
import assert from 'node:assert/strict';
import { isDneyla, DNEYLA_ESSENCE, DNEYLA_WEBSITE } from './brand-presets.ts';

test('Dneyla policy recognizes its spelling variants without affecting other brands', () => {
  for (const name of ['D’Neyla', "D'Neyla", 'dneyla', 'D NEYLA']) assert.equal(isDneyla(name), true);
  for (const name of ['Bahía Investment', 'FITZONE', 'Manglar', 'Dneyla otra marca']) assert.equal(isDneyla(name), false);
});
test('preset fits the saved brand profile and includes verified official website', () => {
  assert.ok(DNEYLA_ESSENCE.length >= 20 && DNEYLA_ESSENCE.length <= 4000);
  assert.equal(DNEYLA_WEBSITE, 'https://dneylacentrohistorico.com/');
});
