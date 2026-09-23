-- Real CDK v0.18.1 mint SQLite schema, commit a056e0f0f69e94f431b1aeb90d883f18c61ea4c6
-- Extracted by building cdk-sqlite from source and constructing a real, fully-migrated
-- MintSqliteDatabase, then reading sqlite_master directly. Not hand-composed from migrations.

CREATE TABLE "blind_signature" (
    blinded_message BLOB PRIMARY KEY,
    amount INTEGER NOT NULL,
    keyset_id TEXT NOT NULL,
    c BLOB NULL,
    dleq_e TEXT,
    dleq_s TEXT,
    quote_id TEXT,
    created_time INTEGER NOT NULL DEFAULT 0,
    signed_time INTEGER
, operation_kind TEXT, operation_id TEXT, order_index INTEGER DEFAULT 0);

CREATE TABLE completed_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    operation_kind TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    total_issued INTEGER NOT NULL,
    total_redeemed INTEGER NOT NULL,
    fee_collected INTEGER NOT NULL,
    payment_amount INTEGER,
    payment_fee INTEGER,
    payment_method TEXT
);

CREATE TABLE "keyset" (
    id TEXT PRIMARY KEY,
    unit TEXT NOT NULL,
    active BOOL NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    derivation_path TEXT NOT NULL,
    input_fee_ppk INTEGER,
    derivation_path_index INTEGER,
    amounts TEXT
, issuer_version TEXT);

CREATE TABLE keyset_amounts (
    keyset_id TEXT PRIMARY KEY NOT NULL,
    total_issued INTEGER NOT NULL DEFAULT 0,
    total_redeemed INTEGER NOT NULL DEFAULT 0
, fee_collected INTEGER NOT NULL DEFAULT 0);

CREATE TABLE keyset_epoch (
    id INTEGER PRIMARY KEY,
    epoch BIGINT NOT NULL
);

CREATE TABLE kv_store (
    primary_namespace TEXT NOT NULL,
    secondary_namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value BLOB NOT NULL,
    created_time INTEGER NOT NULL,
    updated_time INTEGER NOT NULL,
    PRIMARY KEY (primary_namespace, secondary_namespace, key)
);

CREATE TABLE "melt_quote" (
    id TEXT PRIMARY KEY,
    unit TEXT NOT NULL,
    amount INTEGER NOT NULL,
    request TEXT NOT NULL,
    fee_reserve INTEGER NOT NULL,
    expiry INTEGER NOT NULL,
    state TEXT CHECK (
        state IN ('UNPAID', 'PENDING', 'PAID')
    ) NOT NULL DEFAULT 'UNPAID',
    payment_proof TEXT,
    request_lookup_id TEXT,
    created_time INTEGER NOT NULL DEFAULT 0,
    paid_time INTEGER,
    payment_method TEXT NOT NULL DEFAULT 'bolt11',
    options TEXT,
    request_lookup_id_kind TEXT
, estimated_blocks INTEGER, fee_options TEXT, extra_json TEXT, selected_fee_index INTEGER);

CREATE TABLE melt_request (
    quote_id TEXT PRIMARY KEY,
    inputs_amount INTEGER NOT NULL,
    inputs_fee INTEGER NOT NULL,
    FOREIGN KEY (quote_id) REFERENCES melt_quote(id)
);

CREATE TABLE migrations (
               name TEXT PRIMARY KEY,
               applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
           );

CREATE TABLE "mint_quote" (
    id TEXT PRIMARY KEY,
    amount INTEGER,
    unit TEXT NOT NULL,
    request TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    request_lookup_id TEXT UNIQUE,
    pubkey TEXT,
    created_time INTEGER NOT NULL DEFAULT 0,
    amount_paid INTEGER NOT NULL DEFAULT 0,
    amount_issued INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'BOLT11'
, request_lookup_id_kind TEXT NOT NULL DEFAULT 'payment_hash', extra_json TEXT, updated_at INTEGER NOT NULL DEFAULT 0, last_checked INTEGER NOT NULL DEFAULT 0);

CREATE TABLE mint_quote_issued (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (quote_id) REFERENCES mint_quote(id)
);

CREATE TABLE mint_quote_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id TEXT NOT NULL,
    payment_id TEXT NOT NULL UNIQUE,
    timestamp INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    FOREIGN KEY (quote_id) REFERENCES mint_quote(id)
);

CREATE TABLE "proof" (
    y BLOB PRIMARY KEY,
    amount INTEGER NOT NULL,
    keyset_id TEXT NOT NULL, -- no FK constraint here
    secret TEXT NOT NULL,
    c BLOB NOT NULL,
    witness TEXT,
    state TEXT CHECK (state IN ('SPENT', 'PENDING', 'UNSPENT', 'RESERVED', 'UNKNOWN')) NOT NULL,
    quote_id TEXT,
    created_time INTEGER NOT NULL DEFAULT 0
, operation_kind TEXT, operation_id TEXT);

CREATE TABLE "saga_state" (
    operation_id TEXT PRIMARY KEY,
    operation_kind TEXT NOT NULL,
    state TEXT NOT NULL,
    quote_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
, finalization_data TEXT);

