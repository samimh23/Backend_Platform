CREATE TABLE "password_resets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "owner_users" ADD COLUMN "daily_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "owner_users" ADD COLUMN "daily_email_sent_for" text;