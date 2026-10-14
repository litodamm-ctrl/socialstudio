import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
const source=(await readFile(new URL('./website-catalog.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const {catalogLinks}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
test('catalog traverses only same origin products and collections, strips query tracking and skips cart/account',()=>{
 const links=catalogLinks(`<a href='/collections/bolsos'>Bolsos</a><a href='/products/canasto?tracking=1'>Canasto</a><a href='/products/canasto'>Again</a><a href='https://evil.test/products/bag'>Other</a><a href='/cart/products/bag'>Cart</a><a href='/account'>Account</a>`,'https://manglarcol.com/');
 assert.deepEqual(links,['https://manglarcol.com/products/canasto','https://manglarcol.com/collections/bolsos']);
});
