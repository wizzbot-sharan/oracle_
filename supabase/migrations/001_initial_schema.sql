-- ============================================================================
-- Supabase PostgreSQL Initial Migration: Oracle Automation Workflow
-- Enables centralized multi-worker cloud execution with Hybrid Relational + JSONB.
-- ============================================================================

-- Enable pgcrypto for UUID generation if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. Jobs Table (Unique Canonical Oracle Job Postings)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  job_key VARCHAR(64) PRIMARY KEY,
  job_url TEXT NOT NULL UNIQUE,
  tenant_host VARCHAR(255) NOT NULL,
  tenant_key VARCHAR(64),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_tenant_host ON jobs(tenant_host);

-- ----------------------------------------------------------------------------
-- 2. Oracle Jobs Table (Candidate Job Assignments from Scraper / CSV)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oracle_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_key VARCHAR(64) REFERENCES jobs(job_key) ON DELETE CASCADE,
  job_url TEXT NOT NULL,
  company_name VARCHAR(255),
  client_name VARCHAR(255),
  applywizz_id VARCHAR(64) NOT NULL,
  score INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oracle_jobs_job_key ON oracle_jobs(job_key);
CREATE INDEX IF NOT EXISTS idx_oracle_jobs_client ON oracle_jobs(applywizz_id);

-- ----------------------------------------------------------------------------
-- 3. Form Templates Table (Extracted Oracle DOM Schemas)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_templates (
  job_key VARCHAR(64) PRIMARY KEY REFERENCES jobs(job_key) ON DELETE CASCADE,
  template_id VARCHAR(64) NOT NULL,
  version VARCHAR(32) DEFAULT '1.0.0',
  submit_present BOOLEAN DEFAULT FALSE,
  fields_count INT DEFAULT 0,
  branches_count INT DEFAULT 0,
  repeatable_groups_count INT DEFAULT 0,
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  conditional_branches JSONB NOT NULL DEFAULT '[]'::jsonb,
  repeatable_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  scan_metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 4. Candidate Applications Table (Target Form Fill Instances)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
  application_id VARCHAR(64) PRIMARY KEY,
  applywizz_id VARCHAR(64) NOT NULL,
  job_key VARCHAR(64) REFERENCES jobs(job_key) ON DELETE CASCADE,
  client_name VARCHAR(255),
  company_name VARCHAR(255),
  template_id VARCHAR(64),
  canonical_url TEXT,
  tenant_host VARCHAR(255),
  tenant_key VARCHAR(64),
  status VARCHAR(32) NOT NULL DEFAULT 'needs_input', -- 'answers_resolved' | 'needs_input' | 'submitted' | 'failed'
  review_status VARCHAR(32) DEFAULT 'not_ready',      -- 'not_ready' | 'approved' | 'submitted'
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  unresolved_fields JSONB DEFAULT '[]'::jsonb,
  fill_results JSONB DEFAULT '[]'::jsonb,
  submission_result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_applications_client ON applications(applywizz_id);
CREATE INDEX IF NOT EXISTS idx_applications_job_key ON applications(job_key);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_review_status ON applications(review_status);

-- ----------------------------------------------------------------------------
-- 5. Question Bank Table (Continuous Learning Historical Q&A Knowledge Base)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_bank (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applywizz_id VARCHAR(64),
  question_label TEXT NOT NULL,
  field_type VARCHAR(64),
  value TEXT,
  source VARCHAR(32) DEFAULT 'manual', -- 'manual' | 'ai' | 'dashboard'
  confidence NUMERIC(3, 2) DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qb_client ON question_bank(applywizz_id);
CREATE INDEX IF NOT EXISTS idx_qb_label ON question_bank(question_label);

-- ----------------------------------------------------------------------------
-- 6. Scanner Queue State Table (Multi-Worker Concurrency Coordination)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_status (
  job_key VARCHAR(64) PRIMARY KEY REFERENCES jobs(job_key) ON DELETE CASCADE,
  job_url TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending', -- 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed' | 'retry_backoff'
  worker_id INT,
  attempt INT DEFAULT 1,
  reason VARCHAR(64),
  message TEXT,
  error TEXT,
  duration_ms INT,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_status_status ON scan_status(status);

-- ----------------------------------------------------------------------------
-- 7. Clients Table (Candidate Profile Cache from Portal)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
  applywizz_id VARCHAR(64) PRIMARY KEY,
  full_name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(64),
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 8. Run Logs Table (Audit and Execution Logs)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_logs (
  id BIGSERIAL PRIMARY KEY,
  event_id VARCHAR(64),
  type VARCHAR(128) NOT NULL,
  at TIMESTAMPTZ DEFAULT NOW(),
  payload JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_run_logs_type ON run_logs(type);
CREATE INDEX IF NOT EXISTS idx_run_logs_at ON run_logs(at);

-- ----------------------------------------------------------------------------
-- 9. Storage Buckets (For Resumes and Submission Proof Screenshots)
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('resumes', 'resumes', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('receipts', 'receipts', false)
ON CONFLICT (id) DO NOTHING;
