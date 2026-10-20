import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { seoGoogleError } from './seo-google-errors.ts';

// Keep the real OAuth/database flow, but never import Meta's runtime/env module
// or require encryption secrets. This follows the existing SEO test loader.
const dataModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const tokenModule = dataModule(`
  export async function encryptInstagramToken(token) { return 'sealed:' + token; }
  export async function decryptInstagramToken(token) {
    if (!token.startsWith('sealed:')) throw new Error('private ciphertext / decryption details');
    return token.slice(7);
  }
`);
let source = stripTypeScriptTypes(readFileSync(new URL('./seo-google.ts', import.meta.url), 'utf8'));
for (const [alias, url] of Object.entries({
  '@/lib/meta': tokenModule,
  '@/lib/seo-google-errors': new URL('./seo-google-errors.ts', import.meta.url).href,
})) {
  assert.ok(source.includes(JSON.stringify(alias)), `Missing mocked dependency: ${alias}`);
  source = source.replaceAll(JSON.stringify(alias), JSON.stringify(url));
}
const helperUrl = dataModule(source);
const { readGoogleBusinessDescription, updateGoogleBusinessDescription, validateGoogleBusinessDescription, googleCapabilities, googleResources, googleSnapshot, storeGoogleToken } = await import(helperUrl);

const callbackHelpersUrl = dataModule(`
  export { googleCapabilities, googleResources, storeGoogleToken } from ${JSON.stringify(helperUrl)};
  export const configuration = { configured: true, callback: 'https://app.example/api/seo/google', error: '' };
  export const googleConfigured = () => configuration.configured;
  export function seoGoogleCallback() { if (configuration.error) throw new Error(configuration.error); return configuration.callback; }
`);
const { configuration } = await import(callbackHelpersUrl);
const callbackSource = stripTypeScriptTypes(readFileSync(new URL('../app/api/seo/google/route.ts', import.meta.url), 'utf8'))
  .replace('import { env } from "@/lib/runtime";', 'export const env = { DB: null };')
  .replace('import { ensureSeo } from "@/lib/seo";', 'const ensureSeo = async () => {};')
  .replace('"@/lib/seo-google"', JSON.stringify(callbackHelpersUrl));
const callback = await import(dataModule(callbackSource));

const owner = 'owner-a';
const location = 'accounts/account_A-1/locations/location_B-2';
const name = 'locations/location_B-2';
const host = 'mybusinessbusinessinformation.googleapis.com';
const base = `https://${host}/v1/`;
const readUrl = `${base}${name}?readMask=name,profile`;
const patchUrl = `${base}${name}?updateMask=profile.description`;
const oauthUrl = 'https://oauth2.googleapis.com/token';
const sitesUrl = 'https://www.googleapis.com/webmasters/v3/sites';
const accountsUrl = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20';
const access = { access_token: 'access-owner-a' };
const profile = description => ({ name, profile: { description } });
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const failure = status => response({ error: { message: 'private upstream token and description' } }, status);

function harness(t, steps, rows = { [owner]: 'sealed:refresh-owner-a', 'owner-b': 'sealed:refresh-owner-b' }) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE seo_google(owner_id TEXT PRIMARY KEY, refresh_token TEXT NOT NULL, connected_at INTEGER NOT NULL);
    CREATE TABLE seo_google_states(state TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE seo_settings(brand_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, search_property TEXT, google_location TEXT);`);
  for (const [id, token] of Object.entries(rows)) sql.prepare('INSERT INTO seo_google VALUES(?,?,0)').run(id, token);
  t.after(() => sql.close());
  const queries = [];
  const calls = [];
  const timeouts = [];
  const db = {
    prepare(statement) {
      const query = { sql: statement, args: [] };
      queries.push(query);
      return {
        bind(...args) { query.args = args; return this; },
        async first() {
          return sql.prepare(statement).get(...query.args) ?? null;
        },
        async run() { const result = sql.prepare(statement).run(...query.args); return { success: true, meta: { changes: result.changes } }; },
      };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sql.exec('COMMIT');
        return results;
      } catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  t.mock.method(AbortSignal, 'timeout', ms => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const step = steps[calls.length];
    calls.push({ url: String(url), ...init });
    if (step instanceof Error) throw step;
    if (step === undefined) throw new Error('Unexpected network request');
    return step instanceof Response ? step : response(step);
  });
  t.after(() => {
    assert.equal(calls.length, steps.length, 'All and only the expected requests should run');
    assert.deepEqual(timeouts, calls.map(call => call.url === oauthUrl && call.body?.get('grant_type') !== 'authorization_code' ? 15_000 : 20_000));
    for (const call of calls) {
      assert.ok(call.signal instanceof AbortSignal);
      assert.equal(call.redirect, 'error', 'Never follow redirects with owner credentials');
      if (call.url !== oauthUrl) assert.equal(call.cache, 'no-store');
    }
  });
  return { db, calls, queries, sql };
}

function sanitized(error) {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, /private|upstream|ciphertext|refresh-owner|access-owner|published|publicad[oa]|maps/i);
  return true;
}

test('reads the exact description with the owner-scoped decrypted token and minimal mask', async t => {
  const original = '  Café de barrio.\nPan artesanal.  ';
  const { db, queries, calls } = harness(t, [{ access_token: 'access-owner-b' }, profile(original)]);
  assert.equal(await readGoogleBusinessDescription(db, 'owner-b', location), original);
  assert.deepEqual(queries.filter(query => query.sql.startsWith('SELECT')).map(query => query.args), [['owner-b'], ['owner-b']]);
  assert.equal(calls[0].url, oauthUrl);
  assert.equal(calls[0].method, 'POST');
  assert.ok(calls[0].body instanceof URLSearchParams);
  assert.equal(calls[0].body.get('refresh_token'), 'refresh-owner-b');
  assert.equal(calls[0].body.get('grant_type'), 'refresh_token');
  assert.equal(calls[1].url, readUrl);
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].headers.Authorization, 'Bearer access-owner-b');
  assert.equal(calls[1].body, undefined);
});

test('trims the desired text, patches only profile.description and verifies exact persistence', async t => {
  const { db, calls, queries } = harness(t, [access, profile('Original'), profile('Saved'), profile('Saved')]);
  assert.deepEqual(await updateGoogleBusinessDescription(db, owner, location, ' \nSaved\t ', 'Original'), { description: 'Saved' });
  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [[oauthUrl, 'POST'], [readUrl, 'GET'], [patchUrl, 'PATCH'], [readUrl, 'GET']]);
  assert.deepEqual(JSON.parse(calls[2].body), { name, profile: { description: 'Saved' } });
  assert.equal(calls[2].headers['content-type'], 'application/json');
  assert.equal(queries.filter(query => query.sql.startsWith('SELECT refresh_token')).length, 1, 'Reuse one owner access token throughout the operation');
  for (const call of calls.slice(1)) assert.equal(call.headers.Authorization, 'Bearer access-owner-a');
});

test('already-applied desired text succeeds without PATCH even with stale expected text', async t => {
  const { db, calls } = harness(t, [access, profile('Desired')]);
  assert.deepEqual(await updateGoogleBusinessDescription(db, owner, location, ' Desired ', 'Old'), { description: 'Desired' });
  assert.ok(calls.every(call => call.method !== 'PATCH'));
});

for (const current of ['Edited elsewhere', ' Original ', 'Original\n']) {
  test(`conflict never overwrites the exact current value ${JSON.stringify(current)}`, async t => {
    const { db, calls } = harness(t, [access, profile(current)]);
    await assert.rejects(updateGoogleBusinessDescription(db, owner, location, 'Desired', 'Original'), error => {
      sanitized(error);
      assert.match(error.message, /cambió en otro lugar.*Vuelve a cargarla/);
      return true;
    });
    assert.ok(calls.every(call => call.method !== 'PATCH'));
  });
}

test('restores an originally empty description and accepts an omitted profile on read-back', async t => {
  const { db, calls } = harness(t, [access, profile('Written description'), { name }, { name }]);
  assert.deepEqual(await updateGoogleBusinessDescription(db, owner, location, '', 'Written description'), { description: '' });
  assert.deepEqual(JSON.parse(calls[2].body), { name, profile: { description: '' } });
});

test('empty desired text is idempotent after trimming', async t => {
  const { db } = harness(t, [access, { name, profile: {} }]);
  assert.deepEqual(await updateGoogleBusinessDescription(db, owner, location, ' \n ', 'Previous'), { description: '' });
});

test('writes from an empty expected value and allows exactly 750 characters after trim', async t => {
  const desired = 'á'.repeat(750);
  const { db } = harness(t, [access, { name }, profile(desired), profile(desired)]);
  assert.deepEqual(await updateGoogleBusinessDescription(db, owner, location, ` ${desired} `, ''), { description: desired });
});

test('reads an absent description as empty without normalizing stored text', async t => {
  const { db } = harness(t, [access, { name, profile: {} }]);
  assert.equal(await readGoogleBusinessDescription(db, owner, location), '');
});

test('validates location paths before accessing credentials or the network', async t => {
  const { db, queries } = harness(t, []);
  for (const invalid of [undefined, null, 123, '', name, 'https://evil.invalid/locations/1',
    'accounts/a/locations/../x', 'accounts/a/locations/x?readMask=*', 'accounts/a/locations/x#fragment',
    'accounts/a/locations/x/extra', 'accounts/a/locations/%2F', 'accounts//locations/x',
    'accounts/a/locations/x\n', 'accounts/a/locations/x\r', ' accounts/a/locations/x',
    'accounts/a\\b/locations/x', 'accounts/á/locations/x']) {
    await assert.rejects(readGoogleBusinessDescription(db, owner, invalid), /ubicación válida/);
    await assert.rejects(updateGoogleBusinessDescription(db, owner, invalid, 'Desired', ''), /ubicación válida/);
  }
  assert.equal(queries.length, 0);
});

test('rejects excessive length, HTML, angle brackets, controls and hyperlinks before authentication', async t => {
  const { db, queries } = harness(t, []);
  for (const invalid of [null, undefined, 42, {}, 'a'.repeat(751), '<b>Text</b>', 'A > B', 'A < B',
    'Text\u0000more', 'Go to https://example.com', 'HTTP://EXAMPLE.COM', 'www.example.com',
    'example.com', 'example.co.uk/menu', 'Visita café.es', 'xn--caf-dma.com', '//example.com',
    'ftp://example.com', 'mailto:hello@example.com', 'tel:1234567', '[More](/menu)']) {
    await assert.rejects(updateGoogleBusinessDescription(db, owner, location, invalid, 'Original'), /texto plano|750/);
  }
  for (const expected of [undefined, null, 5, {}]) {
    await assert.rejects(updateGoogleBusinessDescription(db, owner, location, '', expected), /Vuelve a leer/);
  }
  assert.equal(queries.length, 0);
});

for (const payload of [null, {}, { name: 'locations/someone-else', profile: { description: 'Original' } },
  { name, profile: null }, { name, profile: [] }, { name, profile: 'Original' }, profile(null), profile(23)]) {
  test(`malformed preflight profile cannot authorize a write: ${JSON.stringify(payload)}`, async t => {
    const { db } = harness(t, [access, payload]);
    await assert.rejects(updateGoogleBusinessDescription(db, owner, location, 'Desired', ''), /forma fiable/);
  });
}

test('does not borrow another owner token when the requested owner has no connection', async t => {
  const { db, queries } = harness(t, []);
  await assert.rejects(updateGoogleBusinessDescription(db, 'missing-owner', location, 'Desired', 'Original'), /Conecta Google/);
  assert.deepEqual(queries.filter(query => query.sql.startsWith('SELECT')).map(query => query.args), [['missing-owner'], ['missing-owner']]);
});

test('handles undecryptable owner credentials without leaking token data or calling Google', async t => {
  const { db } = harness(t, [], { [owner]: 'broken private encrypted token' });
  await assert.rejects(readGoogleBusinessDescription(db, owner, location), error => {
    sanitized(error);
    assert.match(error.message, /Reconecta Google/);
    return true;
  });
});

for (const stage of ['read', 'patch', 'verify']) {
  for (const status of [401, 403, 429, 500]) {
    test(`${stage} HTTP ${status} uses sanitized service diagnostics and cannot report success`, async t => {
      const steps = [access];
      if (stage !== 'read') steps.push(profile('Original'));
      if (stage === 'verify') steps.push(profile('Desired'));
      steps.push(failure(status));
      const { db } = harness(t, steps);
      await assert.rejects(updateGoogleBusinessDescription(db, owner, location, 'Desired', 'Original'), error => {
        sanitized(error);
        assert.ok(error.message.includes(seoGoogleError(status, host, {})));
        if (stage !== 'read') assert.match(error.message, /pendiente.*incierto.*antes de reintentar/);
        return true;
      });
    });
  }
}

for (const status of [400, 401, 403, 429, 500]) {
  test(`OAuth HTTP ${status} prevents profile calls and exposes no upstream payload`, async t => {
    const { db } = harness(t, [failure(status)]);
    await assert.rejects(updateGoogleBusinessDescription(db, owner, location, 'Desired', 'Original'), error => {
      sanitized(error);
      assert.match(error.message, /Reconecta Google/);
      return true;
    });
  });
}

for (const payload of [null, {}, { access_token: 42 }, { access_token: '' }, { access_token: '  ' }]) {
  test(`malformed OAuth token cannot authorize a profile call: ${JSON.stringify(payload)}`, async t => {
    const { db } = harness(t, [payload]);
    await assert.rejects(readGoogleBusinessDescription(db, owner, location), /Google no entregó acceso/);
  });
}

for (const stage of ['oauth', 'read', 'patch', 'verify']) {
  test(`${stage} timeout or transport error is sanitized and never retried automatically`, async t => {
    const steps = stage === 'oauth' ? [] : [access];
    if (['patch', 'verify'].includes(stage)) steps.push(profile('Original'));
    if (stage === 'verify') steps.push(profile('Desired'));
    steps.push(new DOMException('private upstream access-owner-a', 'TimeoutError'));
    const { db } = harness(t, steps);
    await assert.rejects(updateGoogleBusinessDescription(db, owner, location, 'Desired', 'Original'), error => {
      sanitized(error);
      if (['patch', 'verify'].includes(stage)) assert.match(error.message, /pendiente.*incierto/);
      else assert.match(error.message, /Reconecta Google|contactar con Google/);
      return true;
    });
  });
}

for (const stage of ['oauth', 'read', 'verify']) {
  test(`${stage} invalid JSON cannot leak the upstream body`, async t => {
    const steps = stage === 'oauth' ? [] : [access];
    if (stage === 'verify') steps.push(profile('Original'), profile('Desired'));
    steps.push(new Response('private upstream access-owner-a'));
    const { db } = harness(t, steps);
    await assert.rejects(updateGoogleBusinessDescription(db, owner, location, 'Desired', 'Original'), sanitized);
  });
}

for (const payload of [null, { error: { errors: 'private upstream' } }, { error: { details: [null] } }]) {
  test(`malformed Google errors retain sanitized HTTP status: ${JSON.stringify(payload)}`, async t => {
    const { db } = harness(t, [access, response(payload, 403)]);
    await assert.rejects(readGoogleBusinessDescription(db, owner, location), error => {
      sanitized(error);
      assert.equal(error.message, seoGoogleError(403, host, {}));
      return true;
    });
  });
}

test('Google scope diagnostics are preserved without echoing arbitrary messages', async t => {
  const payload = { error: { message: 'private upstream', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } };
  const { db } = harness(t, [access, response(payload, 403)]);
  await assert.rejects(readGoogleBusinessDescription(db, owner, location), error => {
    sanitized(error);
    assert.equal(error.message, seoGoogleError(403, host, payload));
    return true;
  });
});

test('non-JSON HTTP errors still use sanitized status diagnostics', async t => {
  const { db } = harness(t, [access, new Response('private upstream HTML', { status: 503 })]);
  await assert.rejects(readGoogleBusinessDescription(db, owner, location), error => {
    sanitized(error);
    assert.equal(error.message, seoGoogleError(503, host, {}));
    return true;
  });
});

test('a successful PATCH with an empty body still requires a fresh verification GET', async t => {
  const { db } = harness(t, [access, profile('Original'), new Response(null, { status: 204 }), profile('Desired')]);
  assert.deepEqual(await updateGoogleBusinessDescription(db, owner, location, 'Desired', 'Original'), { description: 'Desired' });
});

for (const stored of ['Original', 'Desired ', 'Different edit', '']) {
  test(`PATCH acceptance is insufficient when read-back differs: ${JSON.stringify(stored)}`, async t => {
    const { db } = harness(t, [access, profile('Original'), profile('Desired'), profile(stored)]);
    await assert.rejects(updateGoogleBusinessDescription(db, owner, location, 'Desired', 'Original'), error => {
      sanitized(error);
      assert.match(error.message, /pendiente.*incierto.*Vuelve a leer.*antes de reintentar/);
      return true;
    });
  });
}

test('malformed verification data is uncertain rather than a successful empty restoration', async t => {
  const { db } = harness(t, [access, profile('Original'), profile(''), {}]);
  await assert.rejects(updateGoogleBusinessDescription(db, owner, location, '', 'Original'), /pendiente.*incierto/);
});

for (const services of [{ search: true }, { search: true, business: false }]) {
  test(`Search Console-only resources never consume Business quota: ${JSON.stringify(services)}`, async t => {
    const properties = [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }];
    const { db, calls } = harness(t, [access, { siteEntry: properties }]);
    assert.deepEqual(await googleResources(db, owner, services), { properties, locations: [], errors: [] });
    assert.deepEqual(calls.map(call => call.url), [oauthUrl, sitesUrl]);
  });
}

for (const services of [{ business: true }, { search: false, business: true }]) {
  test(`Business-only resources preserve account/location pagination: ${JSON.stringify(services)}`, async t => {
    const first = { name: 'locations/one', title: 'One', websiteUri: 'https://example.com' };
    const second = { name: 'locations/two', title: 'Two' };
    const third = { name: 'locations/three', title: 'Three' };
    const { db, calls } = harness(t, [access,
      { accounts: [{ name: 'accounts/first' }], nextPageToken: 'account +/&' },
      { locations: [first], nextPageToken: 'location +/&' }, { locations: [second] },
      { accounts: [{ name: 'accounts/second' }] }, { locations: [third] },
    ]);
    assert.deepEqual(await googleResources(db, owner, services), {
      properties: [], errors: [], locations: [
        { ...first, name: `accounts/first/${first.name}` },
        { ...second, name: `accounts/first/${second.name}` },
        { ...third, name: `accounts/second/${third.name}` },
      ],
    });
    const firstLocations = `${base}accounts/first/locations?readMask=name,title,websiteUri&pageSize=100`;
    assert.deepEqual(calls.map(call => call.url), [oauthUrl, accountsUrl, firstLocations,
      `${firstLocations}&pageToken=${encodeURIComponent('location +/&')}`,
      `${accountsUrl}&pageToken=${encodeURIComponent('account +/&')}`,
      `${base}accounts/second/locations?readMask=name,title,websiteUri&pageSize=100`,
    ]);
  });
}

test('default resources still read both services and retain partial data and service errors', async t => {
  const properties = [{ siteUrl: 'https://example.com/', permissionLevel: 'siteFullUser' }];
  const { db, calls } = harness(t, [access, { siteEntry: properties }, failure(429)]);
  assert.deepEqual(await googleResources(db, owner), {
    properties, locations: [], errors: [seoGoogleError(429, 'mybusinessaccountmanagement.googleapis.com', {})],
  });
  assert.deepEqual(calls.map(call => call.url), [oauthUrl, sitesUrl, accountsUrl]);
});

test('default resources still query Business after Search Console fails', async t => {
  const { db, calls } = harness(t, [access, failure(403), { accounts: [] }]);
  assert.deepEqual(await googleResources(db, owner, undefined), {
    properties: [], locations: [], errors: [seoGoogleError(403, 'www.googleapis.com', {})],
  });
  assert.deepEqual(calls.map(call => call.url), [oauthUrl, sitesUrl, accountsUrl]);
});

test('selecting neither service returns the existing shape without credentials or network calls', async t => {
  const { db, queries } = harness(t, []);
  for (const services of [{}, { search: false }, { business: false }, { search: false, business: false }]) {
    assert.deepEqual(await googleResources(db, 'not-connected', services), { properties: [], locations: [], errors: [] });
  }
  assert.equal(queries.length, 0);
});

test('existing snapshots retain Search Console POST and the full Business read mask', async t => {
  const search = { rows: [{ keys: ['coffee'], clicks: 3 }] };
  const business = { name, title: 'Coffee', profile: { description: 'Original' } };
  const { db, calls } = harness(t, [access, search, business]);
  const snapshot = await googleSnapshot(db, owner, { search_property: 'sc-domain:example.com', google_location: location });
  assert.deepEqual(snapshot.search, search);
  assert.deepEqual(snapshot.business, business);
  assert.deepEqual(snapshot.errors, []);
  assert.equal(calls[1].url, 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].body), { ...snapshot.period, dimensions: ['query'], rowLimit: 30 });
  assert.equal(calls[2].url, `${base}${name}?readMask=name,title,websiteUri,phoneNumbers,regularHours,categories,profile,storefrontAddress`);
  assert.equal(calls[2].method, 'GET');
});

test('existing token storage still encrypts and binds tokens to the supplied owner', async t => {
  const { db, queries } = harness(t, []);
  await storeGoogleToken(db, 'owner-b', 'refresh-owner-b');
  const insert = queries.find(query => query.sql.startsWith('INSERT INTO seo_google '));
  assert.match(insert.sql, /ON CONFLICT\(owner_id\) DO UPDATE/);
  assert.deepEqual(insert.args.slice(0, 2), ['owner-b', 'sealed:refresh-owner-b']);
  assert.equal(typeof insert.args[2], 'number');
});

const searchScope = 'https://www.googleapis.com/auth/webmasters.readonly';
const businessScope = 'https://www.googleapis.com/auth/business.manage';
const unknownCapabilities = { search: null, business: null, expired: null };

test('shared Google description validator supports empty restoration and rejects bare links', () => {
  assert.equal(validateGoogleBusinessDescription(' Café artesanal. '), 'Café artesanal.');
  assert.equal(validateGoogleBusinessDescription(' \n '), '');
  for (const value of ['Visit example.com', '<b>Café</b>', 'mailto:owner@example.com', 'a'.repeat(751), null]) {
    assert.throws(() => validateGoogleBusinessDescription(value), /texto plano|750/);
  }
});

test('legacy capability reads create the supplemental table and keep unknown scopes permissive', async t => {
  const { db } = harness(t, [access, { siteEntry: [] }, { accounts: [] }]);
  assert.deepEqual(await googleCapabilities(db, owner), unknownCapabilities);
  assert.deepEqual(await googleCapabilities(db, 'not-connected'), unknownCapabilities);
  assert.deepEqual(await googleResources(db, owner), { properties: [], locations: [], errors: [] });
});

test('scope metadata is owner-isolated, sanitized and replaced on reconnection', async t => {
  const { db, sql } = harness(t, []);
  await storeGoogleToken(db, owner, 'new-token', ` ${searchScope}\n${searchScope} private_scope `);
  assert.deepEqual(await googleCapabilities(db, owner), { search: true, business: false, expired: null });
  assert.deepEqual(await googleCapabilities(db, 'owner-b'), unknownCapabilities);
  assert.doesNotMatch(JSON.stringify(sql.prepare('SELECT * FROM seo_google_capabilities').all()), /new-token|private_scope|googleapis/);
  await storeGoogleToken(db, owner, 'full-token', `https://www.googleapis.com/auth/webmasters ${businessScope}`);
  assert.deepEqual(await googleCapabilities(db, owner), { search: true, business: true, expired: null });
  await storeGoogleToken(db, owner, 'legacy-token');
  assert.deepEqual(await googleCapabilities(db, owner), unknownCapabilities);
});

test('scope strings distinguish a denied grant from absent or malformed scope metadata', async t => {
  const { db } = harness(t, []);
  await storeGoogleToken(db, owner, 'no-grants', '');
  assert.deepEqual(await googleCapabilities(db, owner), { search: false, business: false, expired: null });
  for (const invalid of [undefined, null, 1, ['scope']]) {
    await storeGoogleToken(db, owner, 'unknown-grants', invalid);
    assert.deepEqual(await googleCapabilities(db, owner), unknownCapabilities);
  }
});

test('failed metadata storage cannot replace a working token or its capabilities', async t => {
  const { db, sql } = harness(t, []);
  await storeGoogleToken(db, owner, 'working-token', `${searchScope} ${businessScope}`);
  sql.exec("CREATE TRIGGER fail_capabilities BEFORE INSERT ON seo_google_capabilities BEGIN SELECT RAISE(ABORT, 'private database error'); END");
  await assert.rejects(storeGoogleToken(db, owner, 'replacement-token', searchScope));
  assert.equal(sql.prepare('SELECT refresh_token FROM seo_google WHERE owner_id=?').get(owner).refresh_token, 'sealed:working-token');
  assert.deepEqual(await googleCapabilities(db, owner), { search: true, business: true, expired: null });
});

test('capability lookup errors are sanitized instead of silently granting access', async t => {
  const { db } = harness(t, []);
  t.mock.method(db, 'prepare', () => { throw new Error('private database connection token'); });
  await assert.rejects(googleCapabilities(db, owner), error => {
    sanitized(error);
    assert.match(error.message, /comprobar los permisos/);
    return true;
  });
});

test('only supplied valid refresh lifetimes are stored; no seven-day default is inferred', async t => {
  const { db, sql } = harness(t, []);
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  await storeGoogleToken(db, owner, 'timed-token', searchScope, 3600);
  assert.equal(sql.prepare('SELECT refresh_expires_at FROM seo_google_capabilities').get().refresh_expires_at, now + 3600_000);
  assert.equal((await googleCapabilities(db, owner)).expired, false);
  for (const invalid of [undefined, null, -1, NaN, Infinity, 1.5, '3600', Number.MAX_SAFE_INTEGER]) {
    await storeGoogleToken(db, owner, 'unknown-lifetime', searchScope, invalid);
    assert.equal(sql.prepare('SELECT refresh_expires_at FROM seo_google_capabilities').get().refresh_expires_at, null);
    assert.equal((await googleCapabilities(db, owner)).expired, null);
  }
  await storeGoogleToken(db, owner, 'expired-token', searchScope, 0);
  assert.equal((await googleCapabilities(db, owner)).expired, true);
});

test('known missing Business scope skips GBP but preserves Search Console data', async t => {
  const properties = [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }];
  const { db, calls } = harness(t, [access, { siteEntry: properties }]);
  await storeGoogleToken(db, owner, 'refresh-owner-a', searchScope);
  const result = await googleResources(db, owner);
  assert.deepEqual(result.properties, properties);
  assert.deepEqual(result.locations, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^Google Business:.*permiso OAuth.*Reconectar Google/);
  assert.deepEqual(calls.map(call => call.url), [oauthUrl, sitesUrl]);
});

test('known missing Search scope skips Search Console and still fetches Business', async t => {
  const { db, calls } = harness(t, [access, { accounts: [] }]);
  await storeGoogleToken(db, owner, 'refresh-owner-a', businessScope);
  const result = await googleResources(db, owner);
  assert.match(result.errors[0], /^Search Console:.*permiso OAuth/);
  assert.deepEqual(calls.map(call => call.url), [oauthUrl, accountsUrl]);
});

test('selectors suppress errors for services not requested; a denied-only request avoids OAuth', async t => {
  const { db } = harness(t, [access, { siteEntry: [] }]);
  await storeGoogleToken(db, owner, 'refresh-owner-a', searchScope);
  assert.deepEqual(await googleResources(db, owner, { search: true }), { properties: [], locations: [], errors: [] });
  const denied = await googleResources(db, owner, { business: true });
  assert.equal(denied.errors.length, 1);
  assert.match(denied.errors[0], /^Google Business:/);
});

test('known expired grants prevent discovery, snapshot and writer network requests', async t => {
  const { db } = harness(t, []);
  await storeGoogleToken(db, owner, 'expired-token', `${searchScope} ${businessScope}`, 0);
  const resources = await googleResources(db, owner);
  assert.deepEqual(resources.properties, []);
  assert.deepEqual(resources.locations, []);
  assert.match(resources.errors[0], /caducó.*Reconectar/);
  const snapshot = await googleSnapshot(db, owner, { search_property: 'sc-domain:example.com', google_location: location });
  assert.match(snapshot.errors[0], /caducó.*Reconectar/);
  assert.equal(snapshot.search, undefined);
  assert.equal(snapshot.business, undefined);
  await assert.rejects(readGoogleBusinessDescription(db, owner, location), /caducó.*Reconectar/);
  await assert.rejects(updateGoogleBusinessDescription(db, owner, location, 'Desired', 'Original'), /caducó.*Reconectar/);
});

test('snapshots retain the allowed service and omit only the known missing scope', async t => {
  const search = { rows: [] };
  const { db, calls } = harness(t, [access, search]);
  await storeGoogleToken(db, owner, 'refresh-owner-a', searchScope);
  const snapshot = await googleSnapshot(db, owner, { search_property: 'sc-domain:example.com', google_location: location });
  assert.deepEqual(snapshot.search, search);
  assert.ok(snapshot.period);
  assert.equal(snapshot.business, undefined);
  assert.match(snapshot.errors[0], /^Google Business:/);
  assert.equal(calls.length, 2);
});

test('a Business-only grant can still read a snapshot with Search permission denied', async t => {
  const { db } = harness(t, [access, profile('Current')]);
  await storeGoogleToken(db, owner, 'refresh-owner-a', businessScope);
  const snapshot = await googleSnapshot(db, owner, { search_property: 'sc-domain:example.com', google_location: location });
  assert.deepEqual(snapshot.business, profile('Current'));
  assert.equal(snapshot.search, undefined);
  assert.equal(snapshot.period, undefined);
  assert.match(snapshot.errors[0], /^Search Console:/);
});

function callbackHarness(t, steps, rows) {
  const result = harness(t, steps, rows);
  callback.env.DB = result.db;
  configuration.configured = true;
  configuration.error = '';
  t.after(() => { callback.env.DB = null; configuration.error = ''; });
  return { ...result, state(value, stateOwner = owner, expires = Date.now() + 60_000) {
    result.sql.prepare('INSERT INTO seo_google_states VALUES(?,?,?)').run(value, stateOwner, expires);
  } };
}
const callbackRequest = (query, requestOwner = owner) => new Request(`https://app.example/api/seo/google?${query}`, { headers: requestOwner ? { 'oai-authenticated-user-id': requestOwner } : {} });

for (const [scopes, expected] of [[`${searchScope} ${businessScope}`, 'connected'], [searchScope, 'partial'], [businessScope, 'partial'], ['', 'partial'], [undefined, 'connected']]) {
  test(`callback records safe capabilities and redirects ${expected} for ${JSON.stringify(scopes)}`, async t => {
    const { db, calls, sql, state } = callbackHarness(t, [{ refresh_token: 'callback-refresh', scope: scopes, expires_in: 1 }]);
    state('valid');
    const result = await callback.GET(callbackRequest('code=mock-code&state=valid'));
    assert.equal(result.status, 303);
    assert.equal(result.headers.get('location'), `https://app.example/?section=seo&google=${expected}`);
    const caps = await googleCapabilities(db, owner);
    assert.equal(caps.expired, null, 'Access-token expiry must never become refresh-token expiry');
    assert.equal(caps.search, scopes === undefined ? null : scopes.includes(searchScope));
    assert.equal(caps.business, scopes === undefined ? null : scopes.includes(businessScope));
    assert.equal(sql.prepare('SELECT refresh_token FROM seo_google WHERE owner_id=?').get(owner).refresh_token, 'sealed:callback-refresh');
    assert.equal(calls[0].body.get('grant_type'), 'authorization_code');
    assert.equal(calls[0].body.get('redirect_uri'), 'https://app.example/api/seo/google');
    assert.equal(calls[0].body.get('code'), 'mock-code');
    assert.equal(calls[0].cache, 'no-store');
    assert.equal((await callback.GET(callbackRequest('code=mock-code&state=valid'))).status, 400, 'State is single-use');
  });
}

test('callback respects supplied refresh-token lifetime without exposing raw metadata', async t => {
  const { db, state } = callbackHarness(t, [{ refresh_token: 'callback-refresh', scope: searchScope, refresh_token_expires_in: 1 }]);
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  state('timed');
  assert.equal((await callback.GET(callbackRequest('code=x&state=timed'))).status, 303);
  assert.equal((await googleCapabilities(db, owner)).expired, false);
  now += 1000;
  assert.equal((await googleCapabilities(db, owner)).expired, true);
  const result = await callback.GET(callbackRequest('action=resources'));
  const body = await result.json();
  assert.match(body.errors[0], /caducó.*Reconectar/);
  assert.doesNotMatch(JSON.stringify(body), /callback-refresh|180000000|refresh_token|scope/);
});

test('callback rejects expired, missing, wrong-owner and cancelled state without exchanging tokens', async t => {
  const { state, sql } = callbackHarness(t, []);
  state('expired', owner, Date.now());
  state('wrong-owner', 'owner-b');
  state('cancelled');
  state('empty-code');
  for (const query of ['code=x&state=expired', 'code=x&state=missing', 'code=x&state=wrong-owner', 'error=private_upstream&state=cancelled', 'code=&state=empty-code']) {
    const result = await callback.GET(callbackRequest(query));
    assert.equal(result.status, 400);
    assert.deepEqual(await result.json(), { error: 'Autorización cancelada o caducada.' });
  }
  assert.ok(sql.prepare('SELECT state FROM seo_google_states WHERE state=?').get('wrong-owner'));
});

for (const payload of [null, {}, { refresh_token: 1 }, { refresh_token: ' ' }, { refresh_token: '' }]) {
  test(`callback rejects malformed persistent credentials ${JSON.stringify(payload)} without replacing an existing token`, async t => {
    const { state, sql } = callbackHarness(t, [payload]);
    state('invalid');
    const result = await callback.GET(callbackRequest('code=x&state=invalid'));
    assert.equal(result.status, 400);
    assert.deepEqual(await result.json(), { error: 'Google no entregó autorización persistente. Vuelve a conectar.' });
    assert.equal(sql.prepare('SELECT refresh_token FROM seo_google WHERE owner_id=?').get(owner).refresh_token, 'sealed:refresh-owner-a');
  });
}

for (const kind of ['invalid-json', 'http-error', 'timeout', 'database-error']) {
  test(`callback sanitizes ${kind} without reflecting upstream, SQL or token data`, async t => {
    const step = kind === 'invalid-json' ? new Response('private_upstream_token')
      : kind === 'http-error' ? failure(400)
        : kind === 'timeout' ? new DOMException('private_upstream_token', 'TimeoutError')
          : { refresh_token: 'callback-refresh', scope: searchScope };
    const { state, sql } = callbackHarness(t, [step]);
    state('error');
    if (kind === 'database-error') sql.exec("CREATE TRIGGER fail_token BEFORE INSERT ON seo_google BEGIN SELECT RAISE(ABORT, 'private SQL refresh_token'); END");
    const result = await callback.GET(callbackRequest('code=x&state=error'));
    assert.equal(result.status, 400);
    const body = await result.json();
    assert.doesNotMatch(body.error, /private|upstream|SQL|refresh_token|callback-refresh|Unexpected/);
    assert.equal(sql.prepare('SELECT refresh_token FROM seo_google WHERE owner_id=?').get(owner).refresh_token, 'sealed:refresh-owner-a');
  });
}

test('callback and resources preserve controlled authentication and configuration messages', async t => {
  const { state } = callbackHarness(t, [], {});
  assert.equal((await callback.GET(callbackRequest('', null))).status, 401);
  configuration.configured = false;
  const missingConfiguration = await callback.GET(callbackRequest(''));
  assert.equal(missingConfiguration.status, 409);
  assert.match((await missingConfiguration.json()).error, /GOOGLE_CLIENT_ID.*callback HTTPS/);
  configuration.configured = true;
  configuration.error = 'Configura SITE_ORIGIN con HTTPS.';
  state('config');
  assert.deepEqual(await (await callback.GET(callbackRequest('code=x&state=config'))).json(), { error: 'Configura SITE_ORIGIN con HTTPS.' });
  configuration.error = '';
  assert.deepEqual(await (await callback.GET(callbackRequest('action=resources'))).json(), { error: 'Conecta Google para consultar datos reales.' });
  callback.env.DB = null;
  assert.equal((await callback.GET(callbackRequest(''))).status, 503);
});

test('resources report missing scope while returning data from the allowed service', async t => {
  const { db } = callbackHarness(t, [access, { siteEntry: [] }]);
  await storeGoogleToken(db, owner, 'refresh-owner-a', searchScope);
  const result = await callback.GET(callbackRequest('action=resources'));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(Object.keys(body).sort(), ['errors', 'locations', 'properties']);
  assert.match(body.errors[0], /^Google Business:.*Reconectar Google/);
  assert.doesNotMatch(JSON.stringify(body), /refresh-owner|access-owner|expires|googleapis/);
});

test('unknown expiry still attempts refresh and reports revoked/expired refresh credentials safely', async t => {
  const { db } = callbackHarness(t, [response({ error: 'invalid_grant', error_description: 'private expired token' }, 400)]);
  await storeGoogleToken(db, owner, 'refresh-owner-a', searchScope);
  const result = await callback.GET(callbackRequest('action=resources'));
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), { error: 'Reconecta Google; no se pudo renovar el acceso.' });
});

test('disconnect removes only this owner token, capability metadata and linked resources', async t => {
  const { db, sql } = callbackHarness(t, []);
  await storeGoogleToken(db, owner, 'token-a', searchScope);
  await storeGoogleToken(db, 'owner-b', 'token-b', businessScope);
  sql.exec("INSERT INTO seo_settings VALUES('brand-a','owner-a','property-a','location-a'),('brand-b','owner-b','property-b','location-b')");
  assert.deepEqual(await (await callback.DELETE(callbackRequest(''))).json(), { disconnected: true });
  assert.deepEqual(await googleCapabilities(db, owner), unknownCapabilities);
  assert.equal(sql.prepare('SELECT owner_id FROM seo_google_capabilities WHERE owner_id=?').get(owner), undefined);
  assert.equal((await googleCapabilities(db, 'owner-b')).business, true);
  assert.equal(sql.prepare('SELECT search_property FROM seo_settings WHERE owner_id=?').get(owner).search_property, '');
  assert.equal(sql.prepare('SELECT search_property FROM seo_settings WHERE owner_id=?').get('owner-b').search_property, 'property-b');
});
