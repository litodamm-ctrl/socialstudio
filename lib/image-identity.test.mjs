import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {imageIdentity} from './image-identity.ts';
test('same pixels with different metadata share identity',async()=>{
 const a=await sharp({create:{width:512,height:768,channels:3,background:'#a25e30'}}).png().toBuffer();
 const b=await sharp(a).withMetadata({density:150}).png().toBuffer();
 assert.equal(await imageIdentity(a),await imageIdentity(b));
 const c=await sharp({create:{width:512,height:768,channels:3,background:'blue'}}).png().toBuffer();
 assert.notEqual(await imageIdentity(a),await imageIdentity(c));
});
