CREATE TABLE "customer_cafes" (
	"customer_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"opt_in" boolean DEFAULT false NOT NULL,
	"opt_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_cafes_customer_id_branch_id_pk" PRIMARY KEY("customer_id","branch_id")
);
--> statement-breakpoint
CREATE TABLE "loyalty_gifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"product_id" text,
	"amount" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"order_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loyalty_redemptions" ADD COLUMN "gift_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_cafes" ADD CONSTRAINT "customer_cafes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_cafes" ADD CONSTRAINT "customer_cafes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_gifts" ADD CONSTRAINT "loyalty_gifts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_gifts" ADD CONSTRAINT "loyalty_gifts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loyalty_gifts_customer_idx" ON "loyalty_gifts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "loyalty_gifts_campaign_idx" ON "loyalty_gifts" USING btree ("branch_id","campaign_id");