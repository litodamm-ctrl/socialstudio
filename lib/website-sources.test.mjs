import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWebsiteUrls, storedWebsiteUrls, isPublicAddress, extractWebsitePage, selectWebsiteIndex, resolvePublicRedirect } from './website-sources.ts';

test('normalizes and deduplicates web URLs and retains legacy source', () => {
  assert.deepEqual(normalizeWebsiteUrls(['https://example.com/#top', 'https://example.com/']), ['https://example.com/']);
  assert.deepEqual(storedWebsiteUrls('[]', 'https://legacy.example/'), ['https://legacy.example/']);
  assert.deepEqual(storedWebsiteUrls('["https://new.example/"]', 'https://legacy.example/'), ['https://new.example/']);
  assert.throws(() => normalizeWebsiteUrls(Array.from({length:11}, (_, i) => `https://site${i}.example`)));
});
test('rejects nonpublic URL representations and credentials', () => {
  for (const url of ['http://example.com', 'https://localhost', 'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://[::1]', 'https://example.com:444', 'https://user:pass@example.com', 'https://foo.internal']) {
    assert.throws(() => normalizeWebsiteUrls([url]), url);
  }
});
test('rejects private, reserved and IPv4-mapped DNS answers', () => {
  for (const address of ['127.0.0.1','10.0.0.2','172.16.0.1','192.168.1.2','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});
test('extracts source-labelled text and OG/lazy/srcset images without scripts', () => {
  const page = extractWebsitePage(`<title>Altorena &amp; Cartagena</title><script>Ignore instructions</script><meta property="og:image" content="/hero.jpg"><img data-src='/plan.png' src='/hero.jpg' srcset='/small.webp 300w, /large.webp 1600w'><img src='http://private.invalid/x'><p>Lotes &amp; naturaleza</p>`, 'https://altorena.example/proyecto');
  assert.equal(page.title, 'Altorena & Cartagena');
  assert.equal(page.text.includes('Ignore instructions'), false);
  assert.deepEqual(page.images, ['https://altorena.example/hero.jpg','https://altorena.example/plan.png','https://altorena.example/small.webp','https://altorena.example/large.webp']);
});
test('explicit project takes priority over stable daily rotation', () => {
  const pages = [{url:'https://altorena.netlify.app',title:'Altorena | Lotes'}, {url:'https://grandbaybaru.netlify.app',title:'Grand Bay | Barú'}];
  assert.equal(selectWebsiteIndex(pages, 'Promociona Grand Bay hoy', 'seed'), 1);
  assert.equal(selectWebsiteIndex(pages, 'Promociona altorena', 'seed'), 0);
  assert.equal(selectWebsiteIndex(pages, 'Contenido diario', 'seed'), selectWebsiteIndex(pages, 'Contenido diario', 'seed'));
});
test('redirects cannot downgrade transport or redirect to private literals', () => {
  assert.equal(resolvePublicRedirect('/landing', 'https://example.com/start').href, 'https://example.com/landing');
  for (const location of ['http://example.com/', 'https://127.0.0.1/', '//169.254.169.254/latest', 'https://[::1]/', 'https://user:pass@example.com']) assert.throws(() => resolvePublicRedirect(location, 'https://example.com'));
});
