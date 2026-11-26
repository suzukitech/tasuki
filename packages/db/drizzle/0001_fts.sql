-- Hand-written (drizzle-kit cannot express FTS5). Keep in sync with issues.title/body_md.
-- Own-content table keyed by issue_id: issues has a text PK, so its implicit rowid is not stable across VACUUM.
CREATE VIRTUAL TABLE `issues_fts` USING fts5(issue_id UNINDEXED, title, body_md, tokenize='trigram');
--> statement-breakpoint
CREATE TRIGGER `issues_fts_ai` AFTER INSERT ON `issues` BEGIN
  INSERT INTO issues_fts(issue_id, title, body_md) VALUES (new.id, new.title, new.body_md);
END;
--> statement-breakpoint
CREATE TRIGGER `issues_fts_ad` AFTER DELETE ON `issues` BEGIN
  DELETE FROM issues_fts WHERE issue_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `issues_fts_au` AFTER UPDATE OF title, body_md ON `issues` BEGIN
  UPDATE issues_fts SET title = new.title, body_md = new.body_md WHERE issue_id = old.id;
END;
