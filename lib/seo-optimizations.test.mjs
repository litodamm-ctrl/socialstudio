import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { ensureBrandRegistry } from './brands.ts';

const githubSource = readFileSync(new URL('./seo-github.ts', import.meta.url), 'utf8')
  .replace('"@/lib/seo-audit"', JSON.stringify(new URL('./seo-audit.ts', import.meta.url).href))
  .replace('import("typescript")', `import(${JSON.stringify(import.meta.resolve('typescript'))})`);
const githubModUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(githubSource)).toString('base64')}`;
let source = readFileSync(new URL('./seo-optimizations.ts', import.meta.url), 'utf8');
source = source.replace('import { createSeoPullRequest, githubConfigured, parseGithubTargets, type SeoGithubTarget } from "@/lib/seo-github";', `import { parseGithubTargets } from ${JSON.stringify(githubModUrl)};
const githubConfigured = () => Boolean(globalThis.__seoGithubReady);
const createSeoPullRequest = async input => globalThis.__seoCreatePr(input);`);
source = source.replace('import { readGoogleBusinessDescription, updateGoogleBusinessDescription, validateGoogleBusinessDescription } from "@/lib/seo-google";', 'const readGoogleBusinessDescription = async (...args) => globalThis.__seoGoogleRead(...args); const validateGoogleBusinessDescription = x => { if (/example\\.com/.test(x)) throw new Error("link"); return x; }; const updateGoogleBusinessDescription = async (...args) => globalThis.__seoGoogleWrite(...args);');
for (const name of ['seo-audit', 'website-sources']) source = source.replaceAll(`"@/lib/${name}"`, JSON.stringify(new URL(`./${name}.ts`, import.meta.url).href));
source = source.replace('await fetchPublicResource(item.target, MAX_WEBSITE_BYTES)', 'await globalThis.__seoReadPublished(item.target)');
const modUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const { ensureSeoOptimizations, parseSeoPlan, saveSeoProposals, listSeoProposals, queueSeoProposal, processSeoProposal, autoQueueSeoProposals, verifySeoProposal } = await import(modUrl);

async function fixture() {
  const sql = new DatabaseSync(':memory:');
  const db = { prepare(query) { let args = []; return { bind(...params) { args = params; return this; }, async run() { const r = sql.prepare(query).run(...args); return { meta: { changes: Number(r.changes) } }; }, async first() { return sql.prepare(query).get(...args) ?? null; }, async all() { return { results: sql.prepare(query).all(...args) }; } }; } };
  await ensureBrandRegistry(db); await ensureSeoOptimizations(db); await ensureSeoOptimizations(db);
  sql.exec(`CREATE TABLE seo_settings(brand_id TEXT, owner_id TEXT, google_location TEXT);
    INSERT INTO brand_registry(id,owner_id,name,website_url,created_at,updated_at) VALUES('a','one','Brand A','https://example.com/',0,0),('b','two','Brand B','https://example.org/',0,0);
    INSERT INTO seo_settings VALUES('a','one','accounts/a/locations/one'),('b','two','accounts/b/locations/two');`);
  const brand = sql.prepare("SELECT * FROM brand_registry WHERE id='a'").get();
  const page = { url: brand.website_url, title: 'Original title', description: 'Original description', h1: [], score: 80, findings: [], checkedAt: 0 };
  const target = { url: page.url, repository: 'owner/site', branch: 'main', path: 'index.html' };
  sql.prepare('INSERT INTO seo_delivery(brand_id,owner_id,github_targets) VALUES(?,?,?)').run('a','one',JSON.stringify([target]));
  const seed = async (runId='01234567-1234-4123-8123-123456789abc', google=false) => {
    await saveSeoProposals(db, brand, runId, [page], google ? [] : [{ url: page.url, title: 'Improved title', description: 'Improved description' }], google ? {location:'accounts/a/locations/one',before:'Old profile',description:'New profile'} : null);
    return (await listSeoProposals(db, 'one', 'a')).find(p=>p.run_id===runId);
  };
  return {sql,db,brand,page,target,seed};
}

test('AI suggestions cannot select another website, a failed page, HTML or an unobserved Google profile', () => {
  const pages=[{url:'https://example.com/'},{url:'https://example.com/error',error:'offline'}];
  const parsed=parseSeoPlan(JSON.stringify({plan:'Evidence based plan',pages:[
    {url:'https://evil.example/',title:'Hijack',description:'Different site'},
    {url:'https://example.com/error',title:'Unknown',description:'No evidence'},
    {url:'https://example.com/',title:'<script>bad</script>',description:'Bad markup'},
    {url:'https://example.com/',title:'Valid title',description:'Valid description'},
  ],businessDescription:'Unobserved profile'}),pages,false);
  assert.equal(parsed.pages.length,1); assert.equal(parsed.pages[0].title,'Valid title'); assert.equal(parsed.businessDescription,'');
  assert.throws(()=>parseSeoPlan('{"plan":"truncated',pages,false));
});

test('proposals persist once, isolate owners, require configured delivery and reject stale evidence', async () => {
  const f=await fixture();
  try {
    const item=await f.seed(); await f.seed();
    assert.equal((await listSeoProposals(f.db,'one','a')).length,1);
    assert.equal((await listSeoProposals(f.db,'two','a')).length,0);
    await assert.rejects(queueSeoProposal(f.db,{...f.brand,owner_id:'two'},item.id),/no encontrada/);
    globalThis.__seoGithubReady=false;
    await assert.rejects(queueSeoProposal(f.db,f.brand,item.id),/Conecta GitHub/);
    assert.equal(f.sql.prepare('SELECT status FROM seo_proposals').get().status,'draft');
    globalThis.__seoGithubReady=true;
    f.sql.prepare('UPDATE seo_proposals SET created_at=?').run(Date.now()-8*86400_000);
    await assert.rejects(queueSeoProposal(f.db,f.brand,item.id),/siete días/);
  } finally {f.sql.close();delete globalThis.__seoGithubReady;}
});

test('one page cannot have overlapping deliveries; one queued action executes once and preserves target',async()=>{
  const f=await fixture();let calls=0;
  globalThis.__seoGithubReady=true;
  globalThis.__seoCreatePr=async input=>{calls++;assert.deepEqual(input.target,f.target);return {url:'https://github.com/owner/site/pull/4',number:4,branch:'seo-studio/example'};};
  try {
    const item=await f.seed();const second=await f.seed('11234567-1234-4123-8123-123456789abc');
    await queueSeoProposal(f.db,f.brand,item.id);
    await assert.rejects(queueSeoProposal(f.db,f.brand,second.id));
    await Promise.all([processSeoProposal(f.db,item.id),processSeoProposal(f.db,item.id)]);
    assert.equal(calls,1);const result=f.sql.prepare('SELECT * FROM seo_proposals WHERE id=?').get(item.id);
    assert.equal(result.status,'pr_created'); assert.equal(result.result_url,'https://github.com/owner/site/pull/4');
    await assert.rejects(queueSeoProposal(f.db,f.brand,item.id));
    globalThis.__seoReadPublished=async url=>({url,contentType:'text/html',bytes:Buffer.from('<html><head><title>Old</title></head></html>')});
    await assert.rejects(verifySeoProposal(f.db,'one',f.brand,item.id),/todavía/);
    globalThis.__seoReadPublished=async url=>({url,contentType:'text/html',bytes:Buffer.from('<html><head><title>Improved title</title><meta name="description" content="Improved description"></head></html>')});
    await assert.rejects(verifySeoProposal(f.db,'two',f.brand,item.id));
    await verifySeoProposal(f.db,'one',f.brand,item.id);
    assert.equal(f.sql.prepare('SELECT status FROM seo_proposals WHERE id=?').get(item.id).status,'verified');
  } finally {f.sql.close();delete globalThis.__seoCreatePr;delete globalThis.__seoGithubReady;delete globalThis.__seoReadPublished;}
});

test('delivery changes or archived brands prevent writes after queueing',async()=>{
  const f=await fixture();let calls=0;globalThis.__seoGithubReady=true;globalThis.__seoCreatePr=async()=>{calls++;};
  try {
    const item=await f.seed();await queueSeoProposal(f.db,f.brand,item.id);
    f.sql.prepare('UPDATE seo_delivery SET github_targets=?').run(JSON.stringify([{...f.target,repository:'owner/another'}]));
    await processSeoProposal(f.db,item.id);assert.equal(calls,0);
    assert.match(f.sql.prepare('SELECT error FROM seo_proposals').get().error,/destino cambió/);
    f.sql.prepare("UPDATE seo_delivery SET github_targets=?").run(JSON.stringify([f.target]));
    f.sql.exec("UPDATE brand_registry SET active=0");
    await queueSeoProposal(f.db,f.brand,item.id);await processSeoProposal(f.db,item.id);assert.equal(calls,0);
    assert.match(f.sql.prepare('SELECT error FROM seo_proposals').get().error,/no está activa/);
  } finally {f.sql.close();delete globalThis.__seoGithubReady;delete globalThis.__seoCreatePr;}
});

test('Google writes use the owning brand saved profile and exact baseline; failures remain retryable',async()=>{
  const f=await fixture();let calls=0;
  globalThis.__seoGoogleWrite=async(db,owner,location,text,before)=>{calls++;assert.equal(owner,'one');assert.equal(location,'accounts/a/locations/one');assert.equal(text,'New profile');assert.equal(before,'Old profile');if(calls===1)throw new Error('Google HTTP 429');return {description:text};};
  try {
    const item=await f.seed(undefined,true);await queueSeoProposal(f.db,f.brand,item.id);await processSeoProposal(f.db,item.id);
    assert.equal(f.sql.prepare('SELECT status FROM seo_proposals').get().status,'failed');
    await queueSeoProposal(f.db,f.brand,item.id);await processSeoProposal(f.db,item.id);
    assert.equal(f.sql.prepare('SELECT status FROM seo_proposals').get().status,'applied');assert.equal(calls,2);
    const next=await f.seed('21234567-1234-4123-8123-123456789abc',true);
    f.sql.exec("UPDATE seo_settings SET google_location='accounts/a/locations/changed'");
    await assert.rejects(queueSeoProposal(f.db,f.brand,next.id),/vinculada cambió/);assert.equal(calls,2);
  } finally {f.sql.close();delete globalThis.__seoGoogleWrite;}
});

test('automatic PR delivery requires opt-in and never automatically writes Google',async()=>{
  const f=await fixture();let calls=0;globalThis.__seoGithubReady=true;globalThis.__seoCreatePr=async()=>{calls++;return{url:'https://github.com/owner/site/pull/5'};};globalThis.__seoGoogleWrite=async()=>assert.fail('Google must remain manual');
  try {
    const item=await f.seed();await f.seed(undefined,true);
    await autoQueueSeoProposals(f.db,f.brand,item.run_id);assert.equal(calls,0);
    f.sql.exec('UPDATE seo_delivery SET auto_pr=1');await autoQueueSeoProposals(f.db,f.brand,item.run_id);assert.equal(calls,1);
    assert.equal(f.sql.prepare("SELECT status FROM seo_proposals WHERE kind='google'").get().status,'draft');
  } finally {f.sql.close();delete globalThis.__seoGithubReady;delete globalThis.__seoCreatePr;delete globalThis.__seoGoogleWrite;}
});

test('external resource leases prevent overlapping writes across brands and owners', {timeout:5000}, async () => {
  for (const kind of ['google','github']) {
    const f=await fixture(), entered=Promise.withResolvers(), resume=Promise.withResolvers();
    let calls=0, running;
    globalThis.__seoGithubReady=true;
    const write=async()=>{if(++calls===1){entered.resolve();await resume.promise;}return {url:'https://github.com/owner/site/pull/6',description:'New profile'};};
    globalThis.__seoGoogleWrite=write;globalThis.__seoCreatePr=write;
    try {
      const other=f.sql.prepare("SELECT * FROM brand_registry WHERE id='b'").get();
      const runId='31234567-1234-4123-8123-123456789abc';
      // Different account aliases/website URLs still identify the same external resource.
      f.sql.exec("UPDATE seo_settings SET google_location='accounts/b/locations/one' WHERE brand_id='b'");
      f.sql.prepare('INSERT INTO seo_delivery(brand_id,owner_id,github_targets) VALUES(?,?,?)').run(other.id,other.owner_id,JSON.stringify([{...f.target,url:other.website_url}]));
      const first=await f.seed(undefined,kind==='google');
      await saveSeoProposals(f.db,other,runId,[{...f.page,url:other.website_url}],kind==='github'?[{url:other.website_url,title:first.title,description:first.description}]:[],kind==='google'?{location:'accounts/b/locations/one',before:'Old profile',description:'New profile'}:null);
      const [second]=await listSeoProposals(f.db,other.owner_id,other.id);
      await queueSeoProposal(f.db,f.brand,first.id);await queueSeoProposal(f.db,other,second.id);
      running=processSeoProposal(f.db,first.id);await entered.promise;
      const lease=f.sql.prepare('SELECT * FROM seo_resource_leases').get();
      await processSeoProposal(f.db,second.id);
      assert.equal(calls,1,kind);
      const blocked=f.sql.prepare('SELECT status,error FROM seo_proposals WHERE id=?').get(second.id);
      assert.equal(blocked.status,'failed');assert.match(blocked.error,/mismo destino/);
      assert.deepEqual(f.sql.prepare('SELECT * FROM seo_resource_leases').get(),lease);
      resume.resolve();await running;
      assert.equal(f.sql.prepare('SELECT status FROM seo_proposals WHERE id=?').get(first.id).status,kind==='google'?'applied':'pr_created');
      assert.equal(f.sql.prepare('SELECT count(*) AS n FROM seo_resource_leases').get().n,0);
    } finally {resume.resolve();await running;f.sql.close();delete globalThis.__seoGithubReady;delete globalThis.__seoCreatePr;delete globalThis.__seoGoogleWrite;}
  }
});

test('disabling automatic PRs after the first delivery leaves the next proposal in draft', async () => {
  const f=await fixture();let calls=0,disabled=false;
  globalThis.__seoGithubReady=true;
  globalThis.__seoCreatePr=async()=>{calls++;return {url:'https://github.com/owner/site/pull/7'};};
  try {
    const second={...f.target,url:'https://example.com/second',path:'second.html'};
    f.brand.website_urls=JSON.stringify([f.target.url,second.url]);
    f.sql.prepare('UPDATE brand_registry SET website_urls=? WHERE id=?').run(f.brand.website_urls,f.brand.id);
    f.sql.prepare('UPDATE seo_delivery SET github_targets=?,auto_pr=1 WHERE brand_id=?').run(JSON.stringify([f.target,second]),f.brand.id);
    const first=await f.seed();
    await saveSeoProposals(f.db,f.brand,first.run_id,[{...f.page,url:second.url}],[{url:second.url,title:first.title,description:first.description}],null);
    const db={prepare(query){const statement=f.db.prepare(query);return {...statement,async run(){
      const result=await statement.run();
      // Save the opt-out only once the first delivery is terminal, as the route requires.
      if(!disabled && calls===1 && f.sql.prepare("SELECT count(*) AS n FROM seo_proposals WHERE status='pr_created'").get().n===1){
        const saved=f.sql.prepare("UPDATE seo_delivery SET auto_pr=0,revision=revision+1 WHERE brand_id=? AND NOT EXISTS (SELECT 1 FROM seo_proposals WHERE brand_id=? AND status IN ('queued','processing'))").run(f.brand.id,f.brand.id);
        assert.equal(Number(saved.changes),1);disabled=true;
      }
      return result;
    }};}};
    await autoQueueSeoProposals(db,f.brand,first.run_id);
    assert.equal(disabled,true);assert.equal(calls,1);
    assert.deepEqual((await listSeoProposals(f.db,'one','a')).map(p=>p.status).sort(),['draft','pr_created']);
  } finally {f.sql.close();delete globalThis.__seoGithubReady;delete globalThis.__seoCreatePr;}
});

test('an ambiguous failed delivery cannot be retried against a different destination', async () => {
  const f=await fixture();const calls=[];
  globalThis.__seoGithubReady=true;
  globalThis.__seoCreatePr=async input=>{calls.push(input.target);if(calls.length===1)throw new Error('PR accepted but response lost');return {url:'https://github.com/owner/site/pull/8'};};
  try {
    const item=await f.seed();await queueSeoProposal(f.db,f.brand,item.id);await processSeoProposal(f.db,item.id);
    const failed=f.sql.prepare('SELECT * FROM seo_proposals WHERE id=?').get(item.id);
    assert.equal(failed.status,'failed');assert.deepEqual(JSON.parse(failed.destination),f.target);
    f.sql.prepare('UPDATE seo_delivery SET github_targets=?,revision=revision+1 WHERE brand_id=?').run(JSON.stringify([{...f.target,repository:'owner/another'}]),f.brand.id);
    await assert.rejects(queueSeoProposal(f.db,f.brand,item.id),/destino original/);
    assert.deepEqual(f.sql.prepare('SELECT * FROM seo_proposals WHERE id=?').get(item.id),failed);
    assert.deepEqual(calls,[f.target]);
    // Restoring the original destination allows an idempotent retry of that same payload.
    f.sql.prepare('UPDATE seo_delivery SET github_targets=?,revision=revision+1 WHERE brand_id=?').run(JSON.stringify([f.target]),f.brand.id);
    await queueSeoProposal(f.db,f.brand,item.id);await processSeoProposal(f.db,item.id);
    assert.deepEqual(calls,[f.target,f.target]);
    assert.equal(f.sql.prepare('SELECT status FROM seo_proposals WHERE id=?').get(item.id).status,'pr_created');
  } finally {f.sql.close();delete globalThis.__seoGithubReady;delete globalThis.__seoCreatePr;}
});

test('stale attempt success or failure cannot change a newer attempt or release its lease', {timeout:5000}, async () => {
  for (const staleFails of [false,true]) {
    const f=await fixture(), entered=[Promise.withResolvers(),Promise.withResolvers()], resume=[Promise.withResolvers(),Promise.withResolvers()];
    const workers=[];let calls=0;
    globalThis.__seoGoogleWrite=async()=>{const index=calls++;entered[index].resolve();await resume[index].promise;if(index===0 && staleFails)throw new Error('Late failure from expired attempt');return {description:'New profile'};};
    try {
      const item=await f.seed(undefined,true);await queueSeoProposal(f.db,f.brand,item.id);
      workers.push(processSeoProposal(f.db,item.id));await entered[0].promise;
      const oldAttempt=f.sql.prepare('SELECT attempt FROM seo_proposals WHERE id=?').get(item.id).attempt;
      // Simulate scheduler expiry and resource-lease expiry while the old provider call is pending.
      f.sql.prepare("UPDATE seo_proposals SET status='failed' WHERE id=?").run(item.id);
      f.sql.exec('UPDATE seo_resource_leases SET lease_until=0');
      await queueSeoProposal(f.db,f.brand,item.id);
      workers.push(processSeoProposal(f.db,item.id));await entered[1].promise;
      const current=f.sql.prepare('SELECT * FROM seo_proposals WHERE id=?').get(item.id);
      assert.equal(current.status,'processing');assert.notEqual(current.attempt,oldAttempt);
      const lease=f.sql.prepare('SELECT * FROM seo_resource_leases').get();assert.equal(lease.attempt,current.attempt);
      resume[0].resolve();await workers[0];
      assert.deepEqual(f.sql.prepare('SELECT * FROM seo_proposals WHERE id=?').get(item.id),current);
      assert.deepEqual(f.sql.prepare('SELECT * FROM seo_resource_leases').get(),lease);
      resume[1].resolve();await workers[1];
      const result=f.sql.prepare('SELECT status,attempt,error FROM seo_proposals WHERE id=?').get(item.id);
      assert.equal(result.status,'applied');assert.equal(result.attempt,current.attempt);assert.equal(result.error,'');assert.equal(calls,2);
      assert.equal(f.sql.prepare('SELECT count(*) AS n FROM seo_resource_leases').get().n,0);
    } finally {resume.forEach(gate=>gate.resolve());await Promise.all(workers);f.sql.close();delete globalThis.__seoGoogleWrite;}
  }
});

test('an old failed Google proposal reconciles read-only only when the saved description matches', async () => {
  const f=await fixture();let reads=0,writes=0,current='A different profile';
  globalThis.__seoGoogleRead=async(db,owner,location)=>{reads++;assert.equal(db,f.db);assert.equal(owner,'one');assert.equal(location,'accounts/a/locations/one');return current;};
  globalThis.__seoGoogleWrite=async()=>{writes++;assert.fail('Reconciliation must not write to Google');};
  try {
    const item=await f.seed(undefined,true);
    const old=Date.now()-8*86400_000;
    f.sql.prepare("UPDATE seo_proposals SET status='failed',error='Delivery result uncertain',created_at=?,updated_at=? WHERE id=?").run(old,old,item.id);
    const failed=f.sql.prepare('SELECT * FROM seo_proposals WHERE id=?').get(item.id);
    await assert.rejects(queueSeoProposal(f.db,f.brand,item.id),/siete días/);
    await assert.rejects(verifySeoProposal(f.db,'one',f.brand,item.id),/No se ha escrito nada/);
    assert.equal(reads,1);assert.equal(writes,0);
    assert.deepEqual(f.sql.prepare('SELECT * FROM seo_proposals WHERE id=?').get(item.id),failed);
    current=item.description;
    await verifySeoProposal(f.db,'one',f.brand,item.id);
    const reconciled=f.sql.prepare('SELECT * FROM seo_proposals WHERE id=?').get(item.id);
    assert.equal(reconciled.status,'applied');assert.equal(reconciled.error,'');
    assert.equal(reconciled.created_at,old);assert.ok(reconciled.updated_at>old);
    assert.equal(reconciled.before_value,failed.before_value);assert.equal(reconciled.description,item.description);
    assert.equal(reads,2);assert.equal(writes,0);
  } finally {f.sql.close();delete globalThis.__seoGoogleRead;delete globalThis.__seoGoogleWrite;}
});
