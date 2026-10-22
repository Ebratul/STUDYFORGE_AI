-- CreateEnum
CREATE TYPE "QuestionKind" AS ENUM ('MCQ', 'CQ');

-- CreateEnum
CREATE TYPE "QuestionDifficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "QuestionLanguage" AS ENUM ('en', 'bn');

-- CreateEnum
CREATE TYPE "QuestionOrigin" AS ENUM ('AI_GENERATED', 'USER_AUTHORED');

-- CreateEnum
CREATE TYPE "SourceSupport" AS ENUM ('SOURCE_QUOTED', 'MODEL_ONLY', 'NONE');

-- CreateEnum
CREATE TYPE "CqLevel" AS ENUM ('KNOWLEDGE', 'COMPREHENSION', 'APPLICATION', 'HIGHER_ORDER');

-- CreateEnum
CREATE TYPE "AnswerBasis" AS ENUM ('SOURCE_SUPPORTED', 'GENERAL_REASONING', 'INSUFFICIENT_EVIDENCE', 'USER_PROVIDED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED');

-- CreateTable
CREATE TABLE "GenerationRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "QuestionKind" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "settings" JSONB NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "result" JSONB,
    "llmCalls" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "QuestionKind" NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "language" "QuestionLanguage" NOT NULL,
    "stem" TEXT NOT NULL,
    "stimulus" TEXT,
    "explanation" TEXT,
    "shortNote" TEXT,
    "difficulty" "QuestionDifficulty" NOT NULL,
    "subject" TEXT,
    "topic" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "marks" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "negativeMarks" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "origin" "QuestionOrigin" NOT NULL,
    "sourceSupport" "SourceSupport" NOT NULL,
    "modifiedByUser" BOOLEAN NOT NULL DEFAULT false,
    "reviewReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewedAt" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "generationRunId" TEXT,
    "provenanceProvider" TEXT,
    "provenanceModel" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionOption" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "QuestionOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionPart" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT,
    "level" "CqLevel",
    "prompt" TEXT NOT NULL,
    "marks" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "QuestionPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelAnswer" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "partId" TEXT,
    "text" TEXT NOT NULL,
    "basis" "AnswerBasis" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionSource" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answerId" TEXT,
    "ordinal" INTEGER NOT NULL,
    "documentId" TEXT,
    "documentName" TEXT NOT NULL,
    "page" INTEGER,
    "section" TEXT,
    "quote" TEXT NOT NULL,
    "quoteVerified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "QuestionSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionRevision" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionCollection" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleKey" TEXT NOT NULL,
    "description" TEXT,
    "subject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionQuestion" (
    "collectionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionQuestion_pkey" PRIMARY KEY ("collectionId","questionId")
);

-- CreateIndex
CREATE INDEX "GenerationRun_userId_createdAt_idx" ON "GenerationRun"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GenerationRun_userId_status_idx" ON "GenerationRun"("userId", "status");

-- CreateIndex
CREATE INDEX "GenerationRun_expiresAt_idx" ON "GenerationRun"("expiresAt");

-- CreateIndex
CREATE INDEX "Question_ownerId_createdAt_idx" ON "Question"("ownerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Question_ownerId_kind_difficulty_idx" ON "Question"("ownerId", "kind", "difficulty");

-- CreateIndex
CREATE INDEX "Question_ownerId_subject_idx" ON "Question"("ownerId", "subject");

-- CreateIndex
CREATE INDEX "Question_ownerId_topic_idx" ON "Question"("ownerId", "topic");

-- CreateIndex
CREATE INDEX "Question_generationRunId_idx" ON "Question"("generationRunId");

-- CreateIndex
CREATE INDEX "Question_tags_idx" ON "Question" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "Question_stem_idx" ON "Question" USING GIN ("stem" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "Question_ownerId_contentHash_key" ON "Question"("ownerId", "contentHash");

-- CreateIndex
CREATE INDEX "QuestionOption_questionId_idx" ON "QuestionOption"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionOption_questionId_position_key" ON "QuestionOption"("questionId", "position");

-- CreateIndex
CREATE INDEX "QuestionPart_questionId_idx" ON "QuestionPart"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionPart_questionId_position_key" ON "QuestionPart"("questionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ModelAnswer_partId_key" ON "ModelAnswer"("partId");

-- CreateIndex
CREATE INDEX "ModelAnswer_questionId_idx" ON "ModelAnswer"("questionId");

-- CreateIndex
CREATE INDEX "QuestionSource_questionId_idx" ON "QuestionSource"("questionId");

-- CreateIndex
CREATE INDEX "QuestionSource_answerId_idx" ON "QuestionSource"("answerId");

-- CreateIndex
CREATE INDEX "QuestionSource_documentId_idx" ON "QuestionSource"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionRevision_questionId_version_key" ON "QuestionRevision"("questionId", "version");

-- CreateIndex
CREATE INDEX "QuestionCollection_ownerId_updatedAt_idx" ON "QuestionCollection"("ownerId", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "QuestionCollection_ownerId_titleKey_key" ON "QuestionCollection"("ownerId", "titleKey");

-- CreateIndex
CREATE INDEX "CollectionQuestion_questionId_idx" ON "CollectionQuestion"("questionId");

-- CreateIndex
CREATE INDEX "CollectionQuestion_collectionId_position_idx" ON "CollectionQuestion"("collectionId", "position");

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_generationRunId_fkey" FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionOption" ADD CONSTRAINT "QuestionOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionPart" ADD CONSTRAINT "QuestionPart_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelAnswer" ADD CONSTRAINT "ModelAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelAnswer" ADD CONSTRAINT "ModelAnswer_partId_fkey" FOREIGN KEY ("partId") REFERENCES "QuestionPart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionSource" ADD CONSTRAINT "QuestionSource_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionSource" ADD CONSTRAINT "QuestionSource_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "ModelAnswer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionSource" ADD CONSTRAINT "QuestionSource_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionRevision" ADD CONSTRAINT "QuestionRevision_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionCollection" ADD CONSTRAINT "QuestionCollection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionQuestion" ADD CONSTRAINT "CollectionQuestion_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "QuestionCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionQuestion" ADD CONSTRAINT "CollectionQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity that Prisma cannot express (additive; drops nothing)
-- ---------------------------------------------------------------------------

-- Exactly one correct option per MCQ (zero is allowed only transiently inside a transaction; the service always writes one).
CREATE UNIQUE INDEX "QuestionOption_one_correct_per_question" ON "QuestionOption"("questionId") WHERE "isCorrect";

-- A part-less (descriptive) CQ has at most one question-level model answer.
CREATE UNIQUE INDEX "ModelAnswer_one_question_level_answer" ON "ModelAnswer"("questionId") WHERE "partId" IS NULL;

ALTER TABLE "Question" ADD CONSTRAINT "Question_marks_range" CHECK ("marks" >= 0 AND "marks" <= 100 AND "negativeMarks" >= 0 AND "negativeMarks" <= "marks");
ALTER TABLE "Question" ADD CONSTRAINT "Question_version_positive" CHECK ("version" >= 1);
ALTER TABLE "Question" ADD CONSTRAINT "Question_stem_not_blank" CHECK (length(btrim("stem")) > 0);
ALTER TABLE "QuestionOption" ADD CONSTRAINT "QuestionOption_text_not_blank" CHECK (length(btrim("text")) > 0);
ALTER TABLE "QuestionPart" ADD CONSTRAINT "QuestionPart_marks_positive" CHECK ("marks" > 0);
ALTER TABLE "QuestionPart" ADD CONSTRAINT "QuestionPart_prompt_not_blank" CHECK (length(btrim("prompt")) > 0);

-- Defence in depth: a collection can only contain its owner's questions.
CREATE OR REPLACE FUNCTION studyforge_collection_member_owner_matches() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "QuestionCollection" c JOIN "Question" q ON q."ownerId" = c."ownerId"
    WHERE c."id" = NEW."collectionId" AND q."id" = NEW."questionId"
  ) THEN
    RAISE EXCEPTION 'CollectionQuestion must link a collection and a question with the same owner';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CollectionQuestion_owner_check" BEFORE INSERT OR UPDATE ON "CollectionQuestion"
  FOR EACH ROW EXECUTE FUNCTION studyforge_collection_member_owner_matches();
