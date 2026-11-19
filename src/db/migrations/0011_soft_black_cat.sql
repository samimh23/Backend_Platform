ALTER TABLE "sales_order_lines" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD COLUMN "void_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "refund_reason" text;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "refund_approved_by" uuid;