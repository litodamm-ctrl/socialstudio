import test from 'node:test';
import assert from 'node:assert/strict';
import {collectDriveCatalog, belongsToProject} from './drive-catalog.ts';
test('discovers nested and paginated photos without following shortcuts or cycles', async()=>{
 const folder=(id,name=id)=>({id,name,mimeType:'application/vnd.google-apps.folder'});
 const photo=id=>({id,name:id,mimeType:'image/jpeg'});
 const pages={root:{files:[folder('a','Altorena'),folder('b'),{id:'external',mimeType:'application/vnd.google-apps.shortcut'}],nextPageToken:'2'},'root:2':{files:[photo('late')]},a:{files:[folder('deep'),photo('a-photo')]},b:{files:[photo('b-photo')]},deep:{files:[folder('root'),photo('deep-photo')]}};
 const result=await collectDriveCatalog('root',async(id,token)=>pages[id+(token?':'+token:'')]);
 assert.equal(result.truncated,false);
 assert.deepEqual(result.files.map(f=>f.id).sort(),['a-photo','b-photo','deep-photo','late']);
 assert.equal(belongsToProject(result.files.find(f=>f.id==='deep-photo'),'https://altorena.netlify.app/'),true);
 assert.equal(belongsToProject(result.files.find(f=>f.id==='b-photo'),'https://altorena.netlify.app/'),false);
 assert.equal(belongsToProject(result.files.find(f=>f.id==='late'),'https://altorena.netlify.app/'),false);
 const capped=await collectDriveCatalog('root',async()=>pages.root,1);
 assert.equal(capped.truncated,true);
});

test('known project folder names match their registered website without crossing projects',()=>{
 const file={id:'photo',name:'ref.jpg',mimeType:'image/jpeg',folders:['Santillana del Mar']};
 assert.equal(belongsToProject(file,'https://santillanadelmar1.netlify.app/'),true);
 assert.equal(belongsToProject(file,'https://altorena.netlify.app/'),false);
 assert.equal(belongsToProject({...file,folders:['Grand Bay']},'https://grandbaybaru.netlify.app/'),true);
});
