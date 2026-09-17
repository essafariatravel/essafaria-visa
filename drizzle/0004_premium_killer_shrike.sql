ALTER TABLE "gmail_connections" ADD COLUMN "refresh_token_cipher" text;--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD COLUMN "refresh_token_rotated_at" timestamp with time zone;