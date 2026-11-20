CREATE TABLE IF NOT EXISTS repository_review_policies (
  installation_id BIGINT NOT NULL CHECK (installation_id > 0),
  repository_id BIGINT NOT NULL CHECK (repository_id > 0),
  default_behavior VARCHAR(16) NOT NULL DEFAULT 'none' CHECK (
    default_behavior IN ('none', 'general')
  ),
  created_by_github_user_id BIGINT CHECK (created_by_github_user_id > 0),
  updated_by_github_user_id BIGINT CHECK (updated_by_github_user_id > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (installation_id, repository_id)
);

CREATE TABLE IF NOT EXISTS label_expert_mappings (
  installation_id BIGINT NOT NULL,
  repository_id BIGINT NOT NULL,
  label_id BIGINT NOT NULL CHECK (label_id > 0),
  label_name TEXT NOT NULL CHECK (length(btrim(label_name)) > 0),
  expert_id VARCHAR(64) CHECK (expert_id ~ '^[a-z][a-z0-9_-]*$'),
  PRIMARY KEY (installation_id, repository_id, label_id),
  FOREIGN KEY (installation_id, repository_id)
    REFERENCES repository_review_policies (installation_id, repository_id)
    ON DELETE CASCADE
);

-- Pas de clé étrangère vers les configurations LLM : la présence d'une
-- correspondance ne dépend pas d'une clé API ni d'un modèle enregistré.
-- Les audits sont conservés après la suppression des politiques.
CREATE TABLE IF NOT EXISTS repository_review_policy_audits (
  id BIGSERIAL PRIMARY KEY,
  installation_id BIGINT NOT NULL,
  repository_id BIGINT NOT NULL,
  action VARCHAR(16) NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  previous_policy JSONB,
  new_policy JSONB,
  github_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS repository_review_policy_audits_scope_idx
  ON repository_review_policy_audits (installation_id, repository_id, created_at DESC);
