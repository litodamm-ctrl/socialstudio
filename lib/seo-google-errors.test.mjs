import test from 'node:test';
import assert from 'node:assert/strict';
import { seoGoogleError } from './seo-google-errors.ts';

test('distinguishes Search Console from Business APIs and classifies disabled APIs', () => {
  const payload = { error: { details: [{ reason: 'SERVICE_DISABLED' }] } };
  assert.match(seoGoogleError(403, 'www.googleapis.com', payload), /^Search Console: HTTP 403 · API deshabilitada/);
  assert.match(seoGoogleError(403, 'mybusinessaccountmanagement.googleapis.com', payload), /^Google Business · cuentas:/);
  assert.match(seoGoogleError(403, 'mybusinessbusinessinformation.googleapis.com', {}), /información del perfil/);
});
test('gives different next actions for scopes, quota and generic forbidden, without exposing messages', () => {
  assert.match(seoGoogleError(403, 'www.googleapis.com', { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }), /Reconectar Google/);
  assert.match(seoGoogleError(429, 'mybusinessaccountmanagement.googleapis.com', {}), /Si es 0/);
  const message = seoGoogleError(403, 'www.googleapis.com', { error: { message: 'private token and upstream body' } });
  assert.match(message, /Search Console API/);
  assert.doesNotMatch(message, /Google Business|private token|upstream body/);
});
test('a listed but unauthorized property has a distinct diagnosis without leaking upstream text', () => {
  const result = seoGoogleError(403,'www.googleapis.com',{error:{message:"User does not have sufficient permission for site private-site-secret"}});
  assert.match(result,/Acceso a la propiedad pendiente/);
  assert.doesNotMatch(result,/private-site-secret|Reconectar Google/);
});
