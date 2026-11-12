-- Migration 003: Create resume_parsed table for structured candidate intelligence
-- Grounded ATS schema: header, professional summary, 9 skill categories, timeline experience, education, projects, certifications

CREATE TABLE IF NOT EXISTS resume_parsed (
  applywizz_id TEXT PRIMARY KEY,
  full_name TEXT,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  current_title TEXT,
  years_of_experience NUMERIC,
  highest_education_level TEXT,
  linkedin_url TEXT,
  portfolio_url TEXT,
  professional_summary TEXT,
  domain_expertise JSONB DEFAULT '[]'::jsonb,
  technical_skills JSONB DEFAULT '{}'::jsonb,
  skills JSONB DEFAULT '[]'::jsonb,
  work_experience JSONB DEFAULT '[]'::jsonb,
  education JSONB DEFAULT '[]'::jsonb,
  projects JSONB DEFAULT '[]'::jsonb,
  certifications JSONB DEFAULT '[]'::jsonb,
  raw_resume_text TEXT,
  parsed_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resume_parsed_email ON resume_parsed(email);
CREATE INDEX IF NOT EXISTS idx_resume_parsed_updated_at ON resume_parsed(updated_at);
