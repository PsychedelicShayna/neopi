-- Exact Markdown originals, including YAML comments and spelling. Deliberately
-- no cascading foreign key: removing a card must not remove its import source.
CREATE TABLE IF NOT EXISTS card_legacy_originals (
    task_id TEXT NOT NULL,
    body TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (task_id, body)
);
CREATE TRIGGER IF NOT EXISTS card_legacy_originals_no_update
BEFORE UPDATE ON card_legacy_originals BEGIN
    SELECT RAISE(ABORT, 'card legacy originals are immutable');
END;
CREATE TRIGGER IF NOT EXISTS card_legacy_originals_no_delete
BEFORE DELETE ON card_legacy_originals BEGIN
    SELECT RAISE(ABORT, 'card legacy originals are immutable');
END;
