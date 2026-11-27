CREATE TABLE IF NOT EXISTS expert_prompt_configurations (
  installation_id BIGINT NOT NULL CHECK (installation_id > 0),
  intention VARCHAR(64) NOT NULL CHECK (intention ~ '^[a-z][a-z0-9_-]*$'),
  system_prompt TEXT NOT NULL CHECK (length(btrim(system_prompt)) > 0),
  updated_by_github_user_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (installation_id, intention)
);
