ALTER TABLE "branches" ADD COLUMN "lan_key" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "can_take_payments" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "lan_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "lan_port" integer;