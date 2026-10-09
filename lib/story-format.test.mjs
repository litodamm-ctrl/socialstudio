import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { formatStory } from './story-format.ts';

test('portrait creative fills 9:16 without white padding or losing foreground', async () => {
  const raw = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: '#bc7050' } }).png().toBuffer();
  for (const legacy of [false, true]) {
    const input = legacy ? await sharp(raw).resize(1080,1920,{fit:'contain',background:'#fff'}).jpeg().toBuffer() : raw;
    const output = await formatStory(input,legacy);
    const meta = await sharp(output).metadata();
    assert.equal(meta.width,1080); assert.equal(meta.height,1920);
    const {data} = await sharp(output).removeAlpha().raw().toBuffer({resolveWithObject:true});
    for (const y of [10,500,1900]) {
      const offset=(y*1080+540)*3;
      assert.ok(Math.abs(data[offset]-188)<5);
      assert.ok(Math.abs(data[offset+1]-112)<5);
    }
  }
});
test('legacy correction rejects unexpected geometry',async()=>{
  const input=await sharp({create:{width:100,height:100,channels:3,background:'red'}}).png().toBuffer();
  await assert.rejects(formatStory(input,true),/Unexpected/);
});

test('new stories are full bleed, not a sharp foreground pasted onto blurred bands',async()=>{
  const input=await sharp(Buffer.from(`<svg width="1024" height="1536"><rect width="1024" height="1536" fill="#cc8844"/><rect x="480" width="64" height="1536" fill="#153b21"/></svg>`)).png().toBuffer();
  const output=await formatStory(input,false,true);
  const {data,info}=await sharp(output).removeAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,1080);assert.equal(info.height,1920);
  for(const y of [10,100,960,1800,1910]){
    const i=(y*1080+540)*3;
    assert.ok(Math.abs(data[i]-21)<8,`unblurred design must extend to row ${y}`);
  }
});
