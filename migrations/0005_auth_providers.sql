CREATE TABLE IF NOT EXISTS workspace_state_new (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_id TEXT NOT NULL,
  auth_provider TEXT NOT NULL CHECK (auth_provider IN ('cloudflare', 'github', 'password', 'linuxdo')),
  auth_revision INTEGER NOT NULL,
  access_not_before INTEGER NOT NULL,
  github_admin_id TEXT,
  linuxdo_admin_id TEXT
);

INSERT INTO workspace_state_new (id, account_id, auth_provider, auth_revision, access_not_before, github_admin_id)
SELECT id, account_id, auth_provider, auth_revision, access_not_before, github_admin_id FROM workspace_state;

DROP TABLE workspace_state;

ALTER TABLE workspace_state_new RENAME TO workspace_state;
