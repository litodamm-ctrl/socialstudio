CREATE TABLE `instagram_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`brand` text NOT NULL,
	`instagram_user_id` text NOT NULL,
	`username` text NOT NULL,
	`encrypted_token` text NOT NULL,
	`token_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instagram_accounts_owner_brand_uq` ON `instagram_accounts` (`owner_id`,`brand`);--> statement-breakpoint
CREATE UNIQUE INDEX `instagram_accounts_owner_ig_user_uq` ON `instagram_accounts` (`owner_id`,`instagram_user_id`);--> statement-breakpoint
CREATE TABLE `instagram_oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`brand` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
