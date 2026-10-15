-- Ключи идемпотентности (К6 п. 11): область scope потребителя, захват ключа с арендой, результат — каноническая строка JSON.
-- at — время захвата (RUNNING) или завершения (DONE), epoch ms по часам потребителя, не now() базы.
CREATE TABLE core_idempotency (
  scope     text     NOT NULL,
  key       text     NOT NULL,
  body_hash char(64) NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  state     text     NOT NULL CHECK (state IN ('RUNNING', 'DONE')),
  token     text     NOT NULL,
  result    text,
  at        bigint   NOT NULL,
  PRIMARY KEY (scope, key),
  CHECK ((state = 'DONE') = (result IS NOT NULL))
);
