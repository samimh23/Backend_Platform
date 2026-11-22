CREATE TABLE "loyalty_milestone_awards" (
	"customer_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"milestone_id" text NOT NULL,
	"month" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_milestone_awards_customer_id_branch_id_milestone_id_month_pk" PRIMARY KEY("customer_id","branch_id","milestone_id","month")
);
--> statement-breakpoint
ALTER TABLE "loyalty_gifts" ADD COLUMN "milestone_id" text;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD COLUMN "spent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN "points_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN "milestones_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN "milestones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_milestone_awards" ADD CONSTRAINT "loyalty_milestone_awards_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;