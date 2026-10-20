import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSeo } from './seo-audit.ts';

const url = 'https://example.com/catalog/page';
function html({ title = 'Productos artesanales de la región', description = 'Descubre productos hechos a mano.', heading = 'Nuestros productos', canonical = '<link rel="canonical" href="/catalog/page">', schema = '<script type="application/ld+json">{}</script>', extra = '' } = {}) {
  return `<html lang="es"><head><title>${title}</title><meta name="description" content="${description}"><meta name="viewport" content="width=device-width">${canonical}${schema}${extra}</head><body><h1>${heading}</h1><img alt="" src="decorative.png"></body></html>`;
}
const codes = page => page.findings.map(finding => finding.code);

test('existing healthy pages retain a perfect score with the two-argument API', () => {
  const page = analyzeSeo(html(), url);
  assert.deepEqual(page.findings, []);
  assert.equal(page.score, 100);
  assert.equal(page.url, url);
  assert.equal(typeof page.checkedAt, 'number');
});

test('decodes named, decimal, hexadecimal and multi-code-point entities in SEO text', () => {
  const value = 'Caf&eacute; &AMP; pi&ntilde;a &#169; &#x1F34D; &NotEqualTilde;';
  const expected = 'Café & piña © 🍍 ≂̸';
  const page = analyzeSeo(html({ title: value, description: value, heading: `<span>${value}</span>` }), url);
  assert.equal(page.title, expected);
  assert.equal(page.description, expected);
  assert.deepEqual(page.h1, [expected]);
});

test('decodes once, preserves encoded angle brackets and handles quoted greater-than signs', () => {
  const page = analyzeSeo(html({
    title: 'Una guía &lt;especial&gt; &amp;lt; &unknown; &Amp;',
    description: 'A > B: &quot;oferta&quot; &lt;em&gt; &amp;quot;',
    heading: '<span title="A > B">Guía</span> &lt;oferta&gt; &apos;hoy&apos;',
  }), url);
  assert.equal(page.title, 'Una guía <especial> &lt; &unknown; &Amp;');
  assert.equal(page.description, 'A > B: "oferta" <em> &quot;');
  assert.deepEqual(page.h1, ["Guía <oferta> 'hoy'"]);
});

test('normalizes decoded whitespace and measures title length after decoding', () => {
  const page = analyzeSeo(html({ title: '&eacute;'.repeat(20), description: '\tTexto&nbsp;  útil\n', heading: 'Uno&nbsp; <b>dos</b>\n tres' }), url);
  assert.equal(page.title, 'é'.repeat(20));
  assert.equal(page.description, 'Texto útil');
  assert.deepEqual(page.h1, ['Uno dos tres']);
  assert.deepEqual(codes(page), []);
  const blank = analyzeSeo(html({ title: '&nbsp; &#32;', description: '&nbsp;' }), url);
  assert.ok(codes(blank).includes('title-missing'));
  assert.ok(codes(blank).includes('description-missing'));
});

test('handles legacy semicolonless references in text and attribute contexts', () => {
  const page = analyzeSeo(html({ title: 'Una &copycat &copy=1 &amp oferta &#65 &#x42', description: '&copycat &copy=1 &copy; &amp oferta &#65 &#x42', heading: '&notin; &notit;' }), url);
  assert.equal(page.title, 'Una ©cat ©=1 & oferta A B');
  assert.equal(page.description, '&copycat &copy=1 © & oferta A B');
  assert.deepEqual(page.h1, ['∉ ¬it;']);
});

test('invalid Unicode references are replaced safely and C1 references follow HTML decoding', () => {
  const page = analyzeSeo(html({ title: '&#0; &#xD800; &#x110000; &#999999999999999999999999999999; &#128; &#x80; &#x1F600; &#xZZ; &#-1;' }), url);
  assert.equal(page.title, '� � � � € € 😀 &#xZZ; &#-1;');
});

test('retains the missing-schema finding when JSON-LD is only commented out or inside another script', () => {
  for (const schema of [
    '',
    '<!-- <script type="application/ld+json">{}</script> -->',
    '<script>const sample = \'<script type="application/ld+json">{}\';</script>',
    '<script data-type="application/ld+json">{}</script>',
    '<style>.demo { content: \'<script type="application/ld+json">{}\'; }</style>',
  ]) {
    const page = analyzeSeo(html({ schema }), url);
    assert.deepEqual(codes(page), ['schema'], schema);
    assert.equal(page.score, 96);
    assert.match(page.findings[0].evidence, /microdatos ni RDFa/);
  }
});

test('accepts JSON-LD objects, arrays and graphs with case-insensitive or unquoted type attributes', () => {
  for (const schema of [
    '<script TYPE=" Application/LD+JSON ">{"@context":"https://schema.org","@type":"Product"}</script>',
    '<script type=application/ld+json>[{}, {"@type":"Organization"}]</script>',
    '<script type="application/ld+json">{"@graph":[{}],"name":"<!--literal comment-->"}</script>',
    '<script title="A > B" type="application/ld+json">{}</script>',
    '<script type="application/ld&#43;json">[]</script>',
  ]) assert.deepEqual(codes(analyzeSeo(html({ schema }), url)), [], schema);
});

test('reports malformed, empty and scalar JSON-LD without throwing or evaluating scripts', () => {
  for (const payload of ['', '  ', '{', '{"name":"x",}', '{&quot;name&quot;:1}', 'null', 'true', '42', '"text"', '[null]', '[1]', '[[]]', 'globalThis.__seoAuditExecuted = true']) {
    const page = analyzeSeo(html({ schema: `<script type="application/ld+json">${payload}</script>` }), url);
    assert.deepEqual(codes(page), ['schema-invalid'], payload);
    assert.equal(page.findings[0].severity, 'medium');
    assert.equal(page.score, 90);
  }
  assert.equal(globalThis.__seoAuditExecuted, undefined);
});

test('checks every JSON-LD block, reports one finding and does not mislabel invalid data as absent', () => {
  const page = analyzeSeo(html({ schema: '<script type="application/ld+json">{}</script><script type="application/ld+json">broken</script><script type="application/ld+json">null</script>' }), url);
  assert.deepEqual(codes(page), ['schema-invalid']);
  assert.match(page.findings[0].evidence, /2 de 3/);
  assert.equal(page.score, 90);
});

test('canonical checks accept relative, cross-origin, HTTP and entity-encoded URLs', () => {
  for (const href of ['/catalog/page', '../preferred', '?page=1&amp;lang=es', '//other.example/preferred', 'https://other.example/preferred', 'http://example.com/page', 'https://example.com/caf%C3%A9', ' https://example.com/page ']) {
    const page = analyzeSeo(html({ canonical: `<link rel="alternate CANON&#73;CAL" href="${href}">` }), url);
    assert.deepEqual(codes(page), [], href);
  }
});

test('absent, missing-href and blank canonical links preserve the missing-canonical finding', () => {
  for (const canonical of ['', '<link rel="canonical">', '<link rel="canonical" href="">', '<link rel="canonical" href="&nbsp;">', '<link rel="not-canonical" href="/page">']) {
    assert.deepEqual(codes(analyzeSeo(html({ canonical }), url)), ['canonical-missing'], canonical);
  }
});

test('canonical checks reject non-web schemes, malformed URLs, credentials and fragments', () => {
  for (const href of ['javascript:alert(1)', 'javascript&#58;alert(1)', 'data:text/html,hello', 'mailto:hello@example.com', 'ftp://example.com/page', 'https://', 'https://[invalid', 'https:/example.com', 'https:///example.com', 'https://user:pass@example.com/', 'https://example.com/a b', 'https://example.com/%ZZ', 'https://example.com/&#10;path', 'https:\\example.com', '#section', '/page#section']) {
    const page = analyzeSeo(html({ canonical: `<link rel="canonical" href="${href}">` }), url);
    assert.deepEqual(codes(page), ['canonical-invalid'], href);
    assert.equal(page.findings[0].severity, 'medium');
  }
});

test('multiple canonical declarations are flagged even when identical or one is invalid', () => {
  for (const second of ['/catalog/page', '/other', '']) {
    const page = analyzeSeo(html({ canonical: `<link rel="canonical" href="/catalog/page"><link rel="canonical" href="${second}">` }), url);
    assert.deepEqual(codes(page), ['canonical-multiple'], second);
    assert.match(page.findings[0].evidence, /2/);
  }
  const page = analyzeSeo(html({ canonical: '<link rel="canonical" href="/catalog/page"><link rel="canonical" href="javascript:void(0)">' }), url);
  assert.deepEqual(codes(page), ['canonical-invalid', 'canonical-multiple']);
  assert.equal(page.score, 80);
});

test('canonical resolution respects the first base URL without fetching it', () => {
  const page = analyzeSeo(html({ extra: '<base href="ftp://example.com/">', canonical: '<link rel="canonical" href="relative">' }), url);
  assert.deepEqual(codes(page), ['canonical-invalid']);
  const valid = analyzeSeo(html({ extra: '<base href="https://other.example/"><base href="ftp://ignored.example/">' }), url);
  assert.deepEqual(codes(valid), []);
});

test('optional response headers detect noindex case-insensitively and support repeated values', () => {
  for (const headers of [
    { 'x-robots-tag': 'noindex, follow' },
    { 'X-Robots-Tag': 'NOINDEX' },
    { 'X-ROBOTS-TAG': ['index', 'googlebot: noindex, nofollow'] },
    { 'x-robots-tag': undefined, 'X-Robots-Tag': 'none' },
  ]) {
    const page = analyzeSeo(html(), url, headers);
    assert.deepEqual(codes(page), ['noindex']);
    assert.equal(page.score, 80);
    assert.match(page.findings[0].evidence, /X-Robots-Tag/);
    assert.equal(page.findings[0].action, 'Confirmar si esta página debe aparecer en Google antes de cambiar la directiva.');
  }
});

test('headers do not invent noindex from unrelated fields or directive substrings', () => {
  for (const headers of [undefined, {}, { 'x-robots-tag': undefined }, { 'other-header': 'noindex' }, { 'x-robots-tag': 'index, nofollow, nosnippet' }, { 'x-robots-tag': 'not-noindex, noindexing' }, { 'x-robots-tag': 'unavailable_after: noindex' }, { 'x-robots-tag': 'bingbot: noindex, nofollow' }, { 'x-robots-tag': 'bingbot: noindex, googlebot: index' }]) {
    assert.deepEqual(codes(analyzeSeo(html(), url, headers)), [], JSON.stringify(headers));
  }
});

test('meta and header noindex share one finding and preserve the existing intent warning', () => {
  const markup = html({ extra: '<meta name="robots" content="noindex,follow">' });
  const meta = analyzeSeo(markup, url);
  assert.equal(meta.findings[0].evidence, 'Se detectó noindex en una metaetiqueta.');
  const both = analyzeSeo(markup, url, { 'X-Robots-Tag': 'noindex' });
  assert.deepEqual(codes(both), ['noindex']);
  assert.equal(both.score, 80);
  assert.match(both.findings[0].evidence, /metaetiqueta.*X-Robots-Tag/);
  assert.equal(both.findings[0].action, meta.findings[0].action);
});

test('scripts and comments cannot inject headings, canonical links or robots findings', () => {
  const extra = '<!-- <link rel="canonical" href="javascript:alert(1)"><meta name="robots" content="noindex"> --><script>"<h1>fake</h1><link rel=canonical href=bad><meta name=robots content=noindex>"</script>';
  const page = analyzeSeo(html({ extra }), url);
  assert.deepEqual(codes(page), []);
  assert.deepEqual(page.h1, ['Nuestros productos']);
});
