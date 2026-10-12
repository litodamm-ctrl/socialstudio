import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertStoryPublicationFormat} from './story-publication-policy.ts';
test('block legacy agent stories before sending to Meta, allow feed and uploads',()=>{
  for(const storyFormat of [undefined,'9x16-v2','9x16-v3'])assert.throws(()=>assertStoryPublicationFormat('Historia',{generatedBy:'social-studio-ai',storyFormat}),/No se enviará/);
  for(const key of ['storyFormat','storyformat'])assert.doesNotThrow(()=>assertStoryPublicationFormat('Historia',{generatedBy:'social-studio-ai',[key]:'9x16-v4'}));
  assert.doesNotThrow(()=>assertStoryPublicationFormat('Imagen',{generatedBy:'social-studio-ai'}));
  assert.doesNotThrow(()=>assertStoryPublicationFormat('Historia',{ownerId:'owner'}));
});
