name = "consia-api"
main = "worker.js"
compatibility_date = "2026-02-01"

# =========================
# DURABLE OBJECTS
# =========================

[durable_objects]
bindings = [
  { name = "CONSIA_STATE", class_name = "ConsiaState" }
]

[[migrations]]
tag = "v1"
new_classes = ["ConsiaState"]

# =========================
# KV — GLOBAL STATE
# =========================

[[kv_namespaces]]
binding = "GLOBAL_STATE"
id = "CONSIA_GLOBAL_STATE"

[[kv_namespaces]]
binding = "PRESENCE"
id = "CONSIA_PRESENCE"

[[kv_namespaces]]
binding = "SESSIONS_KV"
id = "SESSIONS"

[[kv_namespaces]]
binding = "VAULT_KV"
id = "VAULT"

# =========================
# D1 DATABASE
# =========================

[[d1_databases]]
binding = "CONSIA_DB"
database_name = "consiadb"

# =========================
# ENV
# =========================

[vars]
OPENAI_MODEL = "gpt-4.1"
