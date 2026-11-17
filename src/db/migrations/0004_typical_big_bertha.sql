CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"name" text NOT NULL,
	"unit_price" bigint NOT NULL,
	"modifiers_price" bigint DEFAULT 0 NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"qty" integer NOT NULL,
	"vat_rate_bp" integer NOT NULL,
	"voided" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"type" text DEFAULT 'takeaway' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"total" bigint DEFAULT 0 NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"receipt_number" text,
	"payment_method" text
);
--> statement-breakpoint
CREATE TABLE "sales_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" bigint NOT NULL,
	"tendered" bigint DEFAULT 0 NOT NULL,
	"change_given" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sales_order_lines_order_idx" ON "sales_order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "sales_orders_branch_closed_idx" ON "sales_orders" USING btree ("branch_id","closed_at");--> statement-breakpoint
CREATE INDEX "sales_orders_branch_status_idx" ON "sales_orders" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "sales_payments_order_idx" ON "sales_payments" USING btree ("order_id");