# Frigos and spy reports

A **frigo** (« fridge ») is a target the player farms: usually an inactive player’s planet or moon. SephiOGame keeps a list of frigos with their latest spy report, estimates the loot, and prepares the fleet pages to probe or raid them.

- [The frigo record](#the-frigo-record)
- [Loot and cargo estimate](#loot-and-cargo-estimate)
- [Status of a frigo](#status-of-a-frigo)
- [The Frigos tab](#the-frigos-tab)
- [The Espionnage tab](#the-espionnage-tab)
- [In the Messages page](#in-the-messages-page)
- [In the Galaxy](#in-the-galaxy)
- [Fleet preparation links](#fleet-preparation-links)
- [Returning resources summary](#returning-resources-summary)
- [How spy reports are read](#how-spy-reports-are-read)
- [Code map](#code-map)

---

## The frigo record

Each frigo is stored in the main data (`targets`) and identified by `galaxy:system:position:type` (`type` = `planet` or `moon`).

| Field | Meaning |
|---|---|
| `name` | Display name (player or planet name). |
| `coords` | Galaxy 1–99, system 1–999, position 1–15, planet or moon. |
| `enabled` | « Activer » / « Désactiver ». Disabled frigos are skipped by auto-attacks. |
| `ignore` | « Ignorer : Oui » — also skipped by auto-attacks, shown as « Ignoré ». |
| `probeCount` | Probes sent to this frigo (default: « Sondes par défaut » in Paramètres). |
| `customFleet` | Free memo (« Flotte personnalisée (mémo) »); not used by automation. |
| `knownFleet`, `knownDefense` | Reference fleet / defense values; a change is reported in the status. Set from the first report, editable. |
| `lastReport` | Latest report: resources, fleet, defense, loot percentage, time. |
| `history` | Up to 20 previous reports (duplicates are merged). |
| `notes`, `tags` | Free text; searchable. Discovery adds the tags « découverte » and « sonde revenue ». |

---

## Loot and cargo estimate

- **Loot** = (metal + crystal + deuterium of the report) × loot percentage, rounded down. The percentage comes from the report when present, otherwise from « Pillage par défaut (%) » (50 % by default).
- **Cargo**: number of ships = loot ÷ effective capacity, rounded up. Capacities are « Capacité effective PT » (5,000) and « Capacité effective GT » (25,000) in Paramètres — set them to the values your account really has (technologies, class, lifeforms).

Shown as « Butin estimé 1 234 567 · 247 PT · 50 GT ».

---

## Status of a frigo

`targetStatus()` gives, in this order:

| Status | When |
|---|---|
| Ignoré | « Ignorer » is Oui. |
| Désactivé | Frigo disabled. |
| Informations incomplètes | No report, or the report does not state fleet and defense. |
| Flotte / défense modifiée | The report’s fleet or defense differs from the reference values. |
| Flotte / défense présente | Fleet or defense above zero. |
| Aucune flotte / défense observée | Fleet and defense explicitly zero. |

Reports with fleet or defense above zero, or with unknown values, show a red warning « Attaque bloquée · … »: auto-attacks only attack when both are explicitly **0**.

---

## The Frigos tab

### « N frigos suivis »

- **Filter** on name, coordinates, notes and tags; **sort** by coordinates, « Butin décroissant » or « Dernier scan ».
- Columns: Cible (with the number and date of auto-attack failures, hover for the last message), Butin estimé (with PT / GT), Dernier scan, État, Actions.
- **Actions**:
  - « Modifier », « Activer » / « Désactiver », « Supprimer » (asks for confirmation);
  - links « Galaxie », « Sonder (n) », « Préparer attaque », and « Raid PT » / « Raid GT » when a report with loot exists (see [Fleet preparation links](#fleet-preparation-links));
  - « Historique (n) » lists past reports.
- Narrow panel: each frigo becomes a card (see [Responsive layout](panel.md#responsive-layout)).

### « Ajouter un frigo » / « Modifier le frigo »

Fields: Nom, Coordonnées (`[2:143:7]`), Type, Sondes, Flotte personnalisée (mémo), Flotte de référence, Défense de référence, Notes, Tags (comma separated), Ignorer.

- A frigo that already exists cannot be added twice.
- The coordinates of a frigo that has a history cannot be changed: create a new frigo instead.

---

## The Espionnage tab

- **« Analyser un rapport d’espionnage »**: paste the HTML of a detailed spy report, click « Analyser ». The HTML is parsed without being executed (2 MB maximum). The result shows resources, loot, PT/GT, fleet, defense, loot percentage and any warning, with « Enregistrer dans les frigos ».
- **« Saisie manuelle / calculateur local »**: enter name, coordinates, type, metal, crystal, deuterium, and optionally fleet and defense (empty = unknown), then « Calculer ». Same result card.

---

## In the Messages page

Each spy report gets a SephiOGame toolbar (reports about your own planets are skipped):

- « SephiOGame · Butin ≈ … · n PT / n GT »;
- « Préparer n PT » and « Préparer n GT » links (when loot > 0);
- « Ajouter aux frigos » or « Actualiser le frigo » (records the report in the frigo);
- « Galaxie », « Préparer sondes », and « Retirer des frigos » for a saved frigo.

When the resources cannot be read (collapsed report), the toolbar says « Ressources indisponibles : ouvrir le rapport détaillé » and offers « Ajouter aux frigos » with the coordinates only.

The toolbars update automatically when the page changes (a `MutationObserver` watches the document).

---

## In the Galaxy

Each foreign player row gets « ☆ Frigo planète » (and « ☆ Frigo lune » when the planet has a moon). Saved targets show « ★ Retirer planète / lune » instead.

---

## Fleet preparation links

« Sonder », « Préparer attaque », « Raid PT/GT », « Préparer n PT/GT » and « Préparer sondes » open OGame’s fleet page with the destination and mission already set (mission 6 espionage, mission 1 attack), starting from the current planet. Ships are pre-selected; **sending is always confirmed by the player in OGame** — these links never send anything.

How it works (`fleetURL()`, `prepareFleet()`):

1. The link carries `#sephiShip=<id>&sephiCount=<n>&sephiPlayer=<playerId>` (and `sephiLoot` for raids) in its hash.
2. On the fleet page, the script waits for OGame’s fleet dispatcher, then checks:
   - the link belongs to this account;
   - the ship is a small cargo (202), large cargo (203) or probe (210);
   - the destination shown by OGame matches the link;
   - no ships are already selected (your own selection is never replaced).
3. For raids, the number of cargo ships is recomputed with the cargo capacity OGame reports for your account.
4. It selects `min(needed, available)` ships and shows a notice box at the bottom right, for example « 120 PT sélectionnés sur 247 nécessaires : flotte insuffisante. Vérifiez la destination, la mission et le carburant, puis poursuivez dans OGame. »
5. The hash is removed from the address so a reload does not select again.

The notice box (`#sephi-fleet-notice`) is also used by other features for short messages (construction rotation, auto-éject…).

---

## Returning resources summary

On the **Mouvements** page, a box « Ressources en cours de retour » adds up, per destination planet, the metal, crystal and deuterium carried by fleets on their way back. Fleets whose destination or cargo cannot be read are counted separately and excluded from the totals.

---

## How spy reports are read

`parseEspionageReport()` reads, in order of preference:

1. OGame’s structured data on the message (`data-messages-filters-*` attributes, `.rawMessageData` with `data-raw-*` values such as `data-raw-fleetvalue`, `data-raw-defensevalue`, `data-raw-timestamp`, `data-raw-targetplanettype`);
2. the resource elements of the detailed report;
3. the report text (labels « Métal / Metal », « Cristal », « Deutérium », « Flottes », « Défense », « Pillage / Loot »).

Numbers accept French and English formats and the `k`, `M`/`Mn`, `B`/`Bn` suffixes; ambiguous values are rejected rather than guessed. A report is accepted only if it is explicitly a spy report.

---

## Code map

| Function | Role |
|---|---|
| `createTarget`, `recordReport`, `targetStatus`, `attackReportWarning` | Frigo record, report history, status, attack warning. |
| `calculateLoot`, `calculateRequiredCargo` | Loot and cargo estimates. |
| `parseSpyTarget`, `parseEspionageReport`, `parseReportHTML`, `parseNumber` | Report reading. |
| `actionURL`, `fleetURL`, `prepareFleet`, `showPreparation` | Fleet page links, ship pre-selection, notice box. |
| `galaxyTarget` | Reads a galaxy row. |
| `returningResourceGroups`, `renderReturningResources` | Mouvements summary. |
| `Panel.targets`, `Panel.reports`, `Panel.showReport`, `Panel.addTarget`, `Panel.removeTarget`, `Panel.ingest` | Tabs and frigo changes. |
| `start()` → `scan` | Toolbars in Messages and Galaxy, menu entry. |
