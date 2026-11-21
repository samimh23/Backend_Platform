CREATE TABLE "loyalty_redemptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"reward_id" text NOT NULL,
	"reward_name" text NOT NULL,
	"points" integer NOT NULL,
	"kind" text NOT NULL,
	"product_id" text,
	"amount" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"order_id" uuid,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loyalty_redemptions" ADD CONSTRAINT "loyalty_redemptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loyalty_redemptions_code_idx" ON "loyalty_redemptions" USING btree ("branch_id","code");