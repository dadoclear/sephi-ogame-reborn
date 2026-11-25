# SephiOGame documentation

SephiOGame is a Tampermonkey userscript for OGame ([`sephi-ogame-reborn.user.js`](../sephi-ogame-reborn.user.js)). It adds a floating panel to the game to manage farming targets (« frigos »), automate probing and raids, find inactive players, queue constructions, relaunch expeditions and evacuate planets before an attack.

## Pages

| Page | Content |
|---|---|
| [Architecture](architecture.md) | Start-up, the 1-second automation clock, hidden worker frames, coordination between tabs and features, player activity, every storage key, logs. |
| [The panel](panel.md) | Opening, position and size, header, tabs, responsive layout, visual design and animations, update check, additions to OGame’s pages. |
| [Frigos and spy reports](frigos-and-reports.md) | Frigos tab, Espionnage tab, loot estimate, statuses, toolbars in Messages and Galaxy, fleet preparation links, returning resources summary. |
| [Auto-attacks](auto-attacks.md) | Campaigns: spy, reports, attack waves; interval and free-slots triggers; waits, retries, safety rules. |
| [Auto expeditions](auto-expeditions.md) | Expéditions tab: configuration, relaunch cycle, OGame requests, result tracking and exhausted-system switch. |
| [Discovery](discovery.md) | Scanning for inactive players: systems visited, candidates, decision rule, banned list and gros poissons. |
| [Constructions](constructions.md) | Per-planet construction queue, planet rotation, launching through OGame’s button, resource estimates. |
| [Auto-éject](auto-eject.md) | Evacuation before an identified attack: detection, evacuation steps, statuses. |
| [Paramètres, Sauvegardes and Diagnostic](settings-backups-diagnostic.md) | All settings, export / import and old saves, diagnostic document. |

## Where to start

- **Using the script**: [The panel](panel.md), then the page of the feature you need.
- **Understanding or changing the code**: [Architecture](architecture.md), then the « Code map » section at the end of each feature page.
- **Something does not work**: the Diagnostic tab ([Diagnostic](settings-backups-diagnostic.md#diagnostic)), the console lines starting with `[SephiOGame`, and the troubleshooting notes of each feature.

## Conventions

- The panel UI is in French; labels are quoted exactly as they appear in the panel (for example « Envoyer maintenant »).
- Storage keys use the account prefix `sephiogame:v4:<universe>:<playerId>`, written `<account>`.
- Code references point to function names in the userscript rather than line numbers, which change often.
- This documentation is kept up to date with every code change.
