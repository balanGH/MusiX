/*
  # Create jobs table for MusiX audio processing

  1. New Tables
    - `jobs`
      - `id` (uuid, primary key)
      - `status` (text) - pending, processing, completed, failed
      - `youtube_url` (text, optional) - YouTube URL if provided
      - `original_filename` (text, optional) - Original file name if uploaded
      - `vocals_path` (text, optional) - Path to separated vocals file
      - `instrumental_path` (text, optional) - Path to separated instrumental file
      - `error_message` (text, optional) - Error details if processing failed
      - `progress` (integer) - Processing progress percentage (0-100)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
      - `user_id` (uuid, optional) - For future auth integration

  2. Security
    - Enable RLS on `jobs` table
    - Add policy for public read access (for demo purposes)
    - Add policy for public insert/update (for demo purposes)
    
  Note: This is a demo app, so RLS policies are permissive. 
  In production, you would restrict based on user_id.
*/

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending',
  youtube_url text,
  original_filename text,
  vocals_path text,
  instrumental_path text,
  error_message text,
  progress integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  user_id uuid
);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view jobs"
  ON jobs
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Anyone can create jobs"
  ON jobs
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Anyone can update jobs"
  ON jobs
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at DESC);