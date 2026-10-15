-- Использованные nonce подписанных обращений (К6 п. 12): область scope потребителя, at — epoch ms по часам потребителя.
-- Проверка и запись — одной командой (INSERT … ON CONFLICT DO NOTHING); очистка — purge() старше retainMs.
CREATE TABLE core_nonces (
  scope text   NOT NULL,
  nonce text   NOT NULL,
  at    bigint NOT NULL,
  PRIMARY KEY (scope, nonce)
);

CREATE INDEX core_nonces_scope_at ON core_nonces (scope, at);
