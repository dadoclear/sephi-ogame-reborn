# Constructions

SephiOGame keeps a **construction queue per planet and moon**: buildings, research, ships and defenses. While the player is away, it visits the planets one after another, checks their resources, and launches the next queued item as soon as OGame allows it — using OGame’s normal build button.

- [Adding to the queue](#adding-to-the-queue)
- [The queue on the game pages](#the-queue-on-the-game-pages)
- [The Constructions tab](#the-constructions-tab)
- [The planet rotation](#the-planet-rotation)
- [Launching a construction](#launching-a-construction)
- [Resource estimates](#resource-estimates)
- [When the rotation is suspended](#when-the-rotation-is-suspended)
- [Stored data](#stored-data)
- [Code map](#code-map)

---

## Adding to the queue

- **Ressources, Installations, Chantier spatial, Défense**: open an item’s detail in OGame; a button « Programmer : *name* » appears under the queue. For ships and defenses, the quantity typed in OGame’s amount field is used.
- **Recherche**: a selector « Recherche à programmer sur cette planète » lists the research of the page, with « Programmer la recherche ».

The item is added to the end of the **current planet’s** queue, with its cost when OGame shows it. The panel confirms with the estimated time until the resources are available.

---

## The queue on the game pages

On the **overview** and on Ressources, Installations, Recherche, Chantier spatial and Défense, the current planet’s queue is shown under OGame’s own blocks, styled like the game:

- one bar per item: « [En cours] » for the item being launched, name and quantity, category, and the estimate « Ressources estimées dans hh:mm:ss » (hover for the missing amount of each resource);
- **drag the ⠿ handle** to reorder (the item being launched cannot move);
- **×** removes an item (not the one being launched);
- « n construction(s) programmée(s) » and the link « File automatique · détails » (opens the Constructions tab on this planet).

---

## The Constructions tab

- « File de la planète / lune »: choose which planet’s queue to show.
- The latest status message of that planet (« Construction confirmée par OGame. », « … · attente de ressources ou du chantier. »…).
- « Production / heure : métal …, cristal …, deutérium … » with the date it was read.
- The same bars as on the game pages.

No start button: adding an item is enough; the rotation does the rest.

---

## The planet rotation

`syncConstructionWorker()` runs every second in the main window:

1. **Wait for inactivity**: nothing happens until **2 minutes** without click, key press or input, and 2 minutes since the last check. A notice at the bottom right says « Contrôle de la file de la planète *Etheirys [3:414:10]* dans N s sans activité. Un clic reporte le changement de deux minutes. »
2. **Choose the planet**: the one checked the longest time ago, among all planets and moons (with or without a queue).
3. **Go there**: if it is not the current planet, the visible page switches to its overview (« Changement vers la planète … pour vérifier sa file et ses ressources. »).
4. **Check**: the planet’s resources, production and storage are recorded. If its queue is empty, the check ends there; otherwise the next item is launched in a hidden frame (see below).

Then the rotation continues with the next planet after the next 2 minutes of inactivity. Only one tab runs the rotation at a time.

---

## Launching a construction

`runConstructionAttempt()`, in the hidden frame `sephi-construction-worker`:

1. Open the item’s page (Ressources, Installations, Recherche, Chantier spatial or Défense) on the right planet, and its detail.
2. Set the quantity for ships and defenses; update the item’s cost from the detail.
3. **Do not launch** if:
   - OGame’s normal build button is disabled (« attente de ressources ou du chantier »);
   - only the premium (dark matter) button is available;
   - the player was active in the last 2 minutes;
   - an auto-attack cycle or a discovery scan is running.
4. Record the launch as pending, then click OGame’s **normal** build button once.
5. **Confirm**: success of OGame’s build request, or the level / quantity having changed on a later visit. The item then leaves the queue and the planet’s resources are reduced by its cost.
6. **Never click twice**: while a launch is pending and not confirmed, later visits only wait (« Construction lancée · attente de sa confirmation ou de sa fin. »). A refusal from OGame frees the item for the next visit.

A frame that does not start within 20 s is reported (« Moteur de construction indisponible · nouvel essai au prochain passage. »).

---

## Resource estimates

`constructionEstimate()` uses the planet’s last reading (`capturePlanetEconomy`): resources, production per hour and storage, read from OGame’s resource bar on each page of that planet.

- Costs are **cumulative** along the queue: the estimate of the 3rd item includes the costs of the 1st and 2nd.
- Resources are projected from the reading time with the production, capped by the storage.
- Texts:
  - « Ressources estimées dans hh:mm:ss »;
  - « Ressources disponibles · attente du chantier / contrôle »;
  - « Production inconnue : estimation indisponible » — production per hour could not be read for that planet;
  - « Production ou stockage insuffisant » — a cost exceeds the storage, or production is zero;
  - « Estimation indisponible : coûts ou ressources à vérifier ».
- Estimates are refreshed every second, and never prevent a launch: the decision is always OGame’s button state.

---

## When the rotation is suspended

| Situation | Effect |
|---|---|
| Player active | Waits 2 minutes after the last activity. |
| Auto-attack cycle running | Rotation and launches suspended (« Rotation des planètes suspendue pendant le cycle d’auto-attaque. »). |
| Discovery scan running | Rotation and launches suspended. |
| Auto-éject evacuation | Rotation waits. |
| Slots-mode check running | Rotation waits for it. |

---

## Stored data

| Key | Content |
|---|---|
| Main data `constructionQueue` | All queued items: id, planet, page, technology id, name, quantity, costs. Included in « Exporter JSON ». |
| `<account>:construction-state:<planetId>` | Per planet: running, pending launch, last check, message, worker token. |
| `<account>:economies` | Per planet: resources, production per hour, storage, reading time. |
| `<account>:construction-coordinator` | Rotation lease. |
| `<account>:construction-visit` (session) | Marks a planet change made by the rotation. |

---

## Code map

| Function | Role |
|---|---|
| `Panel.scanNativeEnhancements` | Queue on the game pages, « Programmer » buttons, research selector. |
| `Panel.addConstruction`, `changeConstructionQueue`, `renderConstructionBars`, `constructions` | Queue changes and display. |
| `Panel.syncConstructionWorker` | Rotation. |
| `runConstructionWorker`, `runConstructionAttempt`, `constructionConfirmed`, `constructionDetail` | Launch in the worker frame. |
| `capturePlanetEconomy`, `constructionCosts`, `constructionEstimate`, `updateConstructionEstimates` | Resources, costs, estimates. |
| `moveConstruction`, `planetQueue` | Reordering, per-planet queue. |
