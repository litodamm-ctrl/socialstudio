import test from 'node:test';
import assert from 'node:assert/strict';
import { instagramMediaForm, publishFacebookPhotoStory, AUTOPILOT_ALLOWED_SQL, POST_SNAPSHOT_SQL } from './meta-media.ts';
import { DatabaseSync } from 'node:sqlite';

test('atomic publication guards stop paused, disabled stories, stale edits, cancellation and expired backlog; manual remains allowed', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE posts(id TEXT, owner_id TEXT, status TEXT, scheduled_at TEXT, brand TEXT, caption TEXT, media_type TEXT, media_url TEXT);
    CREATE TABLE autopilot_slots(post_id TEXT, owner_id TEXT, brand_id TEXT);
    CREATE TABLE brand_registry(id TEXT, owner_id TEXT, active INTEGER, auto_schedule INTEGER, auto_stories INTEGER);
    CREATE TABLE instagram_publish_jobs(post_id TEXT, status TEXT);
    INSERT INTO brand_registry VALUES('brand','owner',1,1,1);
    INSERT INTO instagram_publish_jobs VALUES('post','pending');`);
  const scheduled = new Date(Date.now() - 60_000).toISOString();
  db.prepare('INSERT INTO posts VALUES(?,?,?,?,?,?,?,?)').run('post','owner','scheduled',scheduled,'Brand','copy','Historia','media');
  db.exec("INSERT INTO autopilot_slots VALUES('post','owner','brand')");
  const claim = () => db.prepare(`UPDATE instagram_publish_jobs SET status='processing' WHERE status='pending' AND EXISTS
    (SELECT 1 FROM posts p WHERE ${POST_SNAPSHOT_SQL} AND ${AUTOPILOT_ALLOWED_SQL}) RETURNING post_id`)
    .get('owner',new Date().toISOString(),'Brand','copy','Historia','media',scheduled);
  db.exec('UPDATE brand_registry SET auto_schedule=0'); assert.equal(claim(), undefined);
  db.exec('UPDATE brand_registry SET auto_schedule=1, active=0'); assert.equal(claim(), undefined);
  db.exec('UPDATE brand_registry SET active=1, auto_stories=0'); assert.equal(claim(), undefined);
  db.exec('UPDATE brand_registry SET auto_stories=1');
  db.exec("UPDATE posts SET caption='edited'"); assert.equal(claim(), undefined);
  db.exec("UPDATE posts SET caption='copy', status='draft'"); assert.equal(claim(), undefined);
  db.exec("UPDATE posts SET status='scheduled'");
  assert.equal(claim().post_id, 'post');
  db.exec("UPDATE instagram_publish_jobs SET status='pending'; UPDATE brand_registry SET auto_schedule=0; DELETE FROM autopilot_slots;");
  assert.equal(claim().post_id, 'post');
  db.exec("INSERT INTO autopilot_slots VALUES('post','owner','brand'); UPDATE brand_registry SET auto_schedule=1;");
  db.prepare('UPDATE posts SET scheduled_at=?').run(new Date(Date.now()-2*86_400_000).toISOString());
  assert.equal(db.prepare(`SELECT p.id FROM posts p WHERE ${AUTOPILOT_ALLOWED_SQL}`).get(), undefined);
  db.close();
});

test('stories use their own placement without leaking a feed caption; feed and reels retain captions', () => {
  const story = instagramMediaForm('Historia', 'https://example.org/story.jpg', 'Story text');
  assert.equal(story.get('media_type'), 'STORIES');
  assert.equal(story.get('image_url'), 'https://example.org/story.jpg');
  assert.equal(story.has('caption'), false);
  const feed = instagramMediaForm('Imagen', 'url', 'caption');
  assert.equal(feed.has('media_type'), false);
  assert.equal(feed.get('caption'), 'caption');
  const reel = instagramMediaForm('Reel', 'video', 'caption');
  assert.equal(reel.get('media_type'), 'REELS');
  assert.equal(reel.get('video_url'), 'video');
  assert.throws(() => instagramMediaForm('Unknown', 'url', 'caption'));
});

test('Facebook uploads an unpublished photo, persists it, and publishes only to stories', async () => {
  const calls = [];
  let stored = null;
  const result = await publishFacebookPhotoStory({ pageId: 'page', token: 'test', graphVersion: 'v26.0', mediaUrl: 'https://example.org/image.jpg', savePhotoId: async id => { stored = id; } }, async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer test');
    if (url.endsWith('/photos')) {
      assert.equal(init.body.get('published'), 'false');
      return Response.json({ id: 'photo' });
    }
    assert.equal(stored, 'photo');
    assert.equal(init.body.get('photo_id'), 'photo');
    return Response.json({ success: true, post_id: 'story' });
  });
  assert.equal(result, 'story');
  assert.deepEqual(calls.map(url => url.split('/').at(-1)), ['photos', 'photo_stories']);
});

test('manual retry reuses persisted photo; ambiguous publication is never retried internally', async () => {
  let calls = 0;
  await assert.rejects(publishFacebookPhotoStory({ pageId: 'page', token: 'test', graphVersion: 'v26.0', mediaUrl: 'url', photoId: 'existing', savePhotoId: async () => assert.fail('must reuse photo') }, async (url, init) => {
    calls++;
    assert.equal(url.endsWith('/photo_stories'), true);
    assert.equal(init.body.get('photo_id'), 'existing');
    return Response.json({ success: true });
  }), /confirmar/);
  assert.equal(calls, 1);
});

test('failed upload never attempts a story publish', async () => {
  let calls = 0;
  await assert.rejects(publishFacebookPhotoStory({ pageId: 'page', token: 'test', graphVersion: 'v26.0', mediaUrl: 'url', savePhotoId: async () => assert.fail('nothing uploaded') }, async () => {
    calls++;
    return Response.json({ error: { message: 'Permission denied' } }, { status: 403 });
  }), /Permission denied/);
  assert.equal(calls, 1);
});
