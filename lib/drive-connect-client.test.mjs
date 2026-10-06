import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDriveConnection } from './drive-connect-client.ts';

test('saves the typed folder before obtaining OAuth URL, including account-specific Drive URLs', async () => {
  const calls = [];
  const url = await prepareDriveConnection('brand', ' https://drive.google.com/drive/u/0/folders/abc_123?usp=sharing ', async (url, options) => {
    calls.push({ url, options });
    return Response.json(calls.length === 1 ? { updated: true } : { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test' });
  });
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body), { driveFolderUrl: 'https://drive.google.com/drive/folders/abc_123' });
  assert.equal(calls[1].url, '/api/brands/brand/drive/connect?format=json');
  assert.match(url, /^https:\/\/accounts.google.com\//);
});

test('shows missing configuration returned by the server', async () => {
  let count = 0;
  await assert.rejects(prepareDriveConnection('brand', 'https://drive.google.com/drive/folders/abc', async () => ++count === 1
    ? Response.json({ updated: true })
    : Response.json({ error: 'Falta configurar GOOGLE_CLIENT_ID' }, { status: 503 })), /GOOGLE_CLIENT_ID/);
});

test('does not start OAuth after a failed save', async () => {
  let count = 0;
  await assert.rejects(prepareDriveConnection('brand', 'https://drive.google.com/drive/folders/abc', async () => {
    count++; return Response.json({ error: 'No se pudo actualizar la marca.' }, { status: 503 });
  }), /actualizar la marca/);
  assert.equal(count, 1);
});

test('rejects empty input, files and spoofed domains before sending requests', async () => {
  for (const value of ['', 'https://drive.google.com/file/d/abc', 'https://drive.google.com.evil.example/drive/folders/abc']) {
    await assert.rejects(prepareDriveConnection('brand', value, async () => assert.fail('must not fetch')), /carpeta/);
  }
});

test('explains an expired login session', async () => {
  await assert.rejects(prepareDriveConnection('brand', 'https://drive.google.com/drive/folders/abc', async () => new Response('', { status: 401 })), /sesión expiró/);
});
