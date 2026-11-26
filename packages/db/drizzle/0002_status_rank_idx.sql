DROP INDEX `issues_status_idx`;--> statement-breakpoint
CREATE INDEX `issues_status_idx` ON `issues` (`status_id`,`rank`);