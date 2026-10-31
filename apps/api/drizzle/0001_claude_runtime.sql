ALTER TABLE "repository_bindings" ADD COLUMN "local_path" text;--> statement-breakpoint
ALTER TABLE "repository_bindings" ADD COLUMN "test_command" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "runtime" text DEFAULT 'simulated' NOT NULL;