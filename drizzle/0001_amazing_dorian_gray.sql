CREATE TYPE "public"."ai_run_status" AS ENUM('OK', 'FAILED', 'SKIPPED', 'STALE');--> statement-breakpoint
CREATE TYPE "public"."application_origin" AS ENUM('AGENCY_PORTAL', 'BACK_OFFICE', 'EMAIL');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('IN_APP', 'EMAIL', 'SMS', 'GMAIL');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."document_review_state" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'NEEDS_REPLACEMENT', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."gmail_connection_status" AS ENUM('DISCONNECTED', 'CONNECTED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'PENDING', 'PARTIALLY_PAID', 'PAID', 'REFUNDED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "public"."wallet_tx_kind" AS ENUM('CREDIT', 'DEBIT', 'REVERSAL', 'ADJUSTMENT', 'REFUND');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'SUBMIT';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'TRANSITION';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'OVERRIDE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'APPROVE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'REJECT';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'REOPEN';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'CHARGE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'CREDIT';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'REVERSAL';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'SEND';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'RECEIVE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'ARCHIVE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'RESTORE';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agency_wallet_transactions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"agency_id" text NOT NULL,
	"currency_code" text NOT NULL,
	"kind" "wallet_tx_kind" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"balance_before_cents" bigint NOT NULL,
	"balance_after_cents" bigint NOT NULL,
	"application_id" text,
	"invoice_id" text,
	"invoice_item_id" text,
	"reverses_tx_id" text,
	"actor_id" text,
	"actor_email" text,
	"reason" text NOT NULL,
	"reference" text,
	"idempotency_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"purpose" text NOT NULL,
	"agency_id" text,
	"application_id" text,
	"document_id" text,
	"requested_by" text,
	"provider" text DEFAULT 'none' NOT NULL,
	"model" text,
	"status" "ai_run_status" DEFAULT 'OK' NOT NULL,
	"confidence" integer,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"basis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_suggestions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"run_id" text NOT NULL,
	"agency_id" text,
	"application_id" text,
	"document_id" text,
	"kind" text NOT NULL,
	"field" text,
	"proposed_value" text,
	"rationale" text,
	"confidence" integer DEFAULT 0 NOT NULL,
	"requires_human_review" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"acted_by" text,
	"acted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "applicants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"application_id" text NOT NULL,
	"agency_id" text NOT NULL,
	"full_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"date_of_birth" date,
	"nationality_country_id" text,
	"birth_country_id" text,
	"gender" text,
	"marital_status" text,
	"phone" text,
	"email" text,
	"address" text,
	"passport_number" text,
	"passport_issue_date" date,
	"passport_expiry_date" date,
	"passport_issue_country_id" text,
	"intended_entry_date" date,
	"intended_exit_date" date,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_documents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"application_id" text NOT NULL,
	"applicant_id" text,
	"agency_id" text NOT NULL,
	"document_type_id" text NOT NULL,
	"document_type_code" text NOT NULL,
	"requirement_id" text,
	"was_required_at_upload" boolean DEFAULT true NOT NULL,
	"media_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_document_id" text,
	"review_state" "document_review_state" DEFAULT 'PENDING' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"staff_notes" text,
	"agency_notes" text,
	"rejection_code" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"uploaded_by" text,
	"ai_extracted" jsonb,
	"ai_confidence" integer,
	"ai_reviewed_by_staff" boolean DEFAULT false NOT NULL,
	"ai_run_id" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"application_id" text NOT NULL,
	"agency_id" text,
	"type" text NOT NULL,
	"actor_id" text,
	"actor_email" text,
	"actor_kind" text DEFAULT 'USER' NOT NULL,
	"from_status_id" text,
	"to_status_id" text,
	"message" text,
	"payload" jsonb,
	"customer_visible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_reference_counters" (
	"period" text PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"application_id" text NOT NULL,
	"reason" text NOT NULL,
	"requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_amount_cents" bigint DEFAULT 0 NOT NULL,
	"currency_code" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "communications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"thread_id" text,
	"direction" "message_direction" NOT NULL,
	"agency_id" text,
	"application_id" text,
	"user_id" text,
	"channel" "channel" DEFAULT 'EMAIL' NOT NULL,
	"from_address" text,
	"to_address" text,
	"subject" text,
	"body" text,
	"body_format" text DEFAULT 'text' NOT NULL,
	"message_id" text,
	"in_reply_to" text,
	"sent_at" timestamp with time zone,
	"matched_by" text,
	"match_confidence" integer,
	"ai_summary" text,
	"ai_suggested_reply" text,
	"ai_run_id" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"send_state" "delivery_state",
	"redacted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gmail_attachments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"message_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"media_id" text,
	"document_id" text,
	"applicant_guess" text,
	"suggested_document_type_code" text,
	"confidence" integer,
	"linked_by" text,
	"linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gmail_connections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"label" text NOT NULL,
	"email_address" text NOT NULL,
	"status" "gmail_connection_status" DEFAULT 'DISCONNECTED' NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"client_id_ref" text,
	"client_secret_ref" text,
	"redirect_uri" text,
	"last_history_id" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gmail_messages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"connection_id" text,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text,
	"from_address" text,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text,
	"snippet" text,
	"body_text" text,
	"body_html_redacted" boolean DEFAULT false NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"received_at" timestamp with time zone,
	"classification" text,
	"classification_source" text,
	"classification_confidence" integer,
	"matched_agency_id" text,
	"application_id" text,
	"match_confidence" integer,
	"matched_by" text,
	"requires_review" boolean DEFAULT true NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"communication_id" text,
	"import_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"invoice_id" text NOT NULL,
	"application_id" text NOT NULL,
	"description" text NOT NULL,
	"fee_type" "fee_type" DEFAULT 'SERVICE_FEE' NOT NULL,
	"unit_amount_cents" bigint NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount_cents" bigint NOT NULL,
	"applicant_id" text,
	"visa_fee_id" text,
	"snapshot_id" text,
	"charge_status" text DEFAULT 'PENDING' NOT NULL,
	"charged_at" timestamp with time zone,
	"wallet_tx_id" text,
	"charge_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"number" text NOT NULL,
	"agency_id" text NOT NULL,
	"application_id" text,
	"currency_code" text NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"void_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "login_attempts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"key" text NOT NULL,
	"success" boolean DEFAULT false NOT NULL,
	"ip_hash" text,
	"user_agent_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_deliveries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"notification_id" text NOT NULL,
	"channel" "channel" DEFAULT 'EMAIL' NOT NULL,
	"to" text,
	"template_code" text,
	"subject" text,
	"body" text,
	"state" "delivery_state" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"idempotency_key" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"agency_id" text,
	"user_id" text,
	"staff_only" boolean DEFAULT false NOT NULL,
	"audience_role" text,
	"application_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"severity" text DEFAULT 'INFO' NOT NULL,
	"read_at" timestamp with time zone,
	"read_by" text,
	"payload" jsonb,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"task_key" text NOT NULL,
	"run_key" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"result" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visa_applications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"reference" text NOT NULL,
	"agency_id" text NOT NULL,
	"created_by_user_id" text,
	"origin" "application_origin" DEFAULT 'AGENCY_PORTAL' NOT NULL,
	"country_id" text NOT NULL,
	"visa_type_id" text NOT NULL,
	"category_id" text,
	"country_name" text NOT NULL,
	"visa_type_name" text NOT NULL,
	"visa_type_code" text NOT NULL,
	"status_id" text NOT NULL,
	"status_snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"priority_id" text,
	"priority_snapshot_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"submitted_by_user_id" text,
	"submission_override_reason" text,
	"submission_override_by" text,
	"submission_override_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"travel_date" date,
	"target_processing_days" integer,
	"due_at" timestamp with time zone,
	"requested_count" integer DEFAULT 1 NOT NULL,
	"applicant_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"staff_notes" text,
	"case_officer_user_id" text,
	"consulate_ref" text,
	"current_snapshot_id" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "wallet_balance_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "application_statuses" ADD COLUMN "allowed_next_status_codes" jsonb;--> statement-breakpoint
ALTER TABLE "application_statuses" ADD COLUMN "requires_documents_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "application_statuses" ADD COLUMN "customer_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agency_wallet_transactions" ADD CONSTRAINT "agency_wallet_transactions_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agency_wallet_transactions" ADD CONSTRAINT "agency_wallet_transactions_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agency_wallet_transactions" ADD CONSTRAINT "agency_wallet_transactions_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agency_wallet_transactions" ADD CONSTRAINT "agency_wallet_transactions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agency_wallet_transactions" ADD CONSTRAINT "agency_wallet_transactions_invoice_item_id_invoice_items_id_fk" FOREIGN KEY ("invoice_item_id") REFERENCES "public"."invoice_items"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agency_wallet_transactions" ADD CONSTRAINT "agency_wallet_transactions_reverses_tx_id_agency_wallet_transactions_id_fk" FOREIGN KEY ("reverses_tx_id") REFERENCES "public"."agency_wallet_transactions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agency_wallet_transactions" ADD CONSTRAINT "agency_wallet_transactions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_document_id_application_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."application_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_document_id_application_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."application_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_acted_by_users_id_fk" FOREIGN KEY ("acted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "applicants" ADD CONSTRAINT "applicants_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "applicants" ADD CONSTRAINT "applicants_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "applicants" ADD CONSTRAINT "applicants_nationality_country_id_countries_id_fk" FOREIGN KEY ("nationality_country_id") REFERENCES "public"."countries"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "applicants" ADD CONSTRAINT "applicants_birth_country_id_countries_id_fk" FOREIGN KEY ("birth_country_id") REFERENCES "public"."countries"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "applicants" ADD CONSTRAINT "applicants_passport_issue_country_id_countries_id_fk" FOREIGN KEY ("passport_issue_country_id") REFERENCES "public"."countries"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_requirement_id_visa_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."visa_requirements"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_supersedes_document_id_application_documents_id_fk" FOREIGN KEY ("supersedes_document_id") REFERENCES "public"."application_documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_events" ADD CONSTRAINT "application_events_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_events" ADD CONSTRAINT "application_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_events" ADD CONSTRAINT "application_events_from_status_id_application_statuses_id_fk" FOREIGN KEY ("from_status_id") REFERENCES "public"."application_statuses"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_events" ADD CONSTRAINT "application_events_to_status_id_application_statuses_id_fk" FOREIGN KEY ("to_status_id") REFERENCES "public"."application_statuses"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_snapshots" ADD CONSTRAINT "application_snapshots_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_snapshots" ADD CONSTRAINT "application_snapshots_captured_by_users_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communications" ADD CONSTRAINT "communications_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communications" ADD CONSTRAINT "communications_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communications" ADD CONSTRAINT "communications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communications" ADD CONSTRAINT "communications_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_attachments" ADD CONSTRAINT "gmail_attachments_message_id_gmail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."gmail_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_attachments" ADD CONSTRAINT "gmail_attachments_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_attachments" ADD CONSTRAINT "gmail_attachments_document_id_application_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."application_documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_attachments" ADD CONSTRAINT "gmail_attachments_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_messages" ADD CONSTRAINT "gmail_messages_connection_id_gmail_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."gmail_connections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_messages" ADD CONSTRAINT "gmail_messages_matched_agency_id_agencies_id_fk" FOREIGN KEY ("matched_agency_id") REFERENCES "public"."agencies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_messages" ADD CONSTRAINT "gmail_messages_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_messages" ADD CONSTRAINT "gmail_messages_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_messages" ADD CONSTRAINT "gmail_messages_communication_id_communications_id_fk" FOREIGN KEY ("communication_id") REFERENCES "public"."communications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_visa_fee_id_visa_fees_id_fk" FOREIGN KEY ("visa_fee_id") REFERENCES "public"."visa_fees"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_snapshot_id_application_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."application_snapshots"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_application_id_visa_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."visa_applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_read_by_users_id_fk" FOREIGN KEY ("read_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visa_applications" ADD CONSTRAINT "visa_applications_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visa_applications" ADD CONSTRAINT "visa_applications_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visa_applications" ADD CONSTRAINT "visa_applications_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visa_applications" ADD CONSTRAINT "visa_applications_visa_type_id_visa_types_id_fk" FOREIGN KEY ("visa_type_id") REFERENCES "public"."visa_types"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visa_applications" ADD CONSTRAINT "visa_applications_category_id_visa_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."visa_categories"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visa_applications" ADD CONSTRAINT "visa_applications_status_id_application_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."application_statuses"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visa_applications" ADD CONSTRAINT "visa_applications_priority_id_priorities_id_fk" FOREIGN KEY ("priority_id") REFERENCES "public"."priorities"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visa_applications" ADD CONSTRAINT "visa_applications_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visa_applications" ADD CONSTRAINT "visa_applications_submission_override_by_users_id_fk" FOREIGN KEY ("submission_override_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visa_applications" ADD CONSTRAINT "visa_applications_case_officer_user_id_users_id_fk" FOREIGN KEY ("case_officer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_idempotency_uq" ON "agency_wallet_transactions" USING btree ("agency_id","idempotency_key") WHERE "agency_wallet_transactions"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_agency_idx" ON "agency_wallet_transactions" USING btree ("agency_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_application_idx" ON "agency_wallet_transactions" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_chain_idx" ON "agency_wallet_transactions" USING btree ("reverses_tx_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_runs_application_idx" ON "ai_runs" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_runs_purpose_idx" ON "ai_runs" USING btree ("purpose");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_runs_document_idx" ON "ai_runs" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_suggestions_application_idx" ON "ai_suggestions" USING btree ("application_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_suggestions_run_idx" ON "ai_suggestions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_suggestions_open_idx" ON "ai_suggestions" USING btree ("status","confidence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applicants_application_idx" ON "applicants" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applicants_agency_idx" ON "applicants" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applicants_passport_idx" ON "applicants" USING btree ("passport_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_application_idx" ON "application_documents" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_agency_idx" ON "application_documents" USING btree ("agency_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_current_per_slot_uq" ON "application_documents" USING btree ("application_id","document_type_id",coalesce("applicant_id", '')) WHERE "application_documents"."is_current" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_type_idx" ON "application_documents" USING btree ("document_type_id","review_state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_media_uq" ON "application_documents" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_application_idx" ON "application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_agency_idx" ON "application_events" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_type_idx" ON "application_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snapshots_application_idx" ON "application_snapshots" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "communications_message_id_uq" ON "communications" USING btree ("message_id") WHERE "communications"."message_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communications_application_idx" ON "communications" USING btree ("application_id","sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communications_agency_idx" ON "communications" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communications_thread_idx" ON "communications" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gmail_attachment_uq" ON "gmail_attachments" USING btree ("message_id","attachment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gmail_attachment_document_idx" ON "gmail_attachments" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gmail_message_uq" ON "gmail_messages" USING btree ("connection_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gmail_match_idx" ON "gmail_messages" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gmail_review_idx" ON "gmail_messages" USING btree ("requires_review","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_items_charge_key_uq" ON "invoice_items" USING btree ("invoice_id","charge_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_items_invoice_idx" ON "invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_items_application_idx" ON "invoice_items" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_number_uq" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_agency_idx" ON "invoices" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_application_idx" ON "invoices" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_key_idx" ON "login_attempts" USING btree ("key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deliveries_idempotency_uq" ON "notification_deliveries" USING btree ("idempotency_key") WHERE "notification_deliveries"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_ready_idx" ON "notification_deliveries" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_notification_idx" ON "notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_dedupe_uq" ON "notifications" USING btree ("dedupe_key") WHERE "notifications"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_agency_idx" ON "notifications" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_kind_idx" ON "notifications" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_runs_key_uq" ON "task_runs" USING btree ("task_key","run_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_runs_status_idx" ON "task_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "applications_reference_uq" ON "visa_applications" USING btree ("reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_agency_idx" ON "visa_applications" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_status_idx" ON "visa_applications" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_activity_idx" ON "visa_applications" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_visa_type_idx" ON "visa_applications" USING btree ("visa_type_id");