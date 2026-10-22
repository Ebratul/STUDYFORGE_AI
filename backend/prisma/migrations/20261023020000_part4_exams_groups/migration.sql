-- CreateEnum
CREATE TYPE "GroupRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "ExamMode" AS ENUM ('INDIVIDUAL', 'GROUP');

-- CreateEnum
CREATE TYPE "ExamStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReviewPolicy" AS ENUM ('NONE', 'CORRECTNESS', 'FULL');

-- CreateEnum
CREATE TYPE "ReleaseMode" AS ENUM ('IMMEDIATE', 'AFTER_CLOSE', 'AT_TIME');

-- CreateEnum
CREATE TYPE "LateStart" AS ENUM ('CAP_AT_CLOSE', 'FULL_TIME_ONLY');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "QuestionOutcome" AS ENUM ('CORRECT', 'INCORRECT', 'UNANSWERED');

-- CreateEnum
CREATE TYPE "FeedbackBand" AS ENUM ('EXCELLENT', 'GOOD', 'NEEDS_IMPROVEMENT', 'BAD', 'VERY_BAD');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "link" TEXT;

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "capacity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "GroupRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "showNameOnLeaderboard" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateTable
CREATE TABLE "GroupInvite" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeHint" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "maxUses" INTEGER NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "forUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exam" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "groupId" TEXT,
    "mode" "ExamMode" NOT NULL,
    "status" "ExamStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "draft" JSONB NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamVersion" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "mode" "ExamMode" NOT NULL,
    "groupId" TEXT,
    "durationSeconds" INTEGER NOT NULL,
    "attemptLimit" INTEGER NOT NULL,
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "shuffleQuestions" BOOLEAN NOT NULL,
    "shuffleOptions" BOOLEAN NOT NULL,
    "reviewPolicy" "ReviewPolicy" NOT NULL,
    "releaseMode" "ReleaseMode" NOT NULL,
    "releaseAt" TIMESTAMP(3),
    "lateStart" "LateStart" NOT NULL,
    "lateJoinGroup" BOOLEAN NOT NULL,
    "leaderboardVisible" BOOLEAN NOT NULL,
    "reminderMinutes" INTEGER,
    "negativeMarkingBp" INTEGER NOT NULL,
    "questionCount" INTEGER NOT NULL,
    "totalCenti" INTEGER NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamVersionState" (
    "examVersionId" TEXT NOT NULL,
    "resultsNotifiedAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "publishNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "ExamVersionState_pkey" PRIMARY KEY ("examVersionId")
);

-- CreateTable
CREATE TABLE "ExamQuestionSnapshot" (
    "id" TEXT NOT NULL,
    "examVersionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "sourceQuestionId" TEXT,
    "sourceQuestionVersion" INTEGER NOT NULL,
    "stem" TEXT NOT NULL,
    "explanation" TEXT,
    "shortNote" TEXT,
    "topic" TEXT,
    "subject" TEXT,
    "difficulty" "QuestionDifficulty" NOT NULL,
    "language" "QuestionLanguage" NOT NULL,
    "marksCenti" INTEGER NOT NULL,
    "negativeCenti" INTEGER NOT NULL,
    "sources" JSONB NOT NULL,

    CONSTRAINT "ExamQuestionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamOptionSnapshot" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,

    CONSTRAINT "ExamOptionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAttempt" (
    "id" TEXT NOT NULL,
    "examVersionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "questionOrder" JSONB NOT NULL,
    "optionOrder" JSONB NOT NULL,
    "lastSavedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttemptAnswer" (
    "attemptId" TEXT NOT NULL,
    "examQuestionId" TEXT NOT NULL,
    "selectedOptionId" TEXT,
    "markedForReview" BOOLEAN NOT NULL DEFAULT false,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptAnswer_pkey" PRIMARY KEY ("attemptId","examQuestionId")
);

-- CreateTable
CREATE TABLE "ExamResult" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "examVersionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rawScoreCenti" INTEGER NOT NULL,
    "scoreCenti" INTEGER NOT NULL,
    "maxCenti" INTEGER NOT NULL,
    "percentBp" INTEGER NOT NULL,
    "correctCount" INTEGER NOT NULL,
    "incorrectCount" INTEGER NOT NULL,
    "unansweredCount" INTEGER NOT NULL,
    "band" "FeedbackBand" NOT NULL,
    "finalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamResultItem" (
    "resultId" TEXT NOT NULL,
    "examQuestionId" TEXT NOT NULL,
    "selectedOptionId" TEXT,
    "outcome" "QuestionOutcome" NOT NULL,
    "awardedCenti" INTEGER NOT NULL,

    CONSTRAINT "ExamResultItem_pkey" PRIMARY KEY ("resultId","examQuestionId")
);

-- CreateIndex
CREATE INDEX "Group_ownerId_idx" ON "Group"("ownerId");

-- CreateIndex
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupInvite_codeHash_key" ON "GroupInvite"("codeHash");

-- CreateIndex
CREATE INDEX "GroupInvite_groupId_createdAt_idx" ON "GroupInvite"("groupId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Exam_ownerId_status_updatedAt_idx" ON "Exam"("ownerId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Exam_groupId_status_idx" ON "Exam"("groupId", "status");

-- CreateIndex
CREATE INDEX "ExamVersion_groupId_publishedAt_idx" ON "ExamVersion"("groupId", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "ExamVersion_closesAt_idx" ON "ExamVersion"("closesAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExamVersion_examId_version_key" ON "ExamVersion"("examId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ExamQuestionSnapshot_examVersionId_position_key" ON "ExamQuestionSnapshot"("examVersionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ExamOptionSnapshot_questionId_position_key" ON "ExamOptionSnapshot"("questionId", "position");

-- CreateIndex
CREATE INDEX "ExamAttempt_status_deadlineAt_idx" ON "ExamAttempt"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "ExamAttempt_userId_createdAt_idx" ON "ExamAttempt"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttempt_examVersionId_userId_attemptNo_key" ON "ExamAttempt"("examVersionId", "userId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "ExamResult_attemptId_key" ON "ExamResult"("attemptId");

-- CreateIndex
CREATE INDEX "ExamResult_examVersionId_scoreCenti_idx" ON "ExamResult"("examVersionId", "scoreCenti" DESC);

-- CreateIndex
CREATE INDEX "ExamResult_userId_finalizedAt_idx" ON "ExamResult"("userId", "finalizedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupInvite" ADD CONSTRAINT "GroupInvite_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamVersion" ADD CONSTRAINT "ExamVersion_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamVersionState" ADD CONSTRAINT "ExamVersionState_examVersionId_fkey" FOREIGN KEY ("examVersionId") REFERENCES "ExamVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamQuestionSnapshot" ADD CONSTRAINT "ExamQuestionSnapshot_examVersionId_fkey" FOREIGN KEY ("examVersionId") REFERENCES "ExamVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamOptionSnapshot" ADD CONSTRAINT "ExamOptionSnapshot_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ExamQuestionSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_examVersionId_fkey" FOREIGN KEY ("examVersionId") REFERENCES "ExamVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptAnswer" ADD CONSTRAINT "AttemptAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptAnswer" ADD CONSTRAINT "AttemptAnswer_examQuestionId_fkey" FOREIGN KEY ("examQuestionId") REFERENCES "ExamQuestionSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamResult" ADD CONSTRAINT "ExamResult_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamResult" ADD CONSTRAINT "ExamResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamResultItem" ADD CONSTRAINT "ExamResultItem_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ExamResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrity that Prisma cannot express (additive; drops nothing)
-- ---------------------------------------------------------------------------

-- Published versions, their question/option snapshots and finalized results are immutable. (DELETE is still allowed so that
-- deleting an exam, a group or an account cascades.)
CREATE OR REPLACE FUNCTION studyforge_forbid_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ExamVersion_immutable" BEFORE UPDATE ON "ExamVersion" FOR EACH ROW EXECUTE FUNCTION studyforge_forbid_update();
CREATE TRIGGER "ExamQuestionSnapshot_immutable" BEFORE UPDATE ON "ExamQuestionSnapshot" FOR EACH ROW EXECUTE FUNCTION studyforge_forbid_update();
CREATE TRIGGER "ExamOptionSnapshot_immutable" BEFORE UPDATE ON "ExamOptionSnapshot" FOR EACH ROW EXECUTE FUNCTION studyforge_forbid_update();
CREATE TRIGGER "ExamResult_immutable" BEFORE UPDATE ON "ExamResult" FOR EACH ROW EXECUTE FUNCTION studyforge_forbid_update();
CREATE TRIGGER "ExamResultItem_immutable" BEFORE UPDATE ON "ExamResultItem" FOR EACH ROW EXECUTE FUNCTION studyforge_forbid_update();

-- Exactly one correct option per snapshot question.
CREATE UNIQUE INDEX "ExamOptionSnapshot_one_correct_per_question" ON "ExamOptionSnapshot"("questionId") WHERE "isCorrect";

-- At most one in-progress attempt per participant and exam version (the unique attemptNo covers the rest).
CREATE UNIQUE INDEX "ExamAttempt_one_in_progress" ON "ExamAttempt"("examVersionId", "userId") WHERE "status" = 'IN_PROGRESS';

-- A group has exactly one OWNER membership.
CREATE UNIQUE INDEX "GroupMember_one_owner" ON "GroupMember"("groupId") WHERE "role" = 'OWNER';

ALTER TABLE "Group" ADD CONSTRAINT "Group_capacity_range" CHECK ("capacity" >= 1 AND "capacity" <= 1000);
ALTER TABLE "Group" ADD CONSTRAINT "Group_title_not_blank" CHECK (length(btrim("title")) > 0);
ALTER TABLE "GroupInvite" ADD CONSTRAINT "GroupInvite_uses" CHECK ("maxUses" >= 1 AND "useCount" >= 0 AND "useCount" <= "maxUses");
ALTER TABLE "ExamVersion" ADD CONSTRAINT "ExamVersion_ranges" CHECK (
  "durationSeconds" > 0 AND "attemptLimit" >= 1 AND "negativeMarkingBp" BETWEEN 0 AND 10000 AND "questionCount" > 0 AND "totalCenti" > 0
  AND ("opensAt" IS NULL OR "closesAt" IS NULL OR "closesAt" > "opensAt"));
ALTER TABLE "ExamQuestionSnapshot" ADD CONSTRAINT "ExamQuestionSnapshot_marks" CHECK ("marksCenti" > 0 AND "negativeCenti" >= 0 AND "negativeCenti" <= "marksCenti");
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_times" CHECK ("attemptNo" >= 1 AND "deadlineAt" > "startedAt");
ALTER TABLE "ExamResult" ADD CONSTRAINT "ExamResult_ranges" CHECK (
  "scoreCenti" >= 0 AND "scoreCenti" <= "maxCenti" AND "maxCenti" > 0 AND "percentBp" BETWEEN 0 AND 10000
  AND "correctCount" >= 0 AND "incorrectCount" >= 0 AND "unansweredCount" >= 0);

-- Capacity can never be exceeded, even by concurrent inserts: the trigger serialises per group with an advisory lock.
CREATE OR REPLACE FUNCTION studyforge_group_capacity() RETURNS trigger AS $$
DECLARE cap integer; n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('group-capacity:' || NEW."groupId", 0));
  SELECT "capacity" INTO cap FROM "Group" WHERE "id" = NEW."groupId";
  SELECT count(*) INTO n FROM "GroupMember" WHERE "groupId" = NEW."groupId";
  IF n >= cap THEN
    RAISE EXCEPTION 'group is full' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "GroupMember_capacity" BEFORE INSERT ON "GroupMember" FOR EACH ROW EXECUTE FUNCTION studyforge_group_capacity();

-- An attempt number can never exceed the version's attempt limit.
CREATE OR REPLACE FUNCTION studyforge_attempt_limit() RETURNS trigger AS $$
DECLARE lim integer;
BEGIN
  SELECT "attemptLimit" INTO lim FROM "ExamVersion" WHERE "id" = NEW."examVersionId";
  IF NEW."attemptNo" > lim THEN
    RAISE EXCEPTION 'attempt limit reached' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ExamAttempt_limit" BEFORE INSERT ON "ExamAttempt" FOR EACH ROW EXECUTE FUNCTION studyforge_attempt_limit();

-- Answers can only be written while the attempt is in progress, and must reference a question of the attempt's version
-- and an option of that question.
CREATE OR REPLACE FUNCTION studyforge_answer_integrity() RETURNS trigger AS $$
DECLARE st "AttemptStatus"; ver text;
BEGIN
  SELECT a."status", a."examVersionId" INTO st, ver FROM "ExamAttempt" a WHERE a."id" = NEW."attemptId";
  IF st IS DISTINCT FROM 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'attempt is not in progress' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "ExamQuestionSnapshot" q WHERE q."id" = NEW."examQuestionId" AND q."examVersionId" = ver) THEN
    RAISE EXCEPTION 'question does not belong to the exam version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."selectedOptionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ExamOptionSnapshot" o WHERE o."id" = NEW."selectedOptionId" AND o."questionId" = NEW."examQuestionId") THEN
    RAISE EXCEPTION 'option does not belong to the question' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttemptAnswer_integrity" BEFORE INSERT OR UPDATE ON "AttemptAnswer" FOR EACH ROW EXECUTE FUNCTION studyforge_answer_integrity();
