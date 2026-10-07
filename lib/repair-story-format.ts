import { formatStory } from "./story-format";

// Copy-on-write migration: never overwrite original media or published posts.
export async function repairPendingStories(db: D1Database, bucket: R2Bucket) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS story_format_repairs (
    post_id TEXT NOT NULL, original_url TEXT NOT NULL, result TEXT NOT NULL,
    checked_at INTEGER NOT NULL, PRIMARY KEY(post_id, original_url))`).run();
  const hasJobs = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instagram_publish_jobs'").first();
  const jobGuard = hasJobs ? "AND NOT EXISTS (SELECT 1 FROM instagram_publish_jobs j WHERE j.post_id=p.id)" : "";
  const rows = await db.prepare(`SELECT p.id,p.owner_id,p.media_url FROM posts p
    WHERE p.status='scheduled' AND p.media_type='Historia' AND p.scheduled_at > ?
    ${jobGuard} AND NOT EXISTS (SELECT 1 FROM story_format_repairs r WHERE r.post_id=p.id AND r.original_url=p.media_url)
    ORDER BY p.scheduled_at LIMIT 5`).bind(new Date(Date.now()+15*60_000).toISOString())
    .all<{id:string;owner_id:string;media_url:string}>();
  for (const post of rows.results ?? []) {
    try {
      let result = "not-agent-media";
      const mediaId = /^\/api\/media\/([0-9a-f-]{36})$/i.exec(post.media_url)?.[1];
      if (mediaId) {
        const original = await bucket.get(`media/${mediaId}`);
        if (original?.customMetadata?.ownerId === post.owner_id && original.customMetadata.generatedBy === "social-studio-ai") {
          result = "already-correct";
          if (!original.customMetadata.storyFormat) {
            if (original.size > 12*1024*1024) throw new Error("Story exceeds size limit");
            const bytes = await formatStory(new Uint8Array(await original.arrayBuffer()), true);
            const id = crypto.randomUUID();
            await bucket.put(`media/${id}`, bytes, {
              httpMetadata: {contentType:"image/jpeg",cacheControl:"private, max-age=300"},
              customMetadata: {ownerId:post.owner_id,generatedBy:"social-studio-ai",storyFormat:"9x16-v2",originalMediaId:mediaId},
            });
            const updated = await db.prepare(`UPDATE posts AS p SET media_url=? WHERE p.id=? AND p.owner_id=?
              AND p.media_url=? AND p.status='scheduled' AND p.scheduled_at > ? ${jobGuard} RETURNING id`)
              .bind(`/api/media/${id}`,post.id,post.owner_id,post.media_url,new Date(Date.now()+15*60_000).toISOString()).first();
            result = updated ? "repaired" : "unchanged-concurrent-update";
          }
        }
      }
      await db.prepare("INSERT OR REPLACE INTO story_format_repairs VALUES (?,?,?,?)")
        .bind(post.id,post.media_url,result,Date.now()).run();
      console.info("Story format check",post.id,result);
    } catch(error) {
      // Keep original intact; retry on a future tick instead of losing the post.
      console.error("Story format repair failed",post.id,error instanceof Error ? error.message : "unknown");
    }
  }
}
