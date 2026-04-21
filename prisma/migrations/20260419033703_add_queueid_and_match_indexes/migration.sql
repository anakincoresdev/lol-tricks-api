-- AlterTable
ALTER TABLE "Match" ADD COLUMN "queueId" INTEGER NOT NULL DEFAULT 420;

-- CreateIndex
CREATE INDEX "Match_gameCreation_idx" ON "Match"("gameCreation");

-- CreateIndex
CREATE INDEX "Match_queueId_gameCreation_idx" ON "Match"("queueId", "gameCreation");

-- CreateIndex
CREATE INDEX "MatchParticipant_championName_idx" ON "MatchParticipant"("championName");
