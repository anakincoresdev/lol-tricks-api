export interface LeagueEntry {
  leagueId: string
  summonerId: string
  puuid: string
  queueType: string
  tier: string
  rank: string
  leaguePoints: number
  wins: number
  losses: number
  veteran: boolean
  inactive: boolean
  freshBlood: boolean
  hotStreak: boolean
}

export interface LeagueList {
  tier: string
  leagueId: string
  queue: string
  name: string
  entries: LeagueEntry[]
}

export interface MatchDto {
  metadata: {
    dataVersion: string
    matchId: string
    participants: string[]
  }
  info: {
    gameCreation: number
    gameDuration: number
    gameMode: string
    queueId: number
    participants: MatchParticipant[]
  }
}

export interface MatchParticipant {
  puuid: string
  summonerName: string
  riotIdGameName: string
  riotIdTagline: string
  championId: number
  championName: string
  win: boolean
  kills: number
  deaths: number
  assists: number
  item0: number
  item1: number
  item2: number
  item3: number
  item4: number
  item5: number
  item6: number
  perks: {
    statPerks: { defense: number; flex: number; offense: number }
    styles: PerkStyle[]
  }
  summoner1Id: number
  summoner2Id: number
  totalMinionsKilled: number
  teamPosition: string
}

export interface PerkStyle {
  description: string
  selections: { perk: number; var1: number; var2: number; var3: number }[]
  style: number
}

export interface AccountDto {
  puuid: string
  gameName: string
  tagLine: string
}

export interface ChampionMasteryDto {
  puuid: string
  championId: number
  championLevel: number
  championPoints: number
  lastPlayTime: number
}
