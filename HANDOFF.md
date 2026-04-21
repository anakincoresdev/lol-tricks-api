# LoL Tricks — Handoff Snapshot (2026-04-21)

Этот файл — точка входа для продолжения работы в новом чате. Прочитай его целиком, прежде чем начинать.

## Что за проект

**LoL Tricks** — сервис, возвращающий топ-100 Master+ игроков по каждому чемпиону LoL (EUW / NA / KR), отсортированных по LP descending. На базе этого будет фронт с билдами, рунами, предметами лучших игроков для обучения.

**Стек:**
- Backend: Node 20 / TypeScript / Express 5 / Prisma 6 / PostgreSQL (Neon) / сейчас на Vercel
- Ops scripts: plain CommonJS (.cjs) — без TS-компиляции, запускаются `node ops/<script>.cjs`
- Frontend: **не прикреплён в предыдущем чате**, пользователь присоединит его в новом чате вместе с этой папкой

## Ключевой эндпоинт

`GET /api/riot/champion-players/global?champion=X&limit=100`

Файл: `src/routes/champion-players-global.ts`

Tier система (0–3), после недавнего патча:
- 0 `main` — ≥30 games, ≥20% share, WR>50%
- 1 `regular` — ≥10 games, ≥10% share, WR>50%
- 2 `casual` — ≥5 games (любые share/WR)
- 3 `trial` — 2–4 games (fallback для редких чемпов)

SQL hard-пол: `championGames >= 2`. Сортировка: `qualityTier ASC, p.lp DESC`. Popular champs всегда заполняются main/regular/casual — trial туда не всплывает.

Ответ включает `qualityMix: {main, regular, casual, trial}` для отладки.

## Ops скрипты (в папке `ops/`)

| Файл | Что делает |
|---|---|
| `shared.cjs` | prisma, riotFetch (token bucket 100/120s), getRegionalHost, loadChampions |
| `seed-masters.cjs` | Upsert Challenger/GM/Master Player rows (euw/na/kr). Master → top-400 by LP |
| `deep-backfill.cjs` | 60-дневная история матчей per puuid. **Resumable** через `ops/logs/deep-backfill.state.json`. Args: `--region`, `--regions`, `--max-matches`, `--player-limit`, `--reset` |
| `status.cjs` | Coverage report. `--json` → машиночитаемый вывод |
| `run-all.sh` | Orchestrator: seed → status → backfill → status |
| `run-forever.sh` | Optional daemon loop (пользователь не использует) |
| `README.md` | Подробная документация |

## Текущее состояние данных (на момент handoff)

- **3557 Master+ игроков** засижены в БД (euw 758, kr 1399, na 1400)
- **19327 матчей** / **193k participants** (60-дневное окно, queueId=420 ranked solo)
- Глубоко пробэкфилены **1200 топ-LP игроков**. Остальные 2357 Master — есть в Player, но без матчей.
- **13 чемпионов** прошли open≥100: Ezreal (215), Jayce (180), Yunara (174), Ambessa (159), Anivia (140), Aurora (140), Karma (132), Nautilus (122), Bard (119), LeeSin (116), JarvanIV (108), Ryze (108), Ashe (101)
- Пустой: **Fiddlesticks** (никто в Master+ не играет 2+ раза за 60 дней)

### Распределение по 172 чемпионам (после последнего бэкфилла, с текущим `>= 5`-порогом в status.cjs)

| open игроков | чемпионов |
|---|---|
| ≥100 | 13 |
| 50–99 | 33 |
| 20–49 | 55 |
| 5–19 | 57 |
| 1–4 | 13 |
| 0 | 1 |

После патча с `trial` tier (порог ≥2) редкие чемпы подтягиваются: Amumu 3→12, Mordekaiser 2→13. Fiddlesticks остаётся 0.

## Дорожная карта (согласована с пользователем)

1. **[текущий] MVP готов к деплою.** Tier-система работает, 13 чемпов заполнены на 100, у остальных fallback на trial.
2. **VPS + домен.** Рекомендация: Hetzner CX22 во Франкфурте (€4.5/мес, 2 vCPU / 4 ГБ / 40 ГБ NVMe). Когда будет prod key → CX32 (€7.5, 4 vCPU / 8 ГБ).
3. **Deploy stack:** nginx/Caddy + Let's Encrypt, PM2 для Express, systemd для deep-backfill воркера, автобэкап PG в B2.
4. **Privacy Policy + ToS + Riot attribution** — обязательные страницы для подачи заявки на API key.
5. **Personal API Key** — промежуточный тир Riot, ~10× лимитов dev-ключа. Апрув обычно 1–3 дня. Этого хватит, чтобы добрать 2357 оставшихся Master за ~2 часа.
6. **Production API Key** — после того как MVP живой на домене с трафиком и есть фронт/приват/тосы. 500 req/10s + 30k req/10min, апрув 1–4 недели.

## Что делать в новом чате

Пользователь планирует прикрепить:
- эту папку `lol-tricks-api/` (бэкенд)
- отдельную папку фронтенда (стек пока неизвестен Claude)

Первое действие в новом чате: прочитать этот HANDOFF, посмотреть структуру фронта, и дальше обсуждать, как их связать (shared types, API client, deployment план). Возможно, стоит вынести в общий монорепо.

## Важные нюансы / на что обратить внимание

- **Dev key живёт 24 часа**, Riot API ключ хранится в `.env` (не коммитить!).
- **Rate limit dev-ключа — главное узкое горлышко.** 100 req / 120s глобально. Полный бэкфилл 3557 игроков с ним нереален.
- **`ops/deep-backfill.cjs` идемпотентен** — Ctrl+C безопасен, прогресс в state-файле.
- **Регионы:** строго EUW / NA / KR. Не расширять без явной просьбы.
- **Master tier** всегда capped top-400 by LP (иначе добавляется сотни тысяч «чернушных» Master-игроков, которые шумят).
- **Прикладывать Prisma linux-arm64 engine** в `node_modules/.prisma/client/` если Claude запускает в sandbox.

## Контакт и артефакты

- Cowork artifact `lol-tricks-coverage-dashboard` — HTML-дашборд, принимает paste status.cjs --json, визуализирует grid с цветовой кодировкой тиров.
- Пользователь предпочитает **краткий ответ → конкретная команда**. Не уходи в длинные объяснения, если не спрашивает.
- Пользователь русскоязычный, отвечай на русском.
- Никаких scheduled-тасков без явной просьбы — manual workflow (запустил скрипт → скинул вывод → обсудили).
