# Paramètres, Sauvegardes and Diagnostic

- [Paramètres](#paramètres)
- [Sauvegardes](#sauvegardes)
- [Diagnostic](#diagnostic)

---

## Paramètres

The tab has two cards:

1. **« Auto-éject · planète / lune courante »** — see [Auto-éject](auto-eject.md#settings).
2. **« Capacités et calculs »** — the settings below, saved with « Enregistrer les paramètres ».

| Field | Default | Limits | Used by |
|---|---|---|---|
| Déclenchement des auto-attaques | Intervalle entre les cycles | interval / slots | [Auto-attacks](auto-attacks.md#triggers-interval-or-free-slots) |
| Slots utilisables libres nécessaires (hors réserve) | 3 | 1 – 100 | Auto-attacks, slots mode |
| Inactivité avant lancement par slots (secondes) | 60 | 15 – 3,600 | Auto-attacks, slots mode |
| Planète mère pour les campagnes | first planet of the OGame list | planets only | Auto-attacks, Discovery |
| Maximum de vagues par frigo et par cycle | 10 | 1 – 100 | Auto-attacks |
| Capacité effective PT | 5,000 | ≥ 1 | Loot / cargo estimates, auto-attacks |
| Capacité effective GT | 25,000 | ≥ 1 | Loot / cargo estimates, auto-attacks |
| Butin minimum pour attaquer | 10,000 | ≥ 0 | Auto-attacks |
| Intervalle entre les cycles d’auto-attaques (minutes) | 360 | 1 – 10,080 | Auto-attacks, interval mode |
| Attente maximale des slots / vaisseaux (minutes) | 10 | 1 – 120 | Auto-attacks |
| Slots de flotte à garder libres pour les auto-attaques et sondages | 1 | 0 – 100 | Auto-attacks, slots mode, Expeditions |
| Pillage par défaut (%) | 50 | 0 – 100 | Loot estimates when a report has no percentage |
| Sondes par défaut | 1 | 1 – 1,000,000 | New frigos, Discovery |

Set the effective capacities to what your account really has (technologies, class and lifeforms included): the default values are base values. Loot estimates are totals; the actual split and fuel can need a margin.

Saving the settings during a campaign applies the trigger mode immediately and resumes the campaign.

Settings are stored in the main data (`settings`) and validated on every save; out-of-range values are refused with a message.

---

## Sauvegardes

All local: nothing is sent to a server.

### Export

« Exporter JSON » downloads `SephiOGame-local.json`: the main data of the account, validated (schema version 4):

- frigos (`targets`) with their reports and history;
- settings, including per-planet auto-éject;
- construction queue;
- discovery banned list and gros poissons;
- archives of imported old saves.

**Not included**: the current auto-attack campaign and its failure history, the discovery scan in progress and its previous reports, planet economies, expedition settings, state and results, panel position.

### Import

« Importer .json ou .sephiOGame » accepts (10 MB maximum):

- a SephiOGame 4 export (`schemaVersion: 4`);
- an old SephiOGame save (`.sephiOGame` text format or old JSON with `frigos`): frigos are converted (name, coordinates, enabled, memo, ignore, reference and observed fleet/defense, probes); the original content is kept in `legacyArchives`.

The import **merges** into the current data:

| Part | Rule |
|---|---|
| Frigos | Imported only if not already present; existing frigos are kept as they are. |
| Construction queue, banned list, gros poissons | Merged by id. |
| Settings | Taken from the import only if the account has no frigo yet; otherwise the current settings are kept. |
| Archives | Added. |

### Old saves in the browser

When the browser still holds saves of the old SephiOGame (`localStorage` keys ending with `_dump_saved_vars` or `_dump_saved_vars_v2`), the tab lists them: choose one in « Clé historique » and click « Importer cette planète ». The old keys are left untouched.

---

## Diagnostic

### Mises à jour

Shows the installed and the published version with the result (« mise à jour disponible », « à jour », « version locale plus récente ») and when it was checked. « Vérifier les mises à jour » checks now; « Ouvrir le fichier publié » opens the published file. See [Update check](panel.md#update-check).

### Diagnostic

A JSON document for troubleshooting, with « Exporter diagnostic » (`SephiOGame-diagnostic.json`):

| Section | Content |
|---|---|
| `version`, `mode`, `context`, `storageKey`, `schemaVersion` | Script version, detected account, universe, planet and page. |
| `targets`, `archives` | Number of frigos and archives. |
| `discovery` | Scan status, progress, current candidate, worker, failures and journal. |
| `campaign` | Campaign status, phase, progress, reports received, waits, skipped and deferred frigos, pending send, owner tab. |
| `ogame` | What the current page exposes: fleet dispatcher, fleet slots, ships on the planet, messages found. |
| `campaignLog` | The last 150 automation log entries of this tab (tokens masked). |
| `campaignFailures` | Failure and retry history. |
| `automation` | Reserved slots, per-planet construction states, planet economies, auto-éject settings and last evacuation. |

The discovery scan has its own « Exporter diagnostic du scan » in the Découverte tab, and expeditions keep their own log in the Expéditions tab.
