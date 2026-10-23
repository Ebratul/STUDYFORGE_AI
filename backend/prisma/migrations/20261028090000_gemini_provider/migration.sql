-- Google AI Studio (Gemini) as a fourth real AI provider (docs/AI_CONNECTION_SPEC.md).
--
-- Additive and backward compatible: one new enum value, nothing is dropped, rewritten or backfilled. Application code from before this
-- migration keeps working (it never produces the new value). The value is appended, so existing rows and enum ordering are untouched.
ALTER TYPE "AiProvider" ADD VALUE IF NOT EXISTS 'GEMINI';
