-- ============================================================================
-- Supabase Migration 002: CA Management, Client Mappings, Locations & Constraints
-- ============================================================================

-- 1. Career Associates Table
CREATE TABLE IF NOT EXISTS career_associates (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  role VARCHAR(64) DEFAULT 'CA',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ca_email ON career_associates(email);

-- 2. CA to Client Mappings Table
CREATE TABLE IF NOT EXISTS ca_client_mappings (
  id BIGSERIAL PRIMARY KEY,
  ca_id UUID NOT NULL,
  applywizz_id VARCHAR(64) NOT NULL,
  client_email VARCHAR(255),
  full_name VARCHAR(255),
  assignment_type VARCHAR(64) DEFAULT 'permanent',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_ca_client UNIQUE (ca_id, applywizz_id)
);

-- Drop restrictive foreign key constraints if created in earlier runs
ALTER TABLE ca_client_mappings 
DROP CONSTRAINT IF EXISTS ca_client_mappings_applywizz_id_fkey;

ALTER TABLE ca_client_mappings 
DROP CONSTRAINT IF EXISTS ca_client_mappings_ca_id_fkey;

CREATE INDEX IF NOT EXISTS idx_ca_mapping_ca ON ca_client_mappings(ca_id);
CREATE INDEX IF NOT EXISTS idx_ca_mapping_client ON ca_client_mappings(applywizz_id);

-- 3. Reference Metadata Table (for US locations, countries, and counties)
CREATE TABLE IF NOT EXISTS reference_metadata (
  key VARCHAR(64) PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Deduplication Constraint on oracle_jobs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_oracle_jobs_assignment'
  ) THEN
    ALTER TABLE oracle_jobs ADD CONSTRAINT uq_oracle_jobs_assignment UNIQUE (job_key, applywizz_id);
  END IF;
END $$;

-- 5. Deduplication Index on question_bank
CREATE UNIQUE INDEX IF NOT EXISTS uq_qb_client_label 
ON question_bank (applywizz_id, question_label) 
WHERE applywizz_id IS NOT NULL;

-- 6. Add Audit Proofs, Execution Logs, and Receipts to applications Table
ALTER TABLE applications ADD COLUMN IF NOT EXISTS screenshots JSONB DEFAULT '[]'::jsonb;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS fill_logs JSONB DEFAULT '[]'::jsonb;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS fill_completed_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS receipt JSONB;
