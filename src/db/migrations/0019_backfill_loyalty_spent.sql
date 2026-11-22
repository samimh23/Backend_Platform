-- Receipts scanned before monthly milestones existed: fill in what was paid (refunds negative).
UPDATE "loyalty_ledger" AS l SET "spent" = o."total"
FROM "sales_orders" AS o
WHERE l."kind" = 'earn' AND l."order_id" = o."id" AND l."spent" = 0;
--> statement-breakpoint
UPDATE "loyalty_ledger" AS l SET "spent" = -o."total"
FROM "sales_orders" AS o
WHERE l."kind" = 'refund' AND l."order_id" = o."id" AND l."spent" = 0;
