import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  brand: text("brand").notNull(),
  caption: text("caption").notNull(),
  mediaType: text("media_type").notNull().default("Imagen"),
  mediaUrl: text("media_url").notNull().default(""),
  scheduledAt: text("scheduled_at"),
  status: text("status").notNull().default("draft"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const instagramAccounts = sqliteTable("instagram_accounts", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  brand: text("brand").notNull(),
  instagramUserId: text("instagram_user_id").notNull(),
  username: text("username").notNull(),
  encryptedToken: text("encrypted_token").notNull(),
  tokenExpiresAt: integer("token_expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("instagram_accounts_owner_brand_uq").on(table.ownerId, table.brand),
  uniqueIndex("instagram_accounts_owner_ig_user_uq").on(table.ownerId, table.instagramUserId),
]);

export const instagramOAuthStates = sqliteTable("instagram_oauth_states", {
  state: text("state").primaryKey(),
  ownerId: text("owner_id").notNull(),
  brand: text("brand").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
