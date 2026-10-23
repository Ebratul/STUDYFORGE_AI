-- Optional generation parameters (frequency/presence penalty, seed) for the chat model preference.
-- Additive and nullable: no existing row changes, nothing is dropped or rewritten.
ALTER TABLE "ModelPreference" ADD COLUMN "extraParams" JSONB;
