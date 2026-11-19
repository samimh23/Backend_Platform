ALTER TABLE "sales_order_lines" ADD COLUMN "discount_type" text;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD COLUMN "discount_value" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD COLUMN "discount_reason" text;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD COLUMN "discount_approved_by" uuid;