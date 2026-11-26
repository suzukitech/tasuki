-- Hand-written (drizzle-kit cannot express FTS5). Keep in sync with issues.title/body_md.
CREATE VIRTUAL TABLE `issues_fts` USING fts5(title, body_md, content='issues', content_rowid='rowid', tokenize='trigram');
--> statement-breakpoint
CREATE TRIGGER `issues_fts_ai` AFTER INSERT ON `issues` BEGIN
  INSERT INTO issues_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
--> statement-breakpoint
CREATE TRIGGER `issues_fts_ad` AFTER DELETE ON `issues` BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
END;
--> statement-breakpoint
CREATE TRIGGER `issues_fts_au` AFTER UPDATE OF title, body_md ON `issues` BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
  INSERT INTO issues_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
