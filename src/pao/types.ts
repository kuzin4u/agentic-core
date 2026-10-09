// Сгенерировано scripts/gen-pao.mjs из spec/agent-protocol.yaml — не править вручную (К5).
// Протокол агентских операций (ПАО) 1.1.0, sha-256 e6725aa4270155be5d0606cb366ca095fedc13a7d4e6c7b9500d25addf945ecb

export const PAO_VERSION = "1.1.0";
export const PAO_SPEC_SHA256 = "e6725aa4270155be5d0606cb366ca095fedc13a7d4e6c7b9500d25addf945ecb";

export type ErrorCode = "AGENT_UNKNOWN" | "AGENT_SUSPENDED" | "AGENT_KEY_REVOKED" | "SIGNATURE_INVALID" | "MANDATE_NOT_FOUND" | "MANDATE_EXPIRED" | "MANDATE_REVOKED" | "MANDATE_SCOPE" | "PRINCIPAL_SIGNATURE_PENDING" | "LIMIT_EXCEEDED" | "STATE_UNAVAILABLE" | "CONFIRMATION_REQUIRED" | "CREDENTIAL_INVALID" | "CREDENTIALS_FORBIDDEN" | "IDEMPOTENCY_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE";

export interface Error {
  code: ErrorCode;
  message: string;
  norm?: string;
  retry: "never" | "after_fix" | "same_key" | "new_key" | "after_human";
}

export interface Configuration {
  versions?: Array<string>;
  sunset?: Record<string, string>;
  platform_keys?: Array<Key>;
  algorithms?: Array<"ed25519" | "gost3410-2012-256">;
  endpoints?: Record<string, string>;
}

export interface Key {
  kid: string;
  alg: string;
  public_key: string;
  valid_from?: string;
  valid_to?: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
}

export interface AgentSelf {
  agent_code?: string;
  operator?: string;
  class?: "BUYER" | "SELLER" | "SURFACE" | "SERVICE";
  level?: number;
  status?: "ACTIVE" | "SUSPENDED" | "EXCLUDED";
  keys?: Array<Key>;
  rate_limit_per_min?: number;
}

export interface MandateRequest {
  type: "INTENT" | "CART";
  parent_id?: string | null;
  subject: string;
  amount_limit: number;
  currency: string;
  period?: string;
  valid_to: string;
  merchant_scope: Array<string>;
  principal_ref: string;
  mode: "IMMEDIATE" | "AUTONOMOUS";
  /** агент показал ключевые параметры отдельно от текста (Т3а) */
  key_terms_shown?: boolean;
  cart?: {
    merchant_id?: string;
    items?: Array<{
      sku?: string;
      qty?: number;
      price?: number;
    }>;
    total?: number;
  } | null;
  settlement_mode?: "DIRECT" | "CONDITIONAL";
  /** только при settlement_mode=CONDITIONAL */
  conditional?: {
    provider?: string;
    deal_ref?: string;
  } | null;
}

export type Mandate = MandateRequest & {
  id?: string;
  agent_code?: string;
  status?: "PENDING_SIGNATURE" | "ACTIVE" | "REJECTED" | "EXPIRED" | "REVOKED" | "EXHAUSTED";
  signature_type?: "simple" | "qualified" | "gov_id";
  created_at?: string;
  hash?: string;
  prev_hash?: string;
};

export interface MandateVerify {
  outcome: "CONFIRMED" | "OUT_OF_SCOPE" | "STATE_UNKNOWN";
  amount_left: number;
  valid_to: string;
  as_of?: string;
}

export interface Evidence {
  mandate_chain?: Array<Mandate>;
  operations?: Array<Operation>;
  integrity?: "OK" | "BROKEN";
}

export interface Aoi {
  indicator: boolean;
  agent_code: string;
  mandate_id: string;
  fulfilment_ref?: string | null;
  deal_ref?: string | null;
}

export interface CredentialRequest {
  mandate_id: string;
  order_ref: string;
  merchant_id: string;
  amount_max: number;
  currency: string;
  kind: "CARD" | "SBP";
}

export interface Credential {
  credential_ref: string;
  kind: "CARD" | "SBP";
  /** криптограмма агентского токена или идентификатор списания по привязке; номера карты нет */
  payload: {
    token_ref?: string;
    cryptogram?: string;
    account_link_ref?: string;
    valid_to?: string;
  };
  aoi: Aoi;
  status: "ISSUED" | "USED" | "EXPIRED" | "REVOKED";
}

export interface ConfirmationRequest {
  mandate_id: string;
  merchant_id: string;
  amount: number;
  summary: string;
  channel?: "UPK" | "ISSUER_APP";
}

export interface Confirmation {
  id?: string;
  status?: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  /** ссылка УПК для человека */
  link?: string;
  confirmation_ref?: string | null;
  expires_at?: string;
}

export interface Operation {
  op_ref?: string;
  order_ref?: string;
  channel?: "CARD" | "SBP";
  amount?: number;
  merchant_id?: string;
  aoi?: Aoi;
  status?: "AUTHORIZED" | "DECLINED" | "CONFIRMATION_REQUIRED" | "SETTLED" | "REVERSED" | "REFUNDED";
  reason?: string | null;
  fulfilment?: {
    fulfilment_ref?: string;
    final_amount?: number;
    scope_check?: string;
    spent_position?: number;
    at?: string;
  } | null;
  deal_ref?: string | null;
  deal_outcome?: null | "RELEASED" | "RETURNED" | "PARTIAL";
}

export interface DisputeRequest {
  op_ref: string;
  reason: "NOT_AUTHORIZED" | "QUALITY" | "NOT_DELIVERED";
  /** подтверждение принципала из приложения банка */
  principal_ack: string;
}

export interface Dispute {
  id?: string;
  op_ref?: string;
  reason?: string;
  in_scope?: boolean;
  decision?: "REFUND_NO_MERITS" | "ORDINARY_PROCEDURE" | "REJECTED" | "PENDING";
}

export interface Subscription {
  url: string;
  events: Array<string>;
}

export interface Event {
  event_id: string;
  type: "mandate.signed" | "mandate.rejected" | "mandate.revoked" | "mandate.exhausted" | "confirmation.required" | "confirmation.approved" | "confirmation.rejected" | "confirmation.expired" | "operation.authorized" | "operation.declined" | "operation.settled" | "operation.refunded" | "agent.key_revoked" | "agent.suspended" | "agent.reinstated" | "dispute.updated" | "deal.funded" | "deal.released" | "deal.returned";
  at: string;
  data: Record<string, unknown>;
}

/** Операции ПАО: ключ — «МЕТОД путь» как в спецификации. */
export interface PaoOperations {
  /** Обнаружение */
  "GET /.well-known/pao-configuration": {
    path: never;
    query: never;
    body: never;
    response: Configuration;
  };
  /** Свой статус */
  "GET /pao/v1/agent": {
    path: never;
    query: never;
    body: never;
    response: AgentSelf;
  };
  /** Новый ключ */
  "POST /pao/v1/agent/keys": {
    path: never;
    query: never;
    body: {
      alg: string;
      public_key: string;
    };
    response: Key;
  };
  /** Отзыв своего ключа */
  "POST /pao/v1/agent/keys/{kid}/revoke": {
    path: { kid: string; };
    query: never;
    body: never;
    response: Key;
  };
  /** Запрос мандата; подпись — у принципала в банке */
  "POST /pao/v1/mandates": {
    path: never;
    query: never;
    body: MandateRequest;
    response: Mandate;
  };
  /** Мандат этого агента */
  "GET /pao/v1/mandates/{id}": {
    path: { id: string; };
    query: never;
    body: never;
    response: Mandate;
  };
  /** Проверка и остаток */
  "GET /pao/v1/mandates/{id}/verify": {
    path: { id: string; };
    query: never;
    body: never;
    response: MandateVerify;
  };
  /** Отказ агента от полномочий */
  "POST /pao/v1/mandates/{id}/relinquish": {
    path: { id: string; };
    query: never;
    body: never;
    response: Mandate;
  };
  /** Выписка из журнала согласий */
  "GET /pao/v1/mandates/{id}/evidence": {
    path: { id: string; };
    query: never;
    body: never;
    response: Evidence;
  };
  /** Агентский платёжный реквизит на заказ */
  "POST /pao/v1/credentials": {
    path: never;
    query: never;
    body: CredentialRequest;
    response: Credential;
  };
  /** Статус реквизита */
  "GET /pao/v1/credentials/{ref}": {
    path: { ref: string; };
    query: never;
    body: never;
    response: Credential;
  };
  /** Запросить подтверждение у человека */
  "POST /pao/v1/confirmations": {
    path: never;
    query: never;
    body: ConfirmationRequest;
    response: Confirmation;
  };
  /** Статус подтверждения */
  "GET /pao/v1/confirmations/{id}": {
    path: { id: string; };
    query: never;
    body: never;
    response: Confirmation;
  };
  /** Операции по мандату */
  "GET /pao/v1/operations": {
    path: never;
    query: { mandate_id: string; };
    body: never;
    response: Array<Operation>;
  };
  /** Операция */
  "GET /pao/v1/operations/{op_ref}": {
    path: { op_ref: string; };
    query: never;
    body: never;
    response: Operation;
  };
  /** Спор по поручению человека */
  "POST /pao/v1/disputes": {
    path: never;
    query: never;
    body: DisputeRequest;
    response: Dispute;
  };
  /** Спор */
  "GET /pao/v1/disputes/{id}": {
    path: { id: string; };
    query: never;
    body: never;
    response: Dispute;
  };
  /** Подписка на события */
  "PUT /pao/v1/subscription": {
    path: never;
    query: never;
    body: Subscription;
    response: Subscription;
  };
  /** События (pull) */
  "GET /pao/v1/events": {
    path: never;
    query: { after?: string; };
    body: never;
    response: Array<Event>;
  };
}
export type PaoOperationKey = keyof PaoOperations;

export interface PaoOperationSpec {
  method: string; path: string; signed: boolean; idempotent: boolean; success: number; errors: readonly number[];
  pathParams: readonly string[]; query: readonly { name: string; required: boolean }[]; body?: unknown; response?: unknown;
}

export const PAO_OPERATIONS: Record<PaoOperationKey, PaoOperationSpec> = {
  "GET /.well-known/pao-configuration": {
    "method": "GET",
    "path": "/.well-known/pao-configuration",
    "signed": false,
    "idempotent": false,
    "success": 200,
    "errors": [],
    "pathParams": [],
    "query": [],
    "response": {
      "$ref": "#/components/schemas/Configuration"
    }
  },
  "GET /pao/v1/agent": {
    "method": "GET",
    "path": "/pao/v1/agent",
    "signed": true,
    "idempotent": false,
    "success": 200,
    "errors": [
      401,
      403
    ],
    "pathParams": [],
    "query": [],
    "response": {
      "$ref": "#/components/schemas/AgentSelf"
    }
  },
  "POST /pao/v1/agent/keys": {
    "method": "POST",
    "path": "/pao/v1/agent/keys",
    "signed": true,
    "idempotent": true,
    "success": 201,
    "errors": [
      401
    ],
    "pathParams": [],
    "query": [],
    "body": {
      "type": "object",
      "required": [
        "alg",
        "public_key"
      ],
      "properties": {
        "alg": {
          "type": "string"
        },
        "public_key": {
          "type": "string"
        }
      }
    },
    "response": {
      "$ref": "#/components/schemas/Key"
    }
  },
  "POST /pao/v1/agent/keys/{kid}/revoke": {
    "method": "POST",
    "path": "/pao/v1/agent/keys/{kid}/revoke",
    "signed": true,
    "idempotent": true,
    "success": 200,
    "errors": [
      401
    ],
    "pathParams": [
      "kid"
    ],
    "query": [],
    "response": {
      "$ref": "#/components/schemas/Key"
    }
  },
  "POST /pao/v1/mandates": {
    "method": "POST",
    "path": "/pao/v1/mandates",
    "signed": true,
    "idempotent": true,
    "success": 201,
    "errors": [
      400,
      409
    ],
    "pathParams": [],
    "query": [],
    "body": {
      "$ref": "#/components/schemas/MandateRequest"
    },
    "response": {
      "$ref": "#/components/schemas/Mandate"
    }
  },
  "GET /pao/v1/mandates/{id}": {
    "method": "GET",
    "path": "/pao/v1/mandates/{id}",
    "signed": true,
    "idempotent": false,
    "success": 200,
    "errors": [
      404
    ],
    "pathParams": [
      "id"
    ],
    "query": [],
    "response": {
      "$ref": "#/components/schemas/Mandate"
    }
  },
  "GET /pao/v1/mandates/{id}/verify": {
    "method": "GET",
    "path": "/pao/v1/mandates/{id}/verify",
    "signed": true,
    "idempotent": false,
    "success": 200,
    "errors": [
      404,
      503
    ],
    "pathParams": [
      "id"
    ],
    "query": [],
    "response": {
      "$ref": "#/components/schemas/MandateVerify"
    }
  },
  "POST /pao/v1/mandates/{id}/relinquish": {
    "method": "POST",
    "path": "/pao/v1/mandates/{id}/relinquish",
    "signed": true,
    "idempotent": true,
    "success": 200,
    "errors": [],
    "pathParams": [
      "id"
    ],
    "query": [],
    "response": {
      "$ref": "#/components/schemas/Mandate"
    }
  },
  "GET /pao/v1/mandates/{id}/evidence": {
    "method": "GET",
    "path": "/pao/v1/mandates/{id}/evidence",
    "signed": true,
    "idempotent": false,
    "success": 200,
    "errors": [],
    "pathParams": [
      "id"
    ],
    "query": [],
    "response": {
      "$ref": "#/components/schemas/Evidence"
    }
  },
  "POST /pao/v1/credentials": {
    "method": "POST",
    "path": "/pao/v1/credentials",
    "signed": true,
    "idempotent": true,
    "success": 201,
    "errors": [
      409,
      422,
      428,
      503
    ],
    "pathParams": [],
    "query": [],
    "body": {
      "$ref": "#/components/schemas/CredentialRequest"
    },
    "response": {
      "$ref": "#/components/schemas/Credential"
    }
  },
  "GET /pao/v1/credentials/{ref}": {
    "method": "GET",
    "path": "/pao/v1/credentials/{ref}",
    "signed": true,
    "idempotent": false,
    "success": 200,
    "errors": [],
    "pathParams": [
      "ref"
    ],
    "query": [],
    "response": {
      "$ref": "#/components/schemas/Credential"
    }
  },
  "POST /pao/v1/confirmations": {
    "method": "POST",
    "path": "/pao/v1/confirmations",
    "signed": true,
    "idempotent": true,
    "success": 201,
    "errors": [],
    "pathParams": [],
    "query": [],
    "body": {
      "$ref": "#/components/schemas/ConfirmationRequest"
    },
    "response": {
      "$ref": "#/components/schemas/Confirmation"
    }
  },
  "GET /pao/v1/confirmations/{id}": {
    "method": "GET",
    "path": "/pao/v1/confirmations/{id}",
    "signed": true,
    "idempotent": false,
    "success": 200,
    "errors": [],
    "pathParams": [
      "id"
    ],
    "query": [],
    "response": {
      "$ref": "#/components/schemas/Confirmation"
    }
  },
  "GET /pao/v1/operations": {
    "method": "GET",
    "path": "/pao/v1/operations",
    "signed": true,
    "idempotent": false,
    "success": 200,
    "errors": [],
    "pathParams": [],
    "query": [
      {
        "name": "mandate_id",
        "required": true
      }
    ],
    "response": {
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/Operation"
      }
    }
  },
  "GET /pao/v1/operations/{op_ref}": {
    "method": "GET",
    "path": "/pao/v1/operations/{op_ref}",
    "signed": true,
    "idempotent": false,
    "success": 200,
    "errors": [
      404
    ],
    "pathParams": [
      "op_ref"
    ],
    "query": [],
    "response": {
      "$ref": "#/components/schemas/Operation"
    }
  },
  "POST /pao/v1/disputes": {
    "method": "POST",
    "path": "/pao/v1/disputes",
    "signed": true,
    "idempotent": true,
    "success": 201,
    "errors": [],
    "pathParams": [],
    "query": [],
    "body": {
      "$ref": "#/components/schemas/DisputeRequest"
    },
    "response": {
      "$ref": "#/components/schemas/Dispute"
    }
  },
  "GET /pao/v1/disputes/{id}": {
    "method": "GET",
    "path": "/pao/v1/disputes/{id}",
    "signed": true,
    "idempotent": false,
    "success": 200,
    "errors": [],
    "pathParams": [
      "id"
    ],
    "query": [],
    "response": {
      "$ref": "#/components/schemas/Dispute"
    }
  },
  "PUT /pao/v1/subscription": {
    "method": "PUT",
    "path": "/pao/v1/subscription",
    "signed": true,
    "idempotent": true,
    "success": 200,
    "errors": [],
    "pathParams": [],
    "query": [],
    "body": {
      "$ref": "#/components/schemas/Subscription"
    },
    "response": {
      "$ref": "#/components/schemas/Subscription"
    }
  },
  "GET /pao/v1/events": {
    "method": "GET",
    "path": "/pao/v1/events",
    "signed": true,
    "idempotent": false,
    "success": 200,
    "errors": [],
    "pathParams": [],
    "query": [
      {
        "name": "after",
        "required": false
      }
    ],
    "response": {
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/Event"
      }
    }
  }
};

/** Схемы components.schemas как в спецификации — для проверки тел в сервере-заглушке. */
export const PAO_SCHEMAS: Record<string, unknown> = {
  "ErrorCode": {
    "type": "string",
    "enum": [
      "AGENT_UNKNOWN",
      "AGENT_SUSPENDED",
      "AGENT_KEY_REVOKED",
      "SIGNATURE_INVALID",
      "MANDATE_NOT_FOUND",
      "MANDATE_EXPIRED",
      "MANDATE_REVOKED",
      "MANDATE_SCOPE",
      "PRINCIPAL_SIGNATURE_PENDING",
      "LIMIT_EXCEEDED",
      "STATE_UNAVAILABLE",
      "CONFIRMATION_REQUIRED",
      "CREDENTIAL_INVALID",
      "CREDENTIALS_FORBIDDEN",
      "IDEMPOTENCY_REQUIRED",
      "IDEMPOTENCY_CONFLICT",
      "RATE_LIMITED",
      "UPSTREAM_UNAVAILABLE"
    ]
  },
  "Error": {
    "type": "object",
    "required": [
      "code",
      "message",
      "retry"
    ],
    "properties": {
      "code": {
        "$ref": "#/components/schemas/ErrorCode"
      },
      "message": {
        "type": "string"
      },
      "norm": {
        "type": "string"
      },
      "retry": {
        "type": "string",
        "enum": [
          "never",
          "after_fix",
          "same_key",
          "new_key",
          "after_human"
        ]
      }
    }
  },
  "Configuration": {
    "type": "object",
    "properties": {
      "versions": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "sunset": {
        "type": "object",
        "additionalProperties": {
          "type": "string",
          "format": "date"
        }
      },
      "platform_keys": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/Key"
        }
      },
      "algorithms": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "ed25519",
            "gost3410-2012-256"
          ]
        }
      },
      "endpoints": {
        "type": "object",
        "additionalProperties": {
          "type": "string"
        }
      }
    }
  },
  "Key": {
    "type": "object",
    "required": [
      "kid",
      "alg",
      "public_key",
      "status"
    ],
    "properties": {
      "kid": {
        "type": "string"
      },
      "alg": {
        "type": "string"
      },
      "public_key": {
        "type": "string"
      },
      "valid_from": {
        "type": "string",
        "format": "date-time"
      },
      "valid_to": {
        "type": "string",
        "format": "date-time"
      },
      "status": {
        "type": "string",
        "enum": [
          "ACTIVE",
          "REVOKED",
          "EXPIRED"
        ]
      }
    }
  },
  "AgentSelf": {
    "type": "object",
    "properties": {
      "agent_code": {
        "type": "string"
      },
      "operator": {
        "type": "string"
      },
      "class": {
        "type": "string",
        "enum": [
          "BUYER",
          "SELLER",
          "SURFACE",
          "SERVICE"
        ]
      },
      "level": {
        "type": "integer"
      },
      "status": {
        "type": "string",
        "enum": [
          "ACTIVE",
          "SUSPENDED",
          "EXCLUDED"
        ]
      },
      "keys": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/Key"
        }
      },
      "rate_limit_per_min": {
        "type": "integer"
      }
    }
  },
  "MandateRequest": {
    "type": "object",
    "required": [
      "type",
      "subject",
      "amount_limit",
      "currency",
      "valid_to",
      "merchant_scope",
      "principal_ref",
      "mode"
    ],
    "properties": {
      "type": {
        "type": "string",
        "enum": [
          "INTENT",
          "CART"
        ]
      },
      "parent_id": {
        "type": "string",
        "nullable": true
      },
      "subject": {
        "type": "string"
      },
      "amount_limit": {
        "type": "integer",
        "minimum": 1
      },
      "currency": {
        "type": "string"
      },
      "period": {
        "type": "string"
      },
      "valid_to": {
        "type": "string",
        "format": "date-time"
      },
      "merchant_scope": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "principal_ref": {
        "type": "string"
      },
      "mode": {
        "type": "string",
        "enum": [
          "IMMEDIATE",
          "AUTONOMOUS"
        ]
      },
      "key_terms_shown": {
        "type": "boolean",
        "description": "агент показал ключевые параметры отдельно от текста (Т3а)"
      },
      "cart": {
        "type": "object",
        "nullable": true,
        "properties": {
          "merchant_id": {
            "type": "string"
          },
          "items": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "sku": {
                  "type": "string"
                },
                "qty": {
                  "type": "integer"
                },
                "price": {
                  "type": "integer"
                }
              }
            }
          },
          "total": {
            "type": "integer"
          }
        }
      },
      "settlement_mode": {
        "type": "string",
        "enum": [
          "DIRECT",
          "CONDITIONAL"
        ],
        "default": "DIRECT"
      },
      "conditional": {
        "type": "object",
        "nullable": true,
        "description": "только при settlement_mode=CONDITIONAL",
        "properties": {
          "provider": {
            "type": "string",
            "example": "cx:nsvr"
          },
          "deal_ref": {
            "type": "string"
          }
        }
      }
    }
  },
  "Mandate": {
    "allOf": [
      {
        "$ref": "#/components/schemas/MandateRequest"
      },
      {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "agent_code": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "PENDING_SIGNATURE",
              "ACTIVE",
              "REJECTED",
              "EXPIRED",
              "REVOKED",
              "EXHAUSTED"
            ]
          },
          "signature_type": {
            "type": "string",
            "enum": [
              "simple",
              "qualified",
              "gov_id"
            ]
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "hash": {
            "type": "string"
          },
          "prev_hash": {
            "type": "string"
          }
        }
      }
    ]
  },
  "MandateVerify": {
    "type": "object",
    "required": [
      "outcome",
      "amount_left",
      "valid_to"
    ],
    "properties": {
      "outcome": {
        "type": "string",
        "enum": [
          "CONFIRMED",
          "OUT_OF_SCOPE",
          "STATE_UNKNOWN"
        ]
      },
      "amount_left": {
        "type": "integer"
      },
      "valid_to": {
        "type": "string",
        "format": "date-time"
      },
      "as_of": {
        "type": "string",
        "format": "date-time"
      }
    }
  },
  "Evidence": {
    "type": "object",
    "properties": {
      "mandate_chain": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/Mandate"
        }
      },
      "operations": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/Operation"
        }
      },
      "integrity": {
        "type": "string",
        "enum": [
          "OK",
          "BROKEN"
        ]
      }
    }
  },
  "Aoi": {
    "type": "object",
    "required": [
      "indicator",
      "agent_code",
      "mandate_id"
    ],
    "properties": {
      "indicator": {
        "type": "boolean"
      },
      "agent_code": {
        "type": "string"
      },
      "mandate_id": {
        "type": "string"
      },
      "fulfilment_ref": {
        "type": "string",
        "nullable": true
      },
      "deal_ref": {
        "type": "string",
        "nullable": true
      }
    }
  },
  "CredentialRequest": {
    "type": "object",
    "required": [
      "mandate_id",
      "order_ref",
      "merchant_id",
      "amount_max",
      "currency",
      "kind"
    ],
    "properties": {
      "mandate_id": {
        "type": "string"
      },
      "order_ref": {
        "type": "string"
      },
      "merchant_id": {
        "type": "string"
      },
      "amount_max": {
        "type": "integer"
      },
      "currency": {
        "type": "string"
      },
      "kind": {
        "type": "string",
        "enum": [
          "CARD",
          "SBP"
        ]
      }
    }
  },
  "Credential": {
    "type": "object",
    "required": [
      "credential_ref",
      "kind",
      "payload",
      "aoi",
      "status"
    ],
    "properties": {
      "credential_ref": {
        "type": "string"
      },
      "kind": {
        "type": "string",
        "enum": [
          "CARD",
          "SBP"
        ]
      },
      "payload": {
        "type": "object",
        "description": "криптограмма агентского токена или идентификатор списания по привязке; номера карты нет",
        "properties": {
          "token_ref": {
            "type": "string"
          },
          "cryptogram": {
            "type": "string"
          },
          "account_link_ref": {
            "type": "string"
          },
          "valid_to": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "aoi": {
        "$ref": "#/components/schemas/Aoi"
      },
      "status": {
        "type": "string",
        "enum": [
          "ISSUED",
          "USED",
          "EXPIRED",
          "REVOKED"
        ]
      }
    }
  },
  "ConfirmationRequest": {
    "type": "object",
    "required": [
      "mandate_id",
      "merchant_id",
      "amount",
      "summary"
    ],
    "properties": {
      "mandate_id": {
        "type": "string"
      },
      "merchant_id": {
        "type": "string"
      },
      "amount": {
        "type": "integer"
      },
      "summary": {
        "type": "string"
      },
      "channel": {
        "type": "string",
        "enum": [
          "UPK",
          "ISSUER_APP"
        ]
      }
    }
  },
  "Confirmation": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "status": {
        "type": "string",
        "enum": [
          "PENDING",
          "APPROVED",
          "REJECTED",
          "EXPIRED"
        ]
      },
      "link": {
        "type": "string",
        "description": "ссылка УПК для человека"
      },
      "confirmation_ref": {
        "type": "string",
        "nullable": true
      },
      "expires_at": {
        "type": "string",
        "format": "date-time"
      }
    }
  },
  "Operation": {
    "type": "object",
    "properties": {
      "op_ref": {
        "type": "string"
      },
      "order_ref": {
        "type": "string"
      },
      "channel": {
        "type": "string",
        "enum": [
          "CARD",
          "SBP"
        ]
      },
      "amount": {
        "type": "integer"
      },
      "merchant_id": {
        "type": "string"
      },
      "aoi": {
        "$ref": "#/components/schemas/Aoi"
      },
      "status": {
        "type": "string",
        "enum": [
          "AUTHORIZED",
          "DECLINED",
          "CONFIRMATION_REQUIRED",
          "SETTLED",
          "REVERSED",
          "REFUNDED"
        ]
      },
      "reason": {
        "type": "string",
        "nullable": true
      },
      "fulfilment": {
        "type": "object",
        "nullable": true,
        "properties": {
          "fulfilment_ref": {
            "type": "string"
          },
          "final_amount": {
            "type": "integer"
          },
          "scope_check": {
            "type": "string"
          },
          "spent_position": {
            "type": "integer"
          },
          "at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "deal_ref": {
        "type": "string",
        "nullable": true
      },
      "deal_outcome": {
        "type": "string",
        "nullable": true,
        "enum": [
          null,
          "RELEASED",
          "RETURNED",
          "PARTIAL"
        ]
      }
    }
  },
  "DisputeRequest": {
    "type": "object",
    "required": [
      "op_ref",
      "reason",
      "principal_ack"
    ],
    "properties": {
      "op_ref": {
        "type": "string"
      },
      "reason": {
        "type": "string",
        "enum": [
          "NOT_AUTHORIZED",
          "QUALITY",
          "NOT_DELIVERED"
        ]
      },
      "principal_ack": {
        "type": "string",
        "description": "подтверждение принципала из приложения банка"
      }
    }
  },
  "Dispute": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "op_ref": {
        "type": "string"
      },
      "reason": {
        "type": "string"
      },
      "in_scope": {
        "type": "boolean"
      },
      "decision": {
        "type": "string",
        "enum": [
          "REFUND_NO_MERITS",
          "ORDINARY_PROCEDURE",
          "REJECTED",
          "PENDING"
        ]
      }
    }
  },
  "Subscription": {
    "type": "object",
    "required": [
      "url",
      "events"
    ],
    "properties": {
      "url": {
        "type": "string"
      },
      "events": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    }
  },
  "Event": {
    "type": "object",
    "required": [
      "event_id",
      "type",
      "at",
      "data"
    ],
    "properties": {
      "event_id": {
        "type": "string"
      },
      "type": {
        "type": "string",
        "enum": [
          "mandate.signed",
          "mandate.rejected",
          "mandate.revoked",
          "mandate.exhausted",
          "confirmation.required",
          "confirmation.approved",
          "confirmation.rejected",
          "confirmation.expired",
          "operation.authorized",
          "operation.declined",
          "operation.settled",
          "operation.refunded",
          "agent.key_revoked",
          "agent.suspended",
          "agent.reinstated",
          "dispute.updated",
          "deal.funded",
          "deal.released",
          "deal.returned"
        ]
      },
      "at": {
        "type": "string",
        "format": "date-time"
      },
      "data": {
        "type": "object"
      }
    }
  }
};
