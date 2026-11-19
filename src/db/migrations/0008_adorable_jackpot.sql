CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"staff_id" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"drawer_device_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opened_by" uuid,
	"opening_float" bigint DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"counted_cash" bigint,
	"expected_cash" bigint,
	"difference" bigint,
	"cash_sales" bigint DEFAULT 0 NOT NULL,
	"card_sales" bigint DEFAULT 0 NOT NULL,
	"cash_in" bigint DEFAULT 0 NOT NULL,
	"cash_out" bigint DEFAULT 0 NOT NULL,
	"ticket_count" integer DEFAULT 0 NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE INDEX "cash_movements_session_idx" ON "cash_movements" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "cash_sessions_branch_opened_idx" ON "cash_sessions" USING btree ("branch_id","opened_at");