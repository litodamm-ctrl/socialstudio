import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';

// Exercise the real streaming limiter with an in-memory HTTPS transport.
const source = (await readFile(new URL('./website-sources.ts', import.meta.url), 'utf8'))
  .replace('import { lookup } from "node:dns/promises";', 'const lookup = async () => [{ address: "8.8.8.8", family: 4 }];')
  .replace('import { request } from "node:https";', 'let request; export function setTransport(value) { request = value; }');
const mod = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
function transport(bytes) {
  return (_url, _options, callback) => {
    const req = new EventEmitter(); let destroyed = false;
    req.destroy = error => { destroyed = true; if (error) req.emit('error', error); req.emit('close'); };
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {'content-type':'text/html'};
      res.destroy = () => { destroyed = true; req.emit('close'); };
      callback(res);
      for (let offset=0; offset<bytes.length && !destroyed; offset+=65536) res.emit('data', bytes.subarray(offset, offset+65536));
      if (!destroyed) { res.emit('end'); req.emit('close'); }
    });
    return req;
  };
}
test('reads a landing page above the former 512 KB cap and extracts its real content', async () => {
  const html = `<script>${'x'.repeat(900000)}</script><h1>Proyecto de lotes en Cartagena con información confirmada para visitantes.</h1><img src="/proyecto.jpg">`;
  mod.setTransport(transport(Buffer.from(html)));
  const result = await mod.inspectWebsite('https://example.com/');
  assert.equal(result.error, undefined);
  assert.match(result.page.text, /Proyecto de lotes/);
  assert.deepEqual(result.page.images, ['https://example.com/proyecto.jpg']);
  assert.ok(result.page.text.length < 1000);
});
test('retains a bounded HTML limit and independent media limits', async () => {
  mod.setTransport(transport(Buffer.alloc(mod.MAX_WEBSITE_BYTES + 1, 65)));
  assert.match((await mod.inspectWebsite('https://example.com/')).error, /límite de tamaño/);
  mod.setTransport(transport(Buffer.alloc(1025, 65)));
  await assert.rejects(mod.fetchPublicResource('https://example.com/image.jpg', 1024), /límite de tamaño/);
});
