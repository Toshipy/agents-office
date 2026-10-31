CREATE TABLE "agent_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"prompt_version" text NOT NULL,
	"tool_policy" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"action_type" text NOT NULL,
	"requested_by_role" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"uri" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text,
	"project_id" text,
	"sequence" bigint NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"meta" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_workspace_id_key_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"agent_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"installation_id" bigint NOT NULL,
	"repository_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"automation_enabled" boolean DEFAULT false NOT NULL,
	"policy_json" jsonb NOT NULL,
	"verification" text DEFAULT 'simulated' NOT NULL,
	"next_pr_number" integer DEFAULT 1 NOT NULL,
	"next_issue_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"key" text NOT NULL,
	"role" text NOT NULL,
	"agent_id" text,
	"agent_version" integer,
	"model" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"error_code" text,
	"outcome" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"request" text NOT NULL,
	"workflow" text NOT NULL,
	"source" jsonb NOT NULL,
	"issue_key" text,
	"status" text NOT NULL,
	"status_version" integer DEFAULT 1 NOT NULL,
	"plan" jsonb,
	"guidance" text,
	"revision_count" integer DEFAULT 0 NOT NULL,
	"max_revision_attempts" integer DEFAULT 3 NOT NULL,
	"fix_loops" integer DEFAULT 0 NOT NULL,
	"budget_limit_usd" double precision NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"pr" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "step_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"estimated_cost_usd" double precision NOT NULL,
	"measurement" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"action" text,
	"installation_id" bigint,
	"repository_id" bigint,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	CONSTRAINT "webhook_deliveries_provider_delivery_id_pk" PRIMARY KEY("provider","delivery_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"monthly_budget_usd" double precision DEFAULT 50 NOT NULL,
	"run_budget_usd" double precision DEFAULT 2 NOT NULL,
	"max_concurrent_runs" integer DEFAULT 2 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"demo_traffic" boolean DEFAULT false NOT NULL,
	"event_sequence" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_owner_user_id_unique" UNIQUE("owner_user_id")
);
--> statement-breakpoint
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_bindings" ADD CONSTRAINT "repository_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_bindings" ADD CONSTRAINT "repository_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_def_ws_role_uq" ON "agent_definitions" USING btree ("workspace_id","role");--> statement-breakpoint
CREATE INDEX "approvals_ws_status_idx" ON "approvals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "artifacts_run_idx" ON "artifacts" USING btree ("workspace_id","run_id");--> statement-breakpoint
CREATE INDEX "audit_ws_created_idx" ON "audit_logs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_logs_ws_seq_uq" ON "event_logs" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE INDEX "projects_ws_idx" ON "projects" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_binding_ws_repo_uq" ON "repository_bindings" USING btree ("workspace_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_binding_project_uq" ON "repository_bindings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "repo_binding_install_repo_idx" ON "repository_bindings" USING btree ("installation_id","repository_id");--> statement-breakpoint
CREATE INDEX "steps_run_idx" ON "run_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "steps_ws_status_idx" ON "run_steps" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "runs_ws_status_idx" ON "runs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "runs_ws_created_idx" ON "runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_issue_key_idx" ON "runs" USING btree ("workspace_id","issue_key");--> statement-breakpoint
CREATE INDEX "step_logs_run_idx" ON "step_logs" USING btree ("workspace_id","run_id","id");--> statement-breakpoint
CREATE INDEX "usage_ws_created_idx" ON "usage_records" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_unprocessed_idx" ON "webhook_deliveries" USING btree ("processed_at");