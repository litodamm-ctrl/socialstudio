import { formatStory } from "./story-format";

// Explicitly reviewed and user-approved October 10 creatives only. Other old
// layouts may have text at their edges and must not be cropped indiscriminately.
const REVIEWED_STORY_MEDIA = [
  "5311f4f2-4dfb-4536-b4ae-9e6a4058cc8e",
  "3a59c7cd-fdb4-47b2-9d83-4c6c5a1e4da0",
  "796850e2-afad-426f-919c-c4387bc93026",
];

export async function repairReviewedStories(db: D1Database, bucket: R2Bucket) {
  const hasJobs = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instagram_publish_jobs'").first();
  const guard = hasJobs ? "AND NOT EXISTS (SELECT 1 FROM instagram_publish_jobs j WHERE j.post_id=p.id)" : "";
  for (const mediaId of REVIEWED_STORY_MEDIA) {
    const url = `/api/media/${mediaId}`;
    const rows = await db.prepare(`SELECT p.id,p.owner_id FROM posts p WHERE p.media_url=?
      AND p.media_type='Historia' AND p.status='scheduled' AND p.scheduled_at>? ${guard}`)
      .bind(url,new Date(Date.now()+15*60_000).toISOString()).all<{id:string;owner_id:string}>();
    for (const post of rows.results ?? []) {
      try {
        const original = await bucket.get(`media/${mediaId}`);
        if (!original || original.size > 12*1024*1024 || original.customMetadata?.ownerId !== post.owner_id
          || original.customMetadata.generatedBy !== "social-studio-ai"
          || (original.customMetadata.storyFormat ?? original.customMetadata.storyformat) !== "9x16-v3") continue;
        // These reviewed v3 images have exactly 150px of backdrop at each end.
        const bytes = await formatStory(new Uint8Array(await original.arrayBuffer()), true, true);
        const id = crypto.randomUUID();
        await bucket.put(`media/${id}`,bytes,{
          httpMetadata:{contentType:"image/jpeg",cacheControl:"private, max-age=300"},
          customMetadata:{ownerId:post.owner_id,generatedBy:"social-studio-ai",storyFormat:"9x16-v4",originalMediaId:mediaId},
        });
        // Copy-on-write plus URL comparison makes subsequent cron runs no-ops.
        await db.prepare(`UPDATE posts AS p SET media_url=? WHERE p.id=? AND p.owner_id=? AND p.media_url=?
          AND p.media_type='Historia' AND p.status='scheduled' AND p.scheduled_at>? ${guard}`)
          .bind(`/api/media/${id}`,post.id,post.owner_id,url,new Date(Date.now()+15*60_000).toISOString()).run();
      } catch (error) {
        console.error("Reviewed story repair failed",post.id,error instanceof Error ? error.message : "unknown");
      }
    }
  }
}

// Copy-on-write migration: never overwrite original media or published posts.
export async function repairPendingStories(db: D1Database, bucket: R2Bucket) {
  await repairReviewedStories(db,bucket);
  await db.prepare(`CREATE TABLE IF NOT EXISTS story_format_repairs (
    post_id TEXT NOT NULL, original_url TEXT NOT NULL, result TEXT NOT NULL,
    checked_at INTEGER NOT NULL, PRIMARY KEY(post_id, original_url))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS story_format_repairs_v3 (
    post_id TEXT NOT NULL, original_url TEXT NOT NULL, result TEXT NOT NULL,
    checked_at INTEGER NOT NULL, PRIMARY KEY(post_id, original_url))`).run();
  const hasJobs = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instagram_publish_jobs'").first();
  const jobGuard = hasJobs ? "AND NOT EXISTS (SELECT 1 FROM instagram_publish_jobs j WHERE j.post_id=p.id)" : "";
  const rows = await db.prepare(`SELECT p.id,p.owner_id,p.media_url FROM posts p
    WHERE p.status='scheduled' AND p.media_type='Historia' AND p.scheduled_at > ?
    ${jobGuard} AND NOT EXISTS (SELECT 1 FROM story_format_repairs_v3 r WHERE r.post_id=p.id AND r.original_url=p.media_url)
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
          if (!["9x16-v3", "9x16-v4"].includes(original.customMetadata.storyFormat ?? original.customMetadata.storyformat ?? "")) {
            // Use the first preserved source, never another repeatedly transcoded copy.
            const first = await db.prepare("SELECT original_url FROM story_format_repairs WHERE post_id=? AND result='repaired' ORDER BY checked_at ASC LIMIT 1")
              .bind(post.id).first<{original_url:string}>();
            const earliestId = first && /^\/api\/media\/([0-9a-f-]{36})$/i.exec(first.original_url)?.[1];
            const source = earliestId ? await bucket.get(`media/${earliestId}`) : original;
            if (!source || source.customMetadata?.ownerId !== post.owner_id) throw new Error("Original unavailable; kept existing post");
            if (source.size > 12*1024*1024) throw new Error("Story exceeds size limit");
            const alreadyFormatted = Boolean(source.customMetadata.storyFormat ?? source.customMetadata.storyformat);
            const bytes = await formatStory(new Uint8Array(await source.arrayBuffer()), !alreadyFormatted);
            const id = crypto.randomUUID();
            await bucket.put(`media/${id}`, bytes, {
              httpMetadata: {contentType:"image/jpeg",cacheControl:"private, max-age=300"},
              customMetadata: {ownerId:post.owner_id,generatedBy:"social-studio-ai",storyFormat:"9x16-v3",originalMediaId:earliestId || mediaId},
            });
            const updated = await db.prepare(`UPDATE posts AS p SET media_url=? WHERE p.id=? AND p.owner_id=?
              AND p.media_url=? AND p.status='scheduled' AND p.scheduled_at > ? ${jobGuard} RETURNING id`)
              .bind(`/api/media/${id}`,post.id,post.owner_id,post.media_url,new Date(Date.now()+15*60_000).toISOString()).first();
            result = updated ? "repaired" : "unchanged-concurrent-update";
          }
        }
      }
      await db.prepare("INSERT OR REPLACE INTO story_format_repairs_v3 VALUES (?,?,?,?)")
        .bind(post.id,post.media_url,result,Date.now()).run();
      console.info("Story format check",post.id,result);
    } catch(error) {
      // Keep original intact; retry on a future tick instead of losing the post.
      console.error("Story format repair failed",post.id,error instanceof Error ? error.message : "unknown");
    }
  }
}
