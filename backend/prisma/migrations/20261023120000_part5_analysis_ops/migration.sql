-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'NOT_CONFIGURED');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SUPPORT';

-- AlterTable
ALTER TABLE "UserPreference" ADD COLUMN     "autoAiFeedback" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ExamAnalysis" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "content" JSONB,
    "provider" "AiProvider",
    "model" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3),

    CONSTRAINT "ExamAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudyPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "content" JSONB,
    "basis" JSONB NOT NULL,
    "provider" "AiProvider",
    "model" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3),

    CONSTRAINT "StudyPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricBucket" (
    "bucket" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MetricBucket_pkey" PRIMARY KEY ("bucket","name","label")
);

-- CreateTable
CREATE TABLE "ServiceHeartbeat" (
    "name" TEXT NOT NULL,
    "beatAt" TIMESTAMP(3) NOT NULL,
    "info" JSONB,

    CONSTRAINT "ServiceHeartbeat_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExamAnalysis_resultId_key" ON "ExamAnalysis"("resultId");

-- CreateIndex
CREATE INDEX "ExamAnalysis_userId_createdAt_idx" ON "ExamAnalysis"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ExamAnalysis_status_updatedAt_idx" ON "ExamAnalysis"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "StudyPlan_userId_createdAt_idx" ON "StudyPlan"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "StudyPlan_userId_fingerprint_key" ON "StudyPlan"("userId", "fingerprint");

-- CreateIndex
CREATE INDEX "MetricBucket_name_bucket_idx" ON "MetricBucket"("name", "bucket");

-- AddForeignKey
ALTER TABLE "ExamAnalysis" ADD CONSTRAINT "ExamAnalysis_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ExamResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAnalysis" ADD CONSTRAINT "ExamAnalysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

