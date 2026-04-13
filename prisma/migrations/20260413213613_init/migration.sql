-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "puuid" TEXT NOT NULL,
    "gameName" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "rank" TEXT NOT NULL DEFAULT 'I',
    "lp" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "winRate" DOUBLE PRECISION NOT NULL,
    "hotStreak" BOOLEAN NOT NULL DEFAULT false,
    "totalGames" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerChampion" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "championName" TEXT NOT NULL,
    "gamesPlayed" INTEGER NOT NULL,

    CONSTRAINT "PlayerChampion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "gameDuration" INTEGER NOT NULL,
    "gameCreation" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchParticipant" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "puuid" TEXT NOT NULL,
    "championName" TEXT NOT NULL,
    "kills" INTEGER NOT NULL,
    "deaths" INTEGER NOT NULL,
    "assists" INTEGER NOT NULL,
    "cs" INTEGER NOT NULL,
    "position" TEXT NOT NULL,
    "win" BOOLEAN NOT NULL,
    "items" JSONB NOT NULL,
    "runes" JSONB NOT NULL,
    "summoner1Id" INTEGER NOT NULL DEFAULT 0,
    "summoner2Id" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MatchParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChampionMastery" (
    "id" TEXT NOT NULL,
    "puuid" TEXT NOT NULL,
    "championId" INTEGER NOT NULL,
    "championName" TEXT NOT NULL,
    "masteryPoints" INTEGER NOT NULL,
    "masteryLevel" INTEGER NOT NULL,
    "region" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChampionMastery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionLog" (
    "id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "collected" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Player_region_tier_idx" ON "Player"("region", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "Player_puuid_region_key" ON "Player"("puuid", "region");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerChampion_playerId_championName_key" ON "PlayerChampion"("playerId", "championName");

-- CreateIndex
CREATE UNIQUE INDEX "Match_matchId_key" ON "Match"("matchId");

-- CreateIndex
CREATE INDEX "MatchParticipant_puuid_idx" ON "MatchParticipant"("puuid");

-- CreateIndex
CREATE INDEX "MatchParticipant_puuid_championName_idx" ON "MatchParticipant"("puuid", "championName");

-- CreateIndex
CREATE UNIQUE INDEX "ChampionMastery_puuid_championId_region_key" ON "ChampionMastery"("puuid", "championId", "region");

-- AddForeignKey
ALTER TABLE "PlayerChampion" ADD CONSTRAINT "PlayerChampion_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchParticipant" ADD CONSTRAINT "MatchParticipant_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
