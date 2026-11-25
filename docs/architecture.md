# Architecture

How the userscript starts, how its background work is organised, how tabs coordinate, and where everything is stored.

- [Start-up](#start-up)
- [The automation clock](#the-automation-clock)
- [Worker frames](#worker-frames)
- [Coordination between tabs and features](#coordination-between-tabs-and-features)
- [Player activity](#player-activity)
- [Storage](#storage)
- [Logs and diagnostics](#logs-and-diagnostics)

---

## Start-up

The script is a single file, [`sephi-ogame-reborn.user.js`](../sephi-ogame-reborn.user.js), bundled from TypeScript sources (`src/...` comments mark the original modules). It runs on `https://*.ogame.gameforge.com/game/index.php*` at `document-end`.

1. **`boot()`** runs on game hosts only (`s<number>-<lang>.ogame.gameforge.com`). In the main window it shows a small status badge at the top left (« SephiOGame 4.0.0-… · Chargement »), registers the Tampermonkey menu entry « Diagnostic de démarrage SephiOGame », then calls `start()`.
   - Success: the badge is removed.
   - Player not detected yet (the `ogame-player-id` meta tag is missing): the badge shows « Compte non détecté » and start-up is retried as soon as the meta tags appear.
   - Another copy already running: « Panneau déjà présent » (only one SephiOGame version should be enabled).
   - Error: « Erreur de démarrage »; clicking the badge shows the details.
2. **`start()`** reads the player context from the page’s meta tags (`getPlayerContext`: player id and name, universe, language, current planet id, current page), then:
   - inside a **worker frame**, runs that worker only (see [Worker frames](#worker-frames));
   - otherwise creates the **panel** (`new Panel(...)`), registers the Tampermonkey menu entries « Ouvrir SephiOGame » and « Sauvegardes SephiOGame », installs the additions to OGame’s own pages, starts the automation clock, prepares a fleet if the URL asks for it, and resumes a running auto-attack campaign.
3. On the very first start for an account, the panel opens on Frigos with « SephiOGame est actif sur ce compte… » (`<account>:installed`).

All data is per account: the storage prefix is `sephiogame:v4:<universe>:<playerId>`, written `<account>` in this documentation.

---

## The automation clock

`Panel.installNativeEnhancements()` starts a 1-second interval in the main window. Each tick runs, independently (an error in one never blocks the others):

| Task | Feature | Real work happens… |
|---|---|---|
| `updateCountdown` | [Auto-attacks](auto-attacks.md) | every tick (countdown text in the panel and on the overview page) |
| `monitorDiscovery` | [Discovery](discovery.md) | when a scan is running in this tab |
| `monitorSlotCampaign` | [Auto-attacks](auto-attacks.md) | in « slots » mode, while waiting for the next cycle |
| `syncConstructionWorker` | [Constructions](constructions.md) | after 2 minutes without player activity |
| `monitorExpeditions` | [Auto expeditions](auto-expeditions.md) | when a check is due |
| `monitorAutoEject` | [Auto-éject](auto-eject.md) | every 10 s if at least one planet has auto-éject enabled |
| `updateConstructionEstimates` | [Constructions](constructions.md) | every tick (refreshes the « Ressources estimées dans … » texts) |

The clock stops when the page is left (`pagehide`). Because OGame reloads the page on almost every click, the clock restarts on each page with the state read back from storage.

---

## Worker frames

Work that needs a full OGame page (the native fleet dispatcher, a building page, the messages page…) runs in a **hidden iframe** of the same origin, so the visible page does not move. Each worker frame carries a random token in its URL and in `data-sephi-worker`; a page only acts as a worker when the token matches the frame created by the main window.

| Frame id | URL marker | Feature | Purpose |
|---|---|---|---|
| `sephi-campaign-worker` | `sephiWorker` | Auto-attacks | Runs the campaign: dispatcher pages for probes and attacks, Messages for reports. |
| `sephi-slots-worker` | `sephiSlotsWorker` | Auto-attacks (slots mode) | Reads fleet slots on the home planet’s fleet page. |
| `sephi-construction-worker` | `sephiBuildWorker` | Constructions | Opens the building page and launches the next queued item. |
| `sephi-eject-worker` | `sephiEjectWorker` | Auto-éject | Prepares and sends the evacuation fleet. |
| `sephi-discovery-worker` | `sephiDiscovery` | Discovery | Probe, read reports, send the test probe, follow movements. |

A worker that does not report « ready » within about 20 s is considered failed and the owning feature retries later. Auto expeditions do **not** use a worker frame: they call OGame’s endpoints directly (see [Auto expeditions](auto-expeditions.md#ogame-requests-used)).

---

## Coordination between tabs and features

Several OGame tabs can be open with the script. Leases in `localStorage` make sure a given job runs in one tab only:

| Lease key | Feature | Expires after |
|---|---|---|
| `<account>:construction-coordinator` | Construction rotation | 15 s |
| `<account>:slot-coordinator` | Slots-mode monitoring | 20 s |
| `<account>:expedition-lease` | Expedition cycle | 90 s |
| Web Lock `<account>:eject-claim` | Auto-éject | held for the check |
| Web Lock `<account>:build-lock:<planetId>` | Construction worker | held for the attempt |

The auto-attack campaign and the discovery scan record their **owner tab** (`runnerId` / `owner`, a per-tab id kept in `sessionStorage` under `<account>:campaign-tab`); the panel of another tab offers « Suivre dans cet onglet » / « Poursuivre dans cet onglet » to take over.

Features also give way to each other:

| Running | Postponed |
|---|---|
| Auto-attack cycle (spy / reports / attack) | Construction rotation and launches; discovery start; expeditions while a dispatch is pending |
| Discovery scan | Construction launches; start of a campaign or next cycle |
| Auto-éject evacuation | Construction rotation, slots monitoring, discovery step, expeditions; a running auto-attack cycle is abandoned |
| Construction launch in progress | Auto-éject waits for it; slots monitoring waits |

---

## Player activity

Clicks, key presses and inputs in the page update `<account>:last-activity`. It is used to avoid moving the player’s page while they play:

- the construction rotation waits for **2 minutes** without activity, and each activity postpones it again;
- the « slots » auto-attack trigger waits for « Inactivité avant lancement par slots » (60 s by default).

---

## Storage

Everything is in the browser for the OGame domain; nothing is sent to any server other than OGame (and GitHub for the [update check](panel.md#update-check)).

### Main data — `<account>`

The main record, validated on every load and save (`validateData`, schema version 4). It is what « Exporter JSON » writes.

| Field | Content |
|---|---|
| `targets` | The frigos, with their last report and up to 20 history entries. See [Frigos](frigos-and-reports.md#the-frigo-record). |
| `settings` | Everything in [Paramètres](settings-backups-diagnostic.md#paramètres), including per-planet auto-éject. |
| `constructionQueue` | Queued constructions of all planets. |
| `discoveryBanned` | Targets excluded from future discovery scans. |
| `discoveryBigFish` | « Gros poissons » set aside for manual review. |
| `legacyArchives` | Raw data imported from old SephiOGame saves. |
| `schemaVersion` | `4`. |

### Other keys — `localStorage`

| Key | Feature | Content |
|---|---|---|
| `<account>:installed` | Panel | First-start flag. |
| `<account>:window` | Panel | Position, size and collapsed state of the panel. |
| `<account>:last-activity` | Shared | Time of the last click / key / input. |
| `<account>:auto-attack` | Auto-attacks | Current campaign (phase, queues, reports, waits, retries…). |
| `<account>:failures` | Auto-attacks | Failure and retry history shown in Frigos and Auto-attaques. |
| `<account>:slot-snapshot`, `<account>:slot-home` | Auto-attacks | Slot count read by the slots worker; short-lived « return to home planet » marker. |
| `<account>:discovery` | Discovery | Current scan state (queue, rows, worker, journal). |
| `<account>:discovery-config` | Discovery | Last scan settings. |
| `<account>:discovery-reports` | Discovery | The 5 previous scan reports. |
| `<account>:construction-state:<planetId>` | Constructions | Per-planet worker state and message. |
| `<account>:economies` | Constructions | Per-planet resources, production per hour and storage, with the time they were read. |
| `<account>:eject-job`, `<account>:eject-history` | Auto-éject | Current evacuation; handled attacks. |
| `<account>:expedition-config`, `-state`, `-results` | Expeditions | See [Auto expeditions](auto-expeditions.md#stored-data). |
| `sephiogame:update-check` | Updates | Last published version found and when. |
| `sephiogame:<host>:systems` | Expeditions | Number of systems of the universe. |

### Session keys — `sessionStorage` (per tab)

| Key | Content |
|---|---|
| `<account>:campaign-tab` | This tab’s id, used as owner of campaigns, scans and leases. |
| `<account>:auto-attack-continuation` | Marks a navigation made by the campaign so the next page resumes it. |
| `<account>:construction-visit` | Marks a planet change made by the construction rotation. |
| `sephiogame:auto-log:<playerId>` | The last 150 campaign log entries. |
| `sephiogame:galaxy-read-method` | Which galaxy reading method works in this universe. |

---

## Logs and diagnostics

- Console lines start with `[SephiOGame <version>]` (start-up) or `[SephiOGame Auto <version>]` (automation steps, with their details as JSON).
- The campaign log keeps the last 150 entries per tab; tokens, cookies and passwords are masked before being stored.
- The **Diagnostic** tab shows all of this in one JSON document that can be exported (see [Diagnostic](settings-backups-diagnostic.md#diagnostic)).
