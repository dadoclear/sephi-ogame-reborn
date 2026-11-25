# Auto-éject

**Auto-éject** evacuates a planet or moon shortly before an identified enemy attack lands: all mobile ships leave with as many resources as they can carry, so the attacker finds nothing. It is configured per planet or moon, in the **Paramètres** tab.

- [Settings](#settings)
- [How an attack is detected](#how-an-attack-is-detected)
- [The evacuation](#the-evacuation)
- [Statuses and messages](#statuses-and-messages)
- [Interaction with other features](#interaction-with-other-features)
- [Stored data](#stored-data)
- [Code map](#code-map)

---

## Settings

Card « Auto-éject · planète / lune courante » in Paramètres. It applies to the planet or moon currently open in OGame; open each planet to configure it.

| Field | Values | Meaning |
|---|---|---|
| Auto-éject | Désactivé / Activé | Enables evacuation for this planet or moon. |
| Destination d’évacuation | e.g. `[1:234:5]` | Where the fleet goes. Must differ from the planet being evacuated. |
| Destination | Planète / Lune | Type of the destination. |
| Mission | Transport / Stationnement (chez vous) | Stationnement requires a destination that belongs to you. |

« Enregistrer l’auto-éject de cette planète » saves it. Setting « Désactivé » with an empty destination removes the configuration. The last evacuation message is shown under the card.

The browser must stay open and logged in for the evacuation to happen.

---

## How an attack is detected

`monitorAutoEject()` runs every **10 seconds** in the main window when at least one planet has auto-éject enabled:

1. Reads OGame’s event list (`page=componentOnly&component=eventList&ajax=1`).
2. Keeps **outbound hostile** fleets — attack (1), joint attack (2) or destroy (9) — whose destination is one of your planets or moons and whose origin is **not** one of yours (`incomingAttacks`).
3. Takes the first attack landing within **5 minutes** on a planet with auto-éject enabled, that has not already been handled.
4. If the attacked planet is not the current one, the visible page switches to it.
5. Starts the evacuation in a hidden frame on the fleet page towards the destination.

The check runs in one tab only (Web Lock `<account>:eject-claim`). Browsers without Web Locks cannot use auto-éject; the panel says so.

---

## The evacuation

`runEjectWorker()`, in the hidden frame `sephi-eject-worker`:

1. Check the configuration is still enabled for this planet and the destination shown by OGame matches it.
2. Check a fleet slot is free.
3. Select **all mobile ships** (everything except solar satellites 212 and crawlers 217).
4. Set the speed to **10 %** and wait for a valid fuel calculation.
5. Go to the next step, choose the mission (Transport or Stationnement) and load the **maximum of resources** (`selectMaxAll`). Fuel and cargo space limit what can leave.
6. **Re-check just before sending**:
   - the attack is still coming and still lands within 5 minutes;
   - the configuration has not changed;
   - with Transport, the round trip lasts long enough for the fleet to still be away **one minute after the impact** — otherwise the evacuation is refused (« Transport trop court… Choisissez une destination plus lointaine ou un stationnement. »);
   - a slot is free, fuel is enough, and every mobile ship is still selected.
7. Send through OGame’s own button and watch OGame’s answer.

An evacuation is attempted **once** per attack.

---

## Statuses and messages

| Status | Meaning |
|---|---|
| `preparing` | Fleet page being prepared (« Attaque entrante · préparation de l’évacuation. »). Considered stuck after 45 s. |
| `pending` | Sent, waiting for OGame’s answer. |
| `confirmed` | « Évacuation confirmée. Ressources restantes : M …, C …, D …. » |
| `failed` | The reason, e.g. « Évacuation impossible : aucun slot libre. », « Aucun vaisseau mobile disponible… », « Évacuation annulée : attaque retirée ou réglages modifiés. », « OGame a refusé l’évacuation. » |

Messages also appear in the notice box at the bottom right of the page.

---

## Interaction with other features

- A running auto-attack cycle is **abandoned** in favour of the evacuation (« Attaque entrante · priorité à l’évacuation. »).
- The evacuation waits if an auto-attack send is pending or a construction is being launched.
- While an evacuation is being prepared or awaits confirmation, the construction rotation, slots-mode monitoring, discovery steps and expedition cycles wait.

---

## Stored data

| Key | Content |
|---|---|
| Main data `settings.autoEject` | Per planet id: `enabled`, `coords`, `mission` (3 transport, 4 stationnement). Included in « Exporter JSON ». |
| `<account>:eject-job` | Current or last evacuation: token, status, attack, planet, ships, remaining resources, message. |
| `<account>:eject-history` | Attacks already handled (by attack id), so an attack triggers one evacuation only. |

---

## Code map

| Function | Role |
|---|---|
| `Panel.ejectSettings` | Settings card. |
| `Panel.monitorAutoEject` | Detection and start. |
| `fetchAttackEvents`, `incomingAttacks` | Event list reading. |
| `runEjectWorker`, `evacuationShips` | Evacuation in the worker frame. |
