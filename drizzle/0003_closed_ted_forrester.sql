ALTER TYPE "public"."audit_action" ADD VALUE 'DOWNLOAD';--> statement-breakpoint
ALTER TABLE "application_documents" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "application_documents" ADD COLUMN "bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "application_documents" ADD COLUMN "original_filename" text;--> statement-breakpoint
ALTER TABLE "application_documents" ADD COLUMN "source" text DEFAULT 'PORTAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "application_documents" ADD COLUMN "external_id" text;