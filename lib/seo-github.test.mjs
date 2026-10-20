import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// Resolve the app alias and the lazy runtime dependency without changing app configuration.
const moduleSource = readFileSync(new URL('./seo-github.ts', import.meta.url), 'utf8')
  .replace('"@/lib/seo-audit"', JSON.stringify(new URL('./seo-audit.ts', import.meta.url).href))
  .replace('import("typescript")', `import(${JSON.stringify(import.meta.resolve('typescript'))})`);
const { githubConfigured, parseGithubTargets, updateSeoMetadata, updateNextSeoMetadata, createSeoPullRequest } =
  await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(moduleSource)).toString('base64')}`);

const target = { url: 'https://example.com/', repository: 'owner/site', branch: 'main', path: 'public/index.html' };
const input = { target, title: 'A better title', description: 'A clear description.', runId: '710fc5c4-116e-4b53-8b48-4289b285fcba', brandName: 'Brand' };
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const originalHtml = '<!doctype html><html><head><title>Old title</title><meta name="description" content="Old description"><script>const keep = "<title>fake</title>";</script></head><body><h1>Unchanged</h1></body></html>';
const hash = value => createHash('sha1').update(value).digest('hex');
const blob = value => {
  const bytes = Buffer.from(value);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
const branchFor = value => `seo-studio/${value.runId.toLowerCase()}-${createHash('sha256').update(JSON.stringify([
  new URL(value.target.url).href.replace(/#.*$/, ''), value.target.repository.toLowerCase(), value.target.branch, value.target.path,
])).digest('hex').slice(0, 24)}`;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const environments = new WeakSet();
function environment(t, token) {
  if (!environments.has(t)) {
    const before = process.env.SEO_GITHUB_TOKEN;
    t.after(() => { if (before === undefined) delete process.env.SEO_GITHUB_TOKEN; else process.env.SEO_GITHUB_TOKEN = before; });
    environments.add(t);
  }
  if (token === undefined) delete process.env.SEO_GITHUB_TOKEN;
  else process.env.SEO_GITHUB_TOKEN = token;
}

function fixture(t, options = {}) {
  environment(t, 'test-token-not-real');
  const config = options.input ?? input;
  const html = options.html ?? originalHtml;
  const state = {
    calls: [], prs: [], refs: new Map(), contents: html,
    branch: branchFor(config), sourceSha: hash('source commit'), newSha: hash('metadata commit'), blobSha: blob(html),
  };
  const parts = config.target.path.split('/');
  state.refs.set(config.target.branch, state.sourceSha);
  state.ref = (name, sha = state.refs.get(name)) => ({ ref: `refs/heads/${name}`, object: { type: 'commit', sha } });
  state.pr = (overrides = {}) => ({
    number: 17, state: 'open', html_url: `https://github.com/${config.target.repository}/pull/17`,
    head: { ref: state.branch, repo: { full_name: config.target.repository } },
    base: { ref: config.target.branch, repo: { full_name: config.target.repository } }, ...overrides,
  });
  state.content = () => ({ sha: state.blobSha, size: Buffer.byteLength(html), encoding: 'base64', content: Buffer.from(html).toString('base64').replace(/.{60}/g, '$&\n') });
  t.mock.method(globalThis, 'fetch', async (address, init) => {
    const url = new URL(address);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(init.headers.Authorization, 'Bearer test-token-not-real');
    assert.equal(init.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const path = decodeURIComponent(url.pathname.replace(`/repos/${config.target.repository.toLowerCase()}`, ''));
    const call = { url, path, method: init.method, body, signal: init.signal };
    state.calls.push(call);
    const respond = () => {
      if (path === '/pulls' && init.method === 'GET') {
        assert.equal(url.searchParams.get('state'), 'all');
        assert.equal(url.searchParams.get('head'), `${config.target.repository.split('/')[0].toLowerCase()}:${state.branch}`);
        return json(state.prs);
      }
      if (path.startsWith('/git/ref/heads/') && init.method === 'GET') {
        const name = path.slice('/git/ref/heads/'.length);
        return state.refs.has(name) ? json(state.ref(name)) : json({ message: 'not found' }, 404);
      }
      if (path === `/git/commits/${state.sourceSha}` && init.method === 'GET') return json({ sha: state.sourceSha, tree: { sha: hash('tree 0') } });
      if (path.startsWith('/git/trees/') && init.method === 'GET') {
        const index = parts.findIndex((_, i) => path === `/git/trees/${hash(`tree ${i}`)}`);
        assert.ok(index >= 0, 'tree must be pinned to the captured source');
        const last = index === parts.length - 1;
        return json({ sha: hash(`tree ${index}`), truncated: false, tree: [{ path: parts[index], mode: last ? '100644' : '040000', type: last ? 'blob' : 'tree', sha: last ? state.blobSha : hash(`tree ${index + 1}`), ...(last ? { size: Buffer.byteLength(html) } : {}) }] });
      }
      if (path === `/git/blobs/${state.blobSha}` && init.method === 'GET') {
        assert.equal(url.search, '', 'read the immutable blob verified through the source commit tree');
        return json(state.content());
      }
      if (path === '/git/refs' && init.method === 'POST') {
        assert.deepEqual(body, { ref: `refs/heads/${state.branch}`, sha: state.sourceSha });
        if (state.refs.has(state.branch)) return json({ message: 'already exists' }, 422);
        state.refs.set(state.branch, state.sourceSha);
        return json(state.ref(state.branch), 201);
      }
      if (path === `/contents/${config.target.path}` && init.method === 'PUT') {
        assert.equal(body.branch, state.branch);
        assert.equal(body.sha, state.blobSha);
        state.contents = Buffer.from(body.content, 'base64').toString('utf8');
        state.refs.set(state.branch, state.newSha);
        return json({ content: { path: config.target.path, sha: blob(state.contents) }, commit: { sha: state.newSha, parents: [{ sha: state.sourceSha }] } });
      }
      if (path === '/pulls' && init.method === 'POST') {
        assert.equal(body.head, state.branch);
        assert.equal(body.base, config.target.branch);
        assert.equal(body.maintainer_can_modify, false);
        assert.equal(body.draft, undefined, 'standard PR supports repositories without drafts');
        assert.equal(body.auto_merge, undefined);
        state.prs.push(state.pr());
        return json(state.prs.at(-1), 201);
      }
      assert.fail(`Unexpected mocked request: ${init.method} ${path}`);
    };
    const intercepted = await options.onRequest?.({ ...call, state, respond });
    return intercepted === undefined ? respond() : intercepted;
  });
  state.mutations = () => state.calls.filter(call => call.method !== 'GET');
  return state;
}

test('configuration uses only SEO_GITHUB_TOKEN and treats blanks as unconfigured', t => {
  environment(t, undefined);
  assert.equal(githubConfigured(), false);
  process.env.SEO_GITHUB_TOKEN = '   ';
  assert.equal(githubConfigured(), false);
  process.env.SEO_GITHUB_TOKEN = 'configured';
  assert.equal(githubConfigured(), true);
});

test('targets canonicalize exact configured URLs and repository identity', () => {
  assert.deepEqual(parseGithubTargets([{ ...target, url: 'https://EXAMPLE.com:443/#section', repository: 'Owner/Site' }], ['https://example.com']), [target]);
  assert.deepEqual(parseGithubTargets(undefined, []), []);
  assert.deepEqual(parseGithubTargets(null, []), []);
  assert.deepEqual(parseGithubTargets([], []), []);
  assert.throws(() => parseGithubTargets([target, { ...target, url: 'https://EXAMPLE.com/#again' }], [target.url]), /únicas/);
  for (const url of ['https://example.com/other', 'https://example.com/?q=other', 'https://www.example.com/', 'https://example.com.evil.org/']) {
    assert.throws(() => parseGithubTargets([{ ...target, url }], [target.url]), /exactamente/);
  }
  const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
  assert.equal(parseGithubTargets(urls.map(url => ({ ...target, url })), urls).length, 10);
  assert.throws(() => parseGithubTargets(Array(11).fill(target), [target.url]), /10/);
  for (const value of ['[]', {}, true, [null], [1], [{ ...target, token: 'no' }]]) assert.throws(() => parseGithubTargets(value, [target.url]));
});

test('targets reject credentials, API URLs, unsafe branches and paths', () => {
  const invalid = {
    url: ['http://example.com/', 'https://user:pass@example.com/', 'https://@example.com/', 'https://example.com:444/', 'https://127.0.0.1/', 'https://[::1]/', 'https://example.internal/', 'https://example.com/\n', 'https://example.com\\@evil.com/'],
    repository: ['https://github.com/owner/site', 'owner/site?token=secret', 'owner:secret/site', '../site', 'owner/..', 'owner/site/extra', 'owner/site.git', 'owner\\site'],
    branch: ['', '../main', 'feature//main', 'feature/../main', 'main.lock', '.hidden', 'main.', 'main@{1}', 'main?x=y', 'main%2Fnext', 'main\\next', 'HEAD', 'refs/heads/main', 'seo-studio/reserved', 'main\n'],
    path: ['index.htm', 'index.ts', '/index.html', '../index.html', 'public/../index.html', 'public//index.html', '.github/index.html', 'public/.GITHUB/index.html', '.env/index.html', 'public/%2e%2e/index.html', 'public\\index.html', 'https://user:secret@example.com/index.html', 'index.html?x=y', 'index.html\n'],
  };
  for (const [key, values] of Object.entries(invalid)) for (const value of values) {
    assert.throws(() => parseGithubTargets([{ ...target, [key]: value }], [target.url]), undefined, `${key}: ${JSON.stringify(value)}`);
  }
  const safe = { ...target, branch: 'release/v2.1', path: 'public/en-US/index.HTML' };
  assert.deepEqual(parseGithubTargets([safe], [safe.url]), [safe]);
});

test('only the four explicit Next root paths join the static HTML allowlist', () => {
  for (const path of ['app/layout.tsx', 'src/app/layout.tsx', 'app/page.tsx', 'src/app/page.tsx']) {
    assert.equal(parseGithubTargets([{ ...target, path }], [target.url])[0].path, path);
  }
  for (const path of ['layout.tsx', 'app/layout.ts', 'app/page.jsx', 'app/page.TSX', 'pages/index.tsx', 'app/blog/page.tsx', 'src/app/blog/layout.tsx', 'src/app/api/route.ts', 'app/layout.tsx/other.html/..', 'app/../app/page.tsx', '.github/app/layout.tsx']) {
    assert.throws(() => parseGithubTargets([{ ...target, path }], [target.url]), undefined, path);
  }
});

test('metadata edits escape values and preserve script, body, comments and unrelated attributes exactly', () => {
  const html = '<!doctype html>\r\n<HTML><HEAD data-keep="yes">\r\n<!-- <title>fake</title><meta name="description"> -->\r\n<TITLE id="keep">old</TITLE>\r\n<META data-keep="a > b" CONTENT=old NAME=DeScRiPtIoN><meta property="og:description" content="keep"><script>const s="<head><title>fake</title></head>";</script><style>.x:after{content:"<title>fake</title>"}</style></HEAD><body><p>Keep &amp; preserve</p></body></HTML>';
  const result = updateSeoMetadata(html, '</title><script>x</script> & "\'', '" onload="evil & <tag> \'');
  assert.equal(result, html.replace('>old</TITLE>', '>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt; &amp; &quot;&#39;</TITLE>')
    .replace('CONTENT=old', 'CONTENT="&quot; onload=&quot;evil &amp; &lt;tag&gt; &#39;"'));
  assert.equal(updateSeoMetadata(result, '</title><script>x</script> & "\'', '" onload="evil & <tag> \''), result);
});

test('missing metadata is added immediately before the explicit closing head', () => {
  assert.equal(updateSeoMetadata('<html><head></head><body>Keep</body></html>', 'T', 'D'), '<html><head>\n<title>T</title>\n<meta name="description" content="D">\n</head><body>Keep</body></html>');
  assert.equal(updateSeoMetadata('<head><title>old</title></head>', 'T', 'D'), '<head><title>T</title>\n<meta name="description" content="D">\n</head>');
  assert.equal(updateSeoMetadata('<head><meta name="description" data-keep="1" /></head>', 'T', 'D'), '<head><meta name="description" data-keep="1"  content="D"/>\n<title>T</title>\n</head>');
  assert.ok(updateSeoMetadata('<head>\r\n</head>', 'T', 'D').includes('\r\n<title>T</title>\r\n'));
  assert.equal(updateSeoMetadata('\ufeff<head><title>T</title><meta name="description" content="D"></head>', 'T', 'D').charCodeAt(0), 0xfeff);
});

test('exact requested Unicode text, whitespace and literal entities survive escaping without trimming or truncation', () => {
  const title = '  Café 🥐 &amp; "título" <uno> \'  ';
  const description = '  Bogotá — descripción e\u0301 & <dos> "tres" \'cuatro\'  ';
  const html = '<head><title>old</title><meta NAME="DESCRIPTION" content=old></head><body>\r\nSin cambios 🌍</body>';
  const expected = '<head><title>  Café 🥐 &amp;amp; &quot;título&quot; &lt;uno&gt; &#39;  </title><meta NAME="DESCRIPTION" content="  Bogotá — descripción e\u0301 &amp; &lt;dos&gt; &quot;tres&quot; &#39;cuatro&#39;  "></head><body>\r\nSin cambios 🌍</body>';
  assert.equal(updateSeoMetadata(html, title, description), expected);
  assert.equal(updateSeoMetadata(expected, title, description), expected);
});

test('HTML scanner rejects missing, repeated, malformed and ambiguous metadata', () => {
  const cases = [
    '', '<title>outside</title>', '<head>', '<head/>', '<head></head><head></head>', '<head><head></head></head>',
    '<head></head></head>', '<body><head></head></body>', '<head><body></body></head>', '<head>visible text</head>',
    '<head><title>one</title><title>two</title></head>', '<head><title>nested<title>bad</title></head>', '<head><title>unclosed</head>',
    '<head><title/></head>', '<head></title></head>', '<head></head><title>outside</title>',
    '<head><meta name="description"><meta name=DESCRIPTION></head>', '<head></head><meta name="description">',
    '<head><meta name="description" NAME="other" content="old"></head>', '<head><meta name="description" content="a" content="b"></head>',
    '<head><meta name="descript&#105;on" content="old"></head>', '<head><meta name content="old"></head>',
    '<head><meta name=" description " content="old"></head>',
    '<head><meta name="description" content></head>', '<head><meta name="description" content="unterminated></head>',
    '<head><noscript><meta name="description"></noscript></head>', '<head><template><title>nested</title></template></head>',
    '<head><title>{{ site.title }}</title></head>', '<head><meta name="description" content="{{ description }}"></head>',
    '<head><script><!--<script></script>--></script></head>', '<!--><head></head>-->', '<!--nested<!-- --><head></head>',
    '<head><meta charset="iso-8859-1"></head>', '<head><meta http-equiv="content-type" content="text/html; charset=latin1"></head>',
    '<head></head><plaintext>unparsed', '<head><?php echo "title"; ?></head>', '<head>\0</head>',
  ];
  for (const html of cases) assert.throws(() => updateSeoMetadata(html, 'T', 'D'), undefined, html);
});

test('metadata length, UTF-8 validity and source/output byte limits are enforced', () => {
  const html = '<head></head>';
  for (const value of ['', '   ', 'x'.repeat(151), '\0', '\n', '\ud800', 3, null]) assert.throws(() => updateSeoMetadata(html, value, 'D'));
  for (const value of ['', 'x'.repeat(321), '\t', '\udfff', null]) assert.throws(() => updateSeoMetadata(html, 'T', value));
  assert.ok(updateSeoMetadata(html, 'é'.repeat(150), '🚀'.repeat(320)).includes('é'.repeat(150)));
  assert.throws(() => updateSeoMetadata(html + ' '.repeat(MAX_SOURCE_BYTES), 'T', 'D'), /16 MiB/);
  assert.throws(() => updateSeoMetadata(html + ' '.repeat(MAX_SOURCE_BYTES - html.length), 'T', 'D'), /superaría/);
  assert.throws(() => updateSeoMetadata('<head></head>\ud800', 'T', 'D'), /UTF-8/);
});

const altorenaSource = `import type { Metadata } from 'next';
import './globals.css';

const title = 'Altorena — título anterior';
const description = 'Descripción anterior de Altorena';

export const metadata: Metadata = {
  metadataBase: new URL('https://altorena.example'),
  title,
  description,
  openGraph: { title, description, type: 'website' },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="es"><body>{children}</body></html>;
}
`;

test('Next AST supports the Altorena shorthand shape and changes only its two literal offsets', async () => {
  const result = await updateNextSeoMetadata(altorenaSource, 'Altorena — título exacto', 'Descripción exacta de Altorena');
  assert.equal(result, altorenaSource.replace("'Altorena — título anterior'", '"Altorena — título exacto"')
    .replace("'Descripción anterior de Altorena'", '"Descripción exacta de Altorena"'));
  assert.equal(await updateNextSeoMetadata(result, 'Altorena — título exacto', 'Descripción exacta de Altorena'), result);
});

test('Next AST accepts direct literals and mixed direct/shorthand fields without reprinting source', async () => {
  const direct = '\ufeffimport type { Metadata } from "next";\r\nexport const metadata: Metadata = { "title": /* keep */ \'Old\', description: "Before", openGraph: { title: "UNCHANGED" } };\r\nexport default () => <main>Keep</main>;';
  assert.equal(await updateNextSeoMetadata(direct, 'New', 'After'), direct.replace("/* keep */ 'Old'", '/* keep */ "New"').replace('description: "Before"', 'description: "After"'));
  const mixed = "const title: string = 'old'; export const metadata = {title, description: 'before'};";
  assert.equal(await updateNextSeoMetadata(mixed, 'New', 'After'), 'const title: string = "New"; export const metadata = {title, description: "After"};');
});

test('Next AST parses JS escapes and generates safe literals whose decoded values exactly match the request', async () => {
  const { createSourceFile, ScriptKind, ScriptTarget, isVariableStatement, isPropertyAssignment, isStringLiteral } = await import('typescript');
  const source = String.raw`export const metadata = {ti\u0074le: 'old\'title', "\x64escription": "old\\description"};`;
  const title = '  Café "quoted" \\ path </script> ${danger()} &amp;  ';
  const description = 'Exacto: \' Bogotá 🚀 \u2028línea\u2029 <div> &  ';
  const result = await updateNextSeoMetadata(source, title, description);
  const parsed = createSourceFile('root.tsx', result, ScriptTarget.Latest, true, ScriptKind.TSX);
  assert.equal(parsed.parseDiagnostics.length, 0);
  const properties = parsed.statements.find(isVariableStatement).declarationList.declarations[0].initializer.properties;
  assert.ok(properties.every(property => isPropertyAssignment(property) && isStringLiteral(property.initializer)));
  assert.deepEqual(properties.map(property => property.initializer.text), [title, description]);
  assert.ok(result.includes('\\u003c/script\\u003e'));
  assert.ok(result.includes('\\u2028'));
  assert.ok(result.includes('\\u2029'));
  assert.ok(result.startsWith(String.raw`export const metadata = {ti\u0074le:`));
});

test('Next AST ignores fake code in comments/strings and never executes source', async () => {
  const source = `// export const metadata = {title: 'fake', description: 'fake'}; generateMetadata();
/* const title = 'spoof'; export function generateMetadata() {} */
const example = "export const metadata = {}; generateMetadata()";
throw new Error('SOURCE MUST NEVER EXECUTE');
export const metadata = {title: 'Actual', description: 'Real'};
export default () => <div>const metadata = fake; generateMetadata</div>;`;
  const result = await updateNextSeoMetadata(source, 'Updated', 'Updated description');
  assert.equal(result, source.replace("title: 'Actual'", 'title: "Updated"').replace("description: 'Real'", 'description: "Updated description"'));
  await assert.rejects(updateNextSeoMetadata('// export const metadata = {title: "spoof", description: "spoof"};', 'T', 'D'), /Next.js/);
});

test('Next AST rejects malformed, dynamic, indirect, generated and ambiguous metadata', async () => {
  const cases = [
    'export const metadata = { title: "T", description: "D";',
    'export let metadata = {title: "T", description: "D"};',
    'const metadata = {title: "T", description: "D"}; export {metadata};',
    'export default {title: "T", description: "D"};',
    'export const metadata = createMetadata();',
    'export const metadata = enabled ? {title: "T", description: "D"} : {};',
    'export const metadata = {title: {default: "T", template: "%s"}, description: "D"};',
    'export const metadata = {title: `T`, description: "D"};',
    'export const metadata = {title: "T", description: `dynamic ${value}`};',
    'export const metadata = {title: 123, description: "D"};',
    'export const metadata = {title: "T", description: null};',
    'export const metadata = {title: "T"};',
    'export const metadata = {title: "T", description: "D", title: "override"};',
    String.raw`export const metadata = {title: 'T', description: 'D', "\x74itle": 'override'};`,
    'export const metadata = {...shared, title: "T", description: "D"};',
    'export const metadata = {title: "T", description: "D", ...shared};',
    'export const metadata = {[key]: "T", title: "T", description: "D"};',
    'export const metadata = {get title() { return "T"; }, description: "D"};',
    'const title = "T"; export const metadata = {title: title, description: "D"};',
    'const title = getTitle(); const description = "D"; export const metadata = {title, description};',
    'let title = "T"; const description = "D"; export const metadata = {title, description};',
    'const title = "T", title = "duplicate", description = "D"; export const metadata = {title, description};',
    'import title from "./other"; const description = "D"; export const metadata = {title, description};',
    'const title = "T"; import title from "./other"; const description = "D"; export const metadata = {title, description};',
    'export const metadata = {title, description}; const title = "T", description = "D";',
    'const title = "T", description = "D"; export const metadata = {title = "override", description};',
    'export const metadata = {title: "T", description: "D"}; export const metadata = {title: "2", description: "2"};',
    'export const metadata = {title: "T", description: "D"}; export async function generateMetadata() {return {};}',
    'export const metadata = {title: "T", description: "D"}; export {make as generateMetadata} from "./other";',
    'export const metadata = {title: "T", description: "D"}; export * from "./other";',
    'export const metadata = {title: "T", description: "D"}; metadata.title = "Changed";',
    'export const metadata = {title: "T", description: "D"}; Object.assign(metadata, {title: "Changed"});',
    'export const metadata = {title: "T", description: "D"}; const alias = metadata;',
    'const title = "T", description = "D"; export const metadata = {title, description}; title = "Changed";',
  ];
  for (const source of cases) await assert.rejects(updateNextSeoMetadata(source, 'New', 'New description'), /Next.js/, source);
});

test('Next AST preserves existing equivalent literals and applies the same input/output limits', async () => {
  const source = String.raw`export const metadata = {title: '\u0054', description: 'D'};`;
  assert.equal(await updateNextSeoMetadata(source, 'T', 'D'), source);
  for (const [title, description] of [['', 'D'], ['T', ''], ['x'.repeat(151), 'D'], ['T', 'x'.repeat(321)], ['\ud800', 'D']]) {
    await assert.rejects(updateNextSeoMetadata(source, title, description), /caracteres/);
  }
  await assert.rejects(updateNextSeoMetadata(source + ' '.repeat(MAX_SOURCE_BYTES), 'T', 'D'), /16 MiB/);
  await assert.rejects(updateNextSeoMetadata(source + ' '.repeat(MAX_SOURCE_BYTES - Buffer.byteLength(source)), 'x'.repeat(150), 'D'), /superaría/);
  await assert.rejects(updateNextSeoMetadata(source + '\0', 'T', 'D'), /UTF-8/);
});

test('all four Next root targets use the same pinned, verified PR flow and leave the base untouched', async t => {
  for (const path of ['app/layout.tsx', 'src/app/layout.tsx', 'app/page.tsx', 'src/app/page.tsx']) {
    const run = { ...input, target: { ...target, path } };
    const state = fixture(t, { input: run, html: altorenaSource });
    const result = await createSeoPullRequest(run);
    assert.equal(result.number, 17);
    assert.equal(state.contents, await updateNextSeoMetadata(altorenaSource, run.title, run.description));
    assert.equal(state.refs.get('main'), state.sourceSha);
    assert.deepEqual(state.mutations().map(call => [call.method, call.path]), [['POST', '/git/refs'], ['PUT', `/contents/${path}`], ['POST', '/pulls']]);
    const count = state.calls.length;
    assert.deepEqual(await createSeoPullRequest(run), result);
    assert.equal(state.calls.length, count + 1);
    t.mock.restoreAll();
  }
});

test('dynamic Next metadata fails before any branch creation, while equivalent metadata is a no-op', async t => {
  const run = { ...input, target: { ...target, path: 'app/layout.tsx' } };
  for (const html of [
    'export const metadata = createMetadata();',
    `export const metadata = {title: ${JSON.stringify(run.title)}, description: ${JSON.stringify(run.description)}};`,
  ]) {
    const state = fixture(t, { input: run, html });
    await assert.rejects(createSeoPullRequest(run), /Next.js|ya coinciden/);
    assert.equal(state.mutations().length, 0);
    t.mock.restoreAll();
  }
});

test('stale HTML audit evidence rejects changed title or description with zero API writes', async t => {
  for (const expected of [
    { title: 'Outdated title', description: 'Old description' },
    { title: 'Old title', description: 'Outdated description' },
    { title: input.title, description: 'Old description' },
  ]) {
    const state = fixture(t);
    await assert.rejects(createSeoPullRequest({ ...input, expected }), /evidencia SEO está desactualizada/);
    assert.equal(state.mutations().length, 0);
    assert.equal(state.refs.has(state.branch), false);
    t.mock.restoreAll();
  }
});

test('HTML baseline comparison decodes entities once, preserves case semantics and normalizes audited whitespace', async t => {
  const html = '<head><title>  Caf&eacute; &amp; &#x1F680; &amp;lt; &#128;  </title><meta name="description" content="&NotEqualTilde; &quot;Bogot&aacute;&quot; &notit; &copy=legacy"></head>';
  const expected = { title: 'Café & 🚀 &lt; €', description: '≂̸ "Bogotá" &notit; &copy=legacy' };
  const state = fixture(t, { html });
  assert.equal((await createSeoPullRequest({ ...input, expected })).number, 17);
  assert.equal(state.contents, updateSeoMetadata(html, input.title, input.description));
});

test('missing HTML metadata matches empty audited fields and may be added', async t => {
  const state = fixture(t, { html: '<head></head><body>Keep</body>' });
  await createSeoPullRequest({ ...input, expected: { title: '', description: '' } });
  assert.equal(state.contents, updateSeoMetadata('<head></head><body>Keep</body>', input.title, input.description));
});

test('possibly truncated HTML baseline evidence is never silently accepted', async t => {
  for (const [title, description, expected] of [
    ['T'.repeat(501), 'D', { title: 'T'.repeat(500), description: 'D' }],
    ['T', 'D'.repeat(1001), { title: 'T', description: 'D'.repeat(1000) }],
  ]) {
    const state = fixture(t, { html: `<head><title>${title}</title><meta name="description" content="${description}"></head>` });
    await assert.rejects(createSeoPullRequest({ ...input, expected }), /desactualizada/);
    assert.equal(state.mutations().length, 0);
    t.mock.restoreAll();
  }
});

test('Next baseline compares decoded literal values and rejects published/build overrides before writing', async t => {
  const run = { ...input, target: { ...target, path: 'src/app/layout.tsx' } };
  for (const expected of [
    { title: 'Published page override', description: 'Descripción anterior de Altorena' },
    { title: 'Altorena — título anterior', description: 'Published description override' },
  ]) {
    const state = fixture(t, { input: run, html: altorenaSource });
    await assert.rejects(createSeoPullRequest({ ...run, expected }), /desactualizada.*compilación/);
    assert.equal(state.mutations().length, 0);
    t.mock.restoreAll();
  }
  const html = String.raw`const title = 'Caf\u00e9'; const description = 'D\x26D'; export const metadata = {title, description};`;
  const state = fixture(t, { input: run, html });
  assert.equal((await createSeoPullRequest({ ...run, expected: { title: 'Café', description: 'D&D' } })).number, 17);
  assert.equal(state.contents, await updateNextSeoMetadata(html, run.title, run.description));
});

test('already-desired metadata is accepted despite an old baseline without any writes', async t => {
  const expected = { title: 'Old audited title', description: 'Old audited description' };
  for (const [path, html] of [
    ['public/index.html', updateSeoMetadata(originalHtml, input.title, input.description)],
    ['app/layout.tsx', `export const metadata = {title: ${JSON.stringify(input.title)}, description: ${JSON.stringify(input.description)}};`],
  ]) {
    const run = { ...input, target: { ...target, path }, expected };
    const state = fixture(t, { input: run, html });
    await assert.rejects(createSeoPullRequest(run), /ya coinciden/);
    assert.equal(state.mutations().length, 0);
    t.mock.restoreAll();
  }
});

test('known PR retries reconcile before reading or checking a stale baseline', async t => {
  const state = fixture(t);
  state.prs.push(state.pr());
  const result = await createSeoPullRequest({ ...input, expected: { title: 'No longer current', description: 'Outdated evidence' } });
  assert.equal(result.number, 17);
  assert.equal(state.calls.length, 1);
  assert.equal(state.mutations().length, 0);
});

test('creates one verified metadata commit and standard PR on a deterministic branch; retry is read-only', async t => {
  const state = fixture(t);
  const result = await createSeoPullRequest(input);
  assert.deepEqual(result, { url: 'https://github.com/owner/site/pull/17', number: 17, branch: state.branch });
  assert.match(result.branch, /^seo-studio\/[a-f0-9-]{36}-[a-f0-9]{24}$/);
  assert.equal(state.contents, updateSeoMetadata(originalHtml, input.title, input.description));
  assert.equal(state.refs.get('main'), state.sourceSha);
  assert.deepEqual(state.mutations().map(call => [call.method, call.path]), [['POST', '/git/refs'], ['PUT', '/contents/public/index.html'], ['POST', '/pulls']]);
  assert.equal(new Set(state.calls.map(call => call.signal)).size, state.calls.length, 'each fetch has its own timeout');
  const before = state.calls.length;
  assert.deepEqual(await createSeoPullRequest({ ...input, title: 'Retry text must not overwrite' }), result);
  assert.equal(state.calls.length, before + 1);
  assert.equal(state.mutations().length, 3);
});

test('deterministic target identity includes URL, repository, base branch and path but not generated text', async t => {
  const observed = [];
  for (const configured of [target, { ...target, url: 'https://example.com/another' }, { ...target, repository: 'owner/another' }, { ...target, branch: 'release/v1' }, { ...target, path: 'other.html' }]) {
    const run = { ...input, target: configured };
    const state = fixture(t, { input: run });
    await createSeoPullRequest(run);
    observed.push(state.branch);
    t.mock.restoreAll();
  }
  assert.equal(new Set(observed).size, 5);
});

test('canonical aliases preserve branch identity, and source branch movement does not change the pinned file', async t => {
  const run = { ...input, runId: input.runId.toUpperCase(), target: { ...target, repository: 'Owner/Site', url: 'https://EXAMPLE.com:443/#top' } };
  const state = fixture(t, { input: run, onRequest: ({ path, state }) => {
    if (path === `/git/commits/${state.sourceSha}`) state.refs.set('main', hash('later base commit'));
  } });
  const result = await createSeoPullRequest(run);
  assert.equal(result.branch, branchFor(input));
  assert.equal(state.refs.get('main'), hash('later base commit'));
  assert.equal(state.calls.find(call => call.method === 'POST' && call.path === '/git/refs').body.sha, state.sourceSha);
});

test('connector preserves BOM and exact desired UTF-8 metadata in the uploaded bytes', async t => {
  const run = { ...input, title: '  Café & té 🥐  ', description: 'Descripción exacta: "Bogotá" &amp; <texto>  ' };
  const html = '\ufeff<head><meta charset="utf-8"><title>Antes</title><meta name="description" content="Antes"></head><body>Intacto 🌍</body>';
  const state = fixture(t, { input: run, html });
  await createSeoPullRequest(run);
  assert.equal(state.contents, '\ufeff<head><meta charset="utf-8"><title>  Café &amp; té 🥐  </title><meta name="description" content="Descripción exacta: &quot;Bogotá&quot; &amp;amp; &lt;texto&gt;  "></head><body>Intacto 🌍</body>');
  assert.deepEqual([...Buffer.from(state.contents).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('existing closed or merged PRs dedupe without reading a branch or using upstream URLs', async t => {
  const state = fixture(t);
  state.prs.push(state.pr({ state: 'closed', merged_at: '2026-10-20T00:00:00Z', html_url: 'https://evil.example/secret' }));
  assert.equal((await createSeoPullRequest(input)).url, 'https://github.com/owner/site/pull/17');
  assert.equal(state.calls.length, 1);
  assert.equal(state.mutations().length, 0);
});

test('unknown existing branch is never overwritten, even if it points to the source commit', async t => {
  const state = fixture(t);
  state.refs.set(state.branch, state.sourceSha);
  await assert.rejects(createSeoPullRequest(input), /ya existe.*No se confirmó un PR.*rama huérfana/i);
  assert.equal(state.calls.filter(call => call.path === '/pulls').length, 4);
  assert.equal(state.mutations().length, 0);
});

test('PR matches require exact repository, source branch, target branch and a positive safe number', async t => {
  for (const overrides of [
    { head: { ref: branchFor(input), repo: { full_name: 'fork/site' } } },
    { base: { ref: 'other', repo: { full_name: target.repository } } },
    { base: { ref: 'main', repo: { full_name: 'owner/other' } } },
    { head: { ref: 'wrong', repo: { full_name: target.repository } } },
    { number: -1 }, { number: 1.5 }, { number: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const state = fixture(t, { onRequest: ({ path }) => path.startsWith('/git/ref/') ? json({ message: 'blocked after unmatched PR' }, 403) : undefined });
    state.prs.push(state.pr(overrides));
    await assert.rejects(createSeoPullRequest(input));
    assert.equal(state.mutations().length, 0);
    t.mock.restoreAll();
  }
});

test('ambiguous PR lists fail closed without mutation', async t => {
  const state = fixture(t);
  state.prs.push(state.pr(), state.pr({ number: 18 }));
  await assert.rejects(createSeoPullRequest(input), /Varios pull requests/);
  assert.equal(state.mutations().length, 0);
});

test('racing branch creation returns the winner PR after a bounded recheck, with no content write', async t => {
  let collided = false;
  let rechecks = 0;
  const state = fixture(t, { onRequest: ({ path, method, state }) => {
    if (path === '/git/refs' && method === 'POST') { collided = true; return json({ message: 'secret upstream conflict' }, 422); }
    if (path === '/pulls' && method === 'GET' && collided && ++rechecks === 2) state.prs.push(state.pr());
  } });
  assert.equal((await createSeoPullRequest(input)).number, 17);
  assert.equal(rechecks, 2);
  assert.deepEqual(state.mutations().map(call => call.path), ['/git/refs']);
});

test('a racing branch creation without a known PR stops after three rechecks', async t => {
  const state = fixture(t, { onRequest: ({ path, method }) => path === '/git/refs' && method === 'POST' ? json({ message: 'SECRET upstream data' }, 409) : undefined });
  await assert.rejects(createSeoPullRequest(input), error => {
    assert.match(error.message, /HTTP 409.*No se confirmó un PR/s);
    assert.doesNotMatch(error.message, /SECRET|test-token/);
    return true;
  });
  assert.equal(state.calls.filter(call => call.path === '/pulls').length, 4);
  assert.deepEqual(state.mutations().map(call => call.method), ['POST']);
});

test('lost successful PR response is recovered read-only without a second PR create', async t => {
  const state = fixture(t, { onRequest: ({ path, method, respond }) => {
    if (path === '/pulls' && method === 'POST') { respond(); throw new Error('SECRET network failure test-token-not-real'); }
  } });
  assert.equal((await createSeoPullRequest(input)).number, 17);
  assert.equal(state.prs.length, 1);
  assert.equal(state.calls.filter(call => call.path === '/pulls' && call.method === 'POST').length, 1);
});

test('PR creation conflict returns only a verified existing PR', async t => {
  const state = fixture(t, { onRequest: ({ path, method, state }) => {
    if (path === '/pulls' && method === 'POST') { state.prs.push(state.pr()); return json({ message: 'already exists' }, 422); }
  } });
  assert.equal((await createSeoPullRequest(input)).number, 17);
  assert.equal(state.mutations().length, 3);
});

test('content conflict leaves the base untouched and does not open a PR or force-update refs', async t => {
  const state = fixture(t, { onRequest: ({ method }) => method === 'PUT' ? json({ message: 'SECRET sha conflict' }, 409) : undefined });
  await assert.rejects(createSeoPullRequest(input), /HTTP 409.*No se confirmó un PR/s);
  assert.equal(state.refs.get('main'), state.sourceSha);
  assert.equal(state.contents, originalHtml);
  assert.equal(state.calls.filter(call => call.path === '/pulls' && call.method === 'POST').length, 0);
  assert.ok(state.calls.every(call => !['PATCH', 'DELETE'].includes(call.method)));
});

test('movement of the newly created branch aborts before content mutation', async t => {
  const state = fixture(t, { onRequest: ({ path, method, state, respond }) => {
    if (path === '/git/refs' && method === 'POST') { const response = respond(); state.refs.set(state.branch, hash('other actor commit')); return response; }
  } });
  await assert.rejects(createSeoPullRequest(input), /confirmar la escritura SEO con seguridad/);
  assert.deepEqual(state.mutations().map(call => call.path), ['/git/refs']);
});

test('write verification catches an unexpected parent commit before opening a PR', async t => {
  const state = fixture(t, { onRequest: async ({ method, respond }) => {
    if (method === 'PUT') { const data = await respond().json(); data.commit.parents[0].sha = hash('unexpected parent'); return json(data); }
  } });
  await assert.rejects(createSeoPullRequest(input), /confirmar la escritura SEO con seguridad/);
  assert.equal(state.calls.filter(call => call.path === '/pulls' && call.method === 'POST').length, 0);
  assert.equal(state.refs.get('main'), state.sourceSha);
});

test('unchanged metadata avoids all writes', async t => {
  const state = fixture(t, { html: updateSeoMetadata(originalHtml, input.title, input.description) });
  await assert.rejects(createSeoPullRequest(input), /ya coinciden/);
  assert.equal(state.mutations().length, 0);
});

test('links, submodules and truncated trees cannot be used as HTML targets', async t => {
  for (const change of [{ mode: '120000' }, { mode: '160000', type: 'commit' }, { truncated: true }]) {
    const state = fixture(t, { onRequest: async ({ path, respond }) => {
      if (path.startsWith('/git/trees/')) {
        const data = await respond().json();
        if (change.truncated) data.truncated = true;
        else Object.assign(data.tree[0], change);
        return json(data);
      }
    } });
    await assert.rejects(createSeoPullRequest(input), /archivo regular|árbol de origen completo/);
    assert.equal(state.mutations().length, 0);
    assert.ok(state.calls.every(call => !call.path.startsWith('/git/blobs/')));
    t.mock.restoreAll();
  }
});

test('source blob requires bounded content with exact size, hash and base64', async t => {
  for (const change of [
    { sha: hash('other blob') }, { size: MAX_SOURCE_BYTES + 1 },
    { size: 0 }, { encoding: 'none' }, { content: '!!!' }, { content: Buffer.from('<head></head>').toString('base64') },
    { target: 'secret.txt' }, { submodule_git_url: 'https://example.com/other' },
  ]) {
    const state = fixture(t, { onRequest: ({ path, method, state }) => path.startsWith('/git/blobs/') && method === 'GET' ? json({ ...state.content(), ...change }) : undefined });
    await assert.rejects(createSeoPullRequest(input), /El origen debe|bytes de origen/);
    assert.equal(state.mutations().length, 0);
    t.mock.restoreAll();
  }
});

test('HTML above 1 MiB is read by immutable Git blob and updated without touching embedded image bytes', async t => {
  const imageData = 'A'.repeat(1_150_000);
  const html = `<head><title>Old title</title><meta name="description" content="Old description"></head><body><img src="data:image/png;base64,${imageData}"></body>`;
  const state = fixture(t, { html });
  await createSeoPullRequest({ ...input, expected: { title: 'Old title', description: 'Old description' } });
  assert.equal(state.contents, updateSeoMetadata(html, input.title, input.description));
  assert.ok(state.contents.includes(imageData));
  assert.equal(state.calls.filter(call => call.path === `/git/blobs/${state.blobSha}`).length, 1);
  assert.equal(state.calls.filter(call => call.path.startsWith('/contents/') && call.method === 'GET').length, 0);
  assert.equal(state.refs.get('main'), state.sourceSha);
});

test('a tree declaring more than 16 MiB rejects the source before blob download or mutation', async t => {
  const state = fixture(t, { onRequest: async ({ path, respond }) => {
    if (path.startsWith('/git/trees/')) {
      const data = await respond().json();
      if (data.tree[0].type === 'blob') data.tree[0].size = MAX_SOURCE_BYTES + 1;
      return json(data);
    }
  } });
  await assert.rejects(createSeoPullRequest(input), /hasta 16 MiB/);
  assert.equal(state.mutations().length, 0);
  assert.ok(state.calls.every(call => !call.path.startsWith('/git/blobs/')));
});

test('binary, invalid UTF-8 and non-HTML source files are rejected before branch creation', async t => {
  for (const html of [Buffer.from([0xff, 0xfe, 0x3c]), '<head>\0</head>', 'ordinary text', '<head></head><head></head>']) {
    const state = fixture(t, { html });
    await assert.rejects(createSeoPullRequest(input), /UTF-8|metadatos HTML/);
    assert.equal(state.mutations().length, 0);
    t.mock.restoreAll();
  }
});

test('source ref identity must exactly match the requested branch', async t => {
  const state = fixture(t, { onRequest: ({ path, state }) => path === '/git/ref/heads/main' ? json(state.ref('unexpected', state.sourceSha)) : undefined });
  await assert.rejects(createSeoPullRequest(input), /identidad de rama diferente/);
  assert.equal(state.mutations().length, 0);
});

test('invalid inputs and absent credentials stop before any fetch', async t => {
  environment(t, undefined);
  t.mock.method(globalThis, 'fetch', () => assert.fail('must not fetch'));
  await assert.rejects(createSeoPullRequest(input), /Configura SEO_GITHUB_TOKEN/);
  process.env.SEO_GITHUB_TOKEN = 'invalid\ntoken';
  await assert.rejects(createSeoPullRequest(input), /Configura SEO_GITHUB_TOKEN/);
  process.env.SEO_GITHUB_TOKEN = 'test-token';
  for (const change of [
    { title: '' }, { description: 'x'.repeat(321) }, { brandName: 'line\nbreak' },
    { runId: '../another' }, { runId: 'not-a-uuid' }, { target: { ...target, path: '.github/attack.html' } },
    { target: { ...target, token: 'injected-credential' } },
  ]) await assert.rejects(createSeoPullRequest({ ...input, ...change }));
});

test('HTTP failures are actionable and never expose the upstream body or token', async t => {
  for (const status of [301, 401, 403, 404, 409, 422, 429, 500, 503]) {
    const state = fixture(t, { onRequest: () => json({ message: 'SECRET private body test-token-not-real', token: 'secret' }, status) });
    await assert.rejects(createSeoPullRequest(input), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /SECRET|private body|test-token-not-real/);
      return true;
    });
    assert.equal(state.calls.length, 1);
    assert.equal(state.mutations().length, 0);
    t.mock.restoreAll();
  }
});

test('each fetch uses a 15-second timeout and abort errors are sanitized', async t => {
  let timeouts = 0;
  t.mock.method(AbortSignal, 'timeout', duration => { assert.equal(duration, 15_000); timeouts++; return AbortSignal.abort(new Error('SECRET abort reason')); });
  const state = fixture(t, { onRequest: ({ signal }) => { signal.throwIfAborted(); } });
  await assert.rejects(createSeoPullRequest(input), error => {
    assert.match(error.message, /falló o agotó el tiempo/);
    assert.doesNotMatch(error.message, /SECRET|abort reason/);
    return true;
  });
  assert.equal(timeouts, 1);
  assert.equal(state.mutations().length, 0);
});

test('malformed and oversized API responses fail closed with sanitized errors', async t => {
  for (const response of [() => new Response('SECRET invalid JSON'), () => new Response('x'.repeat(24 * 1024 * 1024 + 1))]) {
    const state = fixture(t, { onRequest: response });
    await assert.rejects(createSeoPullRequest(input), error => {
      assert.match(error.message, /GitHub: la solicitud falló/);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
    assert.equal(state.mutations().length, 0);
    t.mock.restoreAll();
  }
});
