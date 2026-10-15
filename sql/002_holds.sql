-- Удержания (К6 п. 10, К9): счёт и его удержания в одной валюте, суммы — целые минимальные единицы в bigint.
-- Инварианты остатка проверяет пакет условием в UPDATE; CHECK в базе — последний рубеж.
CREATE TABLE core_hold_accounts (
  id           text   PRIMARY KEY,
  currency     text   NOT NULL CHECK (currency ~ '^[A-Z][A-Z0-9]{2,11}$'),
  limit_amount bigint NOT NULL CHECK (limit_amount >= 0),
  committed    bigint NOT NULL DEFAULT 0 CHECK (committed >= 0),
  reserved     bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  version      bigint NOT NULL DEFAULT 0,
  CHECK (committed + reserved <= limit_amount)
);

-- id удержания для потребителя — 'HLD-' || seq.
CREATE TABLE core_holds (
  seq        bigserial PRIMARY KEY,
  account    text   NOT NULL REFERENCES core_hold_accounts (id),
  ref        text   NOT NULL UNIQUE,
  currency   text   NOT NULL,
  amount     bigint NOT NULL CHECK (amount > 0),
  committed  bigint NOT NULL DEFAULT 0 CHECK (committed >= 0),
  released   bigint NOT NULL DEFAULT 0 CHECK (released >= 0),
  state      text   NOT NULL CHECK (state IN ('RESERVED', 'COMMITTED', 'RELEASED', 'PARTIAL')),
  expires_at bigint,
  CHECK (committed + released <= amount)
);

-- Истечение (expire) ищет открытые удержания со сроком.
CREATE INDEX core_holds_open_expiry ON core_holds (expires_at) WHERE expires_at IS NOT NULL AND committed + released < amount;
