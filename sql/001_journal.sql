-- Журнал с хэш-цепочкой (К6): одна таблица на много цепочек, только добавление.
-- Хэш считает пакет (entryHash); chain в хэш не входит. payload — каноническая строка JSON, не jsonb.
CREATE TABLE core_journal (
  chain      text     NOT NULL,
  seq        bigint   NOT NULL CHECK (seq >= 1),
  at         text     NOT NULL,
  kind       text     NOT NULL,
  ref        text     NOT NULL,
  parent_ref text,
  payload    text     NOT NULL,
  prev_hash  char(64) NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash       char(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (chain, seq),
  UNIQUE (chain, prev_hash)
);

CREATE FUNCTION core_journal_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'core_journal: только добавление, % запрещён', TG_OP USING ERRCODE = 'restrict_violation';
END
$$;

-- UPDATE и DELETE — строковым триггером.
CREATE TRIGGER core_journal_no_update_delete
  BEFORE UPDATE OR DELETE ON core_journal
  FOR EACH ROW EXECUTE FUNCTION core_journal_append_only();

-- TRUNCATE — триггером уровня оператора: строкового для него не бывает.
CREATE TRIGGER core_journal_no_truncate
  BEFORE TRUNCATE ON core_journal
  FOR EACH STATEMENT EXECUTE FUNCTION core_journal_append_only();
