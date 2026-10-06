import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWebsite } from './website-sources.ts';

test('distinguishes DNS, HTTP and size failures without leaking arbitrary upstream messages', async () => {
  for (const [error, expected] of [
    [Object.assign(new Error('private details'), { code: 'EAI_AGAIN' }), /DNS/],
    [new Error('Web HTTP 403'), /HTTP 403/],
    [new Error('El recurso web supera el límite de tamaño.'), /límite de tamaño/],
    [new Error('secret internal response'), /conexión segura/],
  ]) {
    const result = await inspectWebsite('https://example.com/', async () => { throw error; });
    assert.equal(result.page, null);
    assert.match(result.error, expected);
    assert.doesNotMatch(result.error, /private details|secret internal/);
  }
});

test('reports empty client-rendered pages separately from valid project text', async () => {
  const resource = html => ({ bytes: Buffer.from(html), contentType: 'text/html', url: 'https://example.com/' });
  assert.match((await inspectWebsite('https://example.com/', async () => resource('<div id="root"></div>'))).error, /JavaScript/);
  const result = await inspectWebsite('https://example.com/', async () => resource('<h1>Proyecto de lotes en Cartagena con información suficiente para preparar contenido.</h1><img src="/lote.jpg">'));
  assert.equal(result.page.images.length, 1);
  assert.equal(result.error, undefined);
});
