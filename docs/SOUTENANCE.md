# SalonEscrow — dossier de soutenance (validation finale du module Blockchain)

> Organisé selon la grille d'évaluation : **(1) concepts et conception · (2) smart contracts, sécurité et tests ·
> (3) questions / réponses · (4) utilisation de l'IA générative.**
> Chiffres vérifiés le 10/11/2026 : **182 tests réussis**, couverture des contrats de production **100 % des lignes et
> des fonctions, 92,9 % des branches**, analyse statique **Slither : aucune vulnérabilité** (seul l'avertissement
> informatif `timestamp`, justifié en §2.4).

---

## 0. Démonstration (5 minutes) — l'ordre à suivre

| # | Action | Ce qu'on montre |
|---|---|---|
| 1 | `cd SalonEscrow && npx hardhat test` | 182 tests verts, dont la suite **Sécurité — tests de vulnérabilités** |
| 2 | `npx hardhat coverage` | 100 % des lignes des contrats |
| 3 | `python -m slither . --filter-paths "node_modules\|contracts/test"` | aucune faille ; seul `timestamp` (justifié) |
| 4 | Terminal 1 : `npx hardhat node` | une blockchain locale (chainId 31337) |
| 5 | Terminal 2 (dans `projetnext`) : `escrow-dev.ts salon-yasmine 30` | déploiement + configuration des centres (acompte 30 TND) |
| 6 | Terminal 3 : `npm run dev:blockchain` | Salonia en mode blockchain |
| 7 | Connexion client → carte wallet → « Recevoir 100 MockTND » | faucet du jeton de test, signature MetaMask |
| 8 | Réservation sur `/reserver/salon-yasmine` | **approve** puis **createBooking** signés dans MetaMask ; rendez-vous confirmé ; solde 70 TND |
| 9 | Tableau de bord → **Blockchain** | les transactions et événements lus sur la chaîne |
| 10 | Staff : valider la prestation → trésorerie : **Retirer** | `markCompleted` puis `withdraw` (modèle « pull payment ») |

Avant la démo : dans MetaMask, **Paramètres → Avancé → Effacer les données de l'onglet activité** pour chaque compte
(sinon « Nonce too high » après un redémarrage de Hardhat).

---

## 1. Maîtrise des concepts et conception de la solution

### 1.1 Le besoin métier
Dans un salon de beauté, les **rendez-vous non honorés** (« no-show ») coûtent cher : le créneau est perdu. Un acompte
résout le problème, mais crée un **problème de confiance** :
- le client craint de ne jamais être remboursé s'il annule à temps ;
- le salon craint que le client conteste l'acompte s'il ne vient pas.

Aujourd'hui, un tiers de confiance (banque, plateforme de paiement) arbitre — avec des frais, des délais et des
litiges. **SalonEscrow remplace ce tiers par des règles publiques, écrites dans un smart contract, que personne ne peut
modifier après coup** : ni le salon, ni le client, ni la plateforme Salonia.

### 1.2 Pourquoi une blockchain (et pas seulement une base de données) ?
| Besoin | Base de données classique | Smart contract |
|---|---|---|
| Règles d'annulation incontestables | Salonia pourrait les changer | Code public, immuable après déploiement |
| L'argent bloqué ne peut pas être détourné | Il faut faire confiance à l'opérateur | Le contrat seul détient les fonds ; personne ne peut retirer le solde d'un autre |
| Preuve de la réservation et du règlement | Journal modifiable par l'admin | Événements horodatés, vérifiables par tous |
| Paiement entre parties qui ne se font pas confiance | Intermédiaire obligatoire | **Séquestre (escrow)** automatique |

**Ce qui n'a PAS été mis sur la chaîne** (choix assumé) : données personnelles (noms, téléphones), catalogue,
planning, factures. La chaîne ne voit que des **identifiants numériques** (`centerId`, `practitionerId`) et des
adresses. Raisons : RGPD / loi tunisienne (droit à l'effacement impossible sur une blockchain), coût du stockage,
performance. **Salonia (MongoDB) reste l'autorité sur le planning ; la chaîne est l'autorité sur l'argent de l'acompte.**

### 1.3 Choix de la plateforme
- **Ethereum / EVM** : standard le plus répandu, outillage mûr (Hardhat, OpenZeppelin, viem, MetaMask), et le contrat
  est portable tel quel sur toute chaîne EVM (Polygon, Base, Arbitrum…) si les frais devaient baisser.
- **Solidity 0.8.24** : vérification automatique des dépassements d'entier (pas besoin de SafeMath).
- **OpenZeppelin 5.0.2** (version figée) : `Ownable`, `ReentrancyGuard`, `SafeERC20`, `ERC20` — du code audité plutôt que réécrit.
- **Hardhat** : nœud local, tests en JavaScript (Mocha/Chai), contrôle du temps (`time.increaseTo`), couverture.
- **Réseau** : Hardhat local pour la démo ; **Sepolia** (testnet public) déjà prévu dans Salonia (`ESCROW_NETWORK=sepolia`).
  **Jamais le réseau principal** : le jeton est un jeton de test.
- **MockTND** : ERC-20 de test à **6 décimales** (comme l'USDC) qui représente le dinar. Pourquoi un jeton et pas de
  l'ETH ? Un acompte en ETH changerait de valeur chaque minute ; un jeton indexé sur le dinar garde un montant stable.
  En production, on le remplacerait par un **stablecoin** réglementé.

### 1.4 Architecture
```
 Navigateur du client                Serveur Next.js (Salonia)                 Blockchain (Hardhat / Sepolia)
 ┌──────────────┐  SIWE (EIP-4361)   ┌───────────────────────────────┐  viem  ┌──────────────────────────┐
 │  MetaMask    │ ─────────────────► │ vérifie la signature + nonce  │        │ BookingEscrow            │
 │  (clé privée │                    │ relie le wallet au compte     │        │  = SlotBooking           │
 │  du client)  │  approve +         │                               │ ◄────► │  + DepositVault          │
 │              │  createBooking ───────────────────────────────────────────► │  + CenterAccess (rôles)  │
 └──────────────┘  (signés par le    │ confirmEscrowFromTx : relit   │        │ MockTND (ERC-20 test)    │
                    client)          │ l'événement BookingCreated et │        └──────────────────────────┘
                                     │ vérifie client, centre,       │
                                     │ praticien, heure → confirme   │
                                     │ le RDV en base (MongoDB)      │
                                     └───────────────────────────────┘
```
- **Le client garde sa clé** (MetaMask) : il signe lui-même `approve`, `createBooking`, `cancelBooking`, `withdraw`.
  Le serveur ne peut ni dépenser ni annuler à sa place.
- **Le serveur** signe seulement l'administration (configuration des centres : `setDeposit`, `setTreasury`, `setStaff`)
  et les validations du staff (`markCompleted` / `markNoShow`), avec des clés dérivées d'une phrase HD gardée dans
  une variable d'environnement (`ESCROW_HD_MNEMONIC`) — seul l'index de dérivation est stocké en base.
- **Connexion par wallet** : « Sign-In With Ethereum » (EIP-4361) — message lisible avec le domaine, le réseau et un
  nonce à usage unique (anti-hameçonnage et anti-rejeu).
- **Cohérence base ↔ chaîne** : le rendez-vous reste `PENDING` 15 minutes ; il n'est confirmé que si la transaction
  contient bien l'événement `BookingCreated` correspondant. Si la page est fermée pendant MetaMask, le paiement est
  **retrouvé** par les événements de la chaîne (`recoverEscrowHold`) ; une attente non vérifiable n'est jamais libérée
  à l'aveugle.

### 1.5 Les contrats (séparation des responsabilités)
| Contrat | Rôle | Point clé |
|---|---|---|
| `CenterAccess` | 3 niveaux de droits par centre : admin (Ownable), gérant, staff | Le gérant n'est pas staff d'office |
| `EscrowHooks` | Interface interne entre réservation et argent | 4 crochets `internal` : aucun compte extérieur ne peut les appeler |
| `SlotBooking` | Créneaux et cycle de vie : `Confirmed → Cancelled / Completed / NoShow` | Ne touche jamais au jeton |
| `DepositVault` | Bloque, règle (règle des 24 h) et crédite les acomptes | Modèle **pull payment** : chacun retire son solde |
| `BookingEscrow` | Assemble les deux (héritage multiple) | Aucune logique propre |
| `MockTND` | Jeton ERC-20 de test, faucet plafonné à 1 000 TND/appel | 6 décimales |

**Règles métier** : acompte fixé par le centre (jamais par le client) et **figé à la réservation** ; annulation
≥ 24 h avant → remboursé au client, sinon → salon ; prestation validée ou absence (début + 15 min) → salon ;
chaque acompte réglé **une seule fois**.

---

## 2. Smart contracts, sécurité et tests

### 2.1 Bonnes pratiques appliquées
| Pratique | Où | Protège contre |
|---|---|---|
| **Checks → Effects → Interactions** | `createBooking`, `_lockDeposit`, `withdraw` | Réentrance, état incohérent |
| `ReentrancyGuard` (`nonReentrant`) sur toutes les écritures publiques | SlotBooking, DepositVault | Réentrance (même via un jeton hostile type ERC-777) |
| `SafeERC20` | DepositVault | Jetons qui renvoient `false` au lieu d'échouer |
| **Pull payment** (`withdraw`) au lieu d'envoyer l'argent | DepositVault | Déni de service : un wallet en échec ne bloque jamais un règlement |
| Contrôle d'accès par centre + `Ownable` | CenterAccess | Élévation de privilèges |
| Statuts définitifs + double verrou (SlotBooking ET coffre) | `_requireConfirmed`, `_takeLocked` | Double dépense / rejeu |
| Montant lu par le coffre, figé par réservation | `_depositFor`, `LockedDeposit` | Falsification du montant |
| `abi.encode` (et non `encodePacked`) pour la clé de créneau | `slotKey` | Collisions de hachage |
| Erreurs personnalisées (`error`) | partout | Messages précis, moins de gaz que des chaînes |
| Solidity ≥ 0.8 | partout | Dépassements d'entier (revert automatique) |
| Jeton `immutable`, versions figées (compilateur, OpenZeppelin) | DepositVault, package.json | Changement de jeton, dérive des dépendances |
| Aucune donnée personnelle sur la chaîne | SlotBooking | Fuite de données, RGPD |
| Invariant comptable : `solde du contrat == totalLocked + totalCredited` | DepositVault | Création ou perte de jetons |

### 2.2 Les tests (182, Hardhat + Chai)
| Fichier | Contenu |
|---|---|
| `MockTND.test.js` | Décimales, faucet, plafond, conformité ERC-20 |
| `SlotBooking.test.js` | Créneaux, statuts, droits, dates (avec un faux coffre) |
| `DepositVault.test.js` | Règle des 24 h, crédits, retraits, **réentrance** et **jeton qui renvoie false** (jetons hostiles) |
| `BookingEscrow.test.js` | Assemblage réel avec MockTND, scénarios de bout en bout |
| `FinancialScenarios.test.js` / `Accounting.test.js` | Scénarios financiers et invariant comptable |
| `AssemblyCheck.test.js` | L'ordre d'héritage et les crochets sont bien reliés |
| **`Security.test.js`** | **Tests de vulnérabilités** (voir ci-dessous) |

### 2.3 Tests de vulnérabilités (`test/Security.test.js`, 23 tests)
1. **Contrôle d'accès / élévation de privilèges** : un inconnu, un client ou le gérant d'un *autre* centre ne peut ni
   nommer un gérant, ni changer l'acompte, la trésorerie ou le staff ; seul le staff *du centre* valide ; seul le client
   annule ; un staff retiré perd aussitôt ses droits ; adresses nulles refusées.
2. **Front-running** : deux transactions sur le même créneau dans le même bloc (minage automatique coupé, l'attaquant
   paie plus de gaz) → une seule passe, **la victime ne perd pas son acompte**.
3. **Falsification de l'acompte** : `createBooking` n'a pas de paramètre montant ; une hausse de tarif après coup ne
   touche pas les réservations existantes ; acompte nul refusé.
4. **Rejeu / double dépense** : un règlement et un retrait ne se rejouent pas ; impossible de retirer le solde d'un autre.
5. **Manipulation du temps** : bornes exactes testées à la seconde (24 h pile = remboursé ; +1 s = salon ; absence
   avant début + 15 min refusée).
6. **Dépassement d'entier** : acompte de 2²⁵⁶−1 → échec propre, rien de bloqué ; identifiants maximaux sans collision.
7. **Jetons envoyés de force** (« donation ») : la comptabilité interne ne bouge pas, personne ne retire plus que son dû.
8. **Fuzzing** : 300 actions aléatoires (graine fixe, rejouable) ; **après chaque action**, l'invariant comptable et
   « Σ soldes = totalCredited » sont vérifiés.

### 2.4 Analyse statique (Slither 0.11.6, 102 détecteurs) — `docs/slither-report.txt`
- **1ʳᵉ analyse** : `reentrancy-events` (faible) — l'événement `DepositLocked` était émis *après* le transfert de jetons
  (et `Withdrawn` aussi). Sans danger (pas de changement d'état après l'appel, `nonReentrant`), mais **corrigé** :
  les événements sont émis avant l'interaction. Tests relancés : 182/182.
- **Reste** : `timestamp` (informatif). **Justification** : un validateur ne peut décaler `block.timestamp` que de
  quelques secondes ; nos fenêtres sont de 24 h, 30 min et 15 min. Au pire, une annulation à la limite exacte bascule
  d'un côté — c'est la règle publique, testée à la seconde près (§2.3-5). Il n'existe pas de source de temps plus fiable
  sur la chaîne pour un délai en heures.

### 2.5 Couverture (`npx hardhat coverage`)
| Contrat | Lignes | Fonctions | Branches |
|---|---|---|---|
| BookingEscrow, CenterAccess, EscrowHooks, MockTND | 100 % | 100 % | 100 % |
| DepositVault | 100 % | 100 % | 96,2 % |
| SlotBooking | 100 % | 100 % | 85,7 % |

---

## 3. Questions / réponses techniques (préparation)

**Q1. Pourquoi un modèle « pull payment » (withdraw) plutôt que d'envoyer directement l'argent ?**
Si le contrat envoyait les jetons pendant `cancelBooking` ou `markCompleted`, un destinataire qui échoue (contrat qui
refuse, jeton bloqué) ferait échouer toute la transaction : la réservation resterait coincée (déni de service). Avec
le pull payment, le règlement ne fait que **créditer un solde** ; chacun retire ensuite le sien.

**Q2. Comment empêchez-vous la réentrance ?**
Trois couches : (1) ordre vérifier → modifier l'état → interagir (le solde est remis à 0 avant le transfert) ;
(2) `nonReentrant` d'OpenZeppelin ; (3) test avec un jeton hostile qui rappelle `withdraw` pendant le transfert → revert
`ReentrancyGuardReentrantCall`.

**Q3. Que se passe-t-il si deux clients réservent le même créneau en même temps ?**
Les transactions sont ordonnées dans le bloc ; la première écrit `_slotOwner[clé]`, la seconde échoue avec
`SlotAlreadyBooked` et **son acompte n'est pas pris** (transaction annulée entière). Testé en front-running.

**Q4. Le client peut-il payer un acompte plus faible ?**
Non : `createBooking` n'a pas de paramètre montant ; le coffre lit l'acompte du centre (`_depositFor`).

**Q5. Le gérant peut-il augmenter l'acompte d'une réservation existante ?**
Non : le montant est **copié** dans la réservation (`LockedDeposit.amount`) au moment du blocage.

**Q6. Pourquoi `uint32` pour les identifiants et pas les ObjectId de MongoDB ?**
Pour ne mettre aucune donnée de la base sur la chaîne et économiser le stockage. Salonia attribue un numéro
(`chainId`) à chaque centre et praticien ; la correspondance reste côté serveur.

**Q7. Pourquoi `abi.encode` et pas `abi.encodePacked` pour la clé de créneau ?**
`encodePacked` colle les valeurs sans séparation : deux combinaisons différentes peuvent donner les mêmes octets
(collision). `abi.encode` remplit chaque valeur sur 32 octets : aucune ambiguïté.

**Q8. Pourquoi Solidity 0.8.24 et pas SafeMath ?**
Depuis 0.8, tout dépassement d'entier provoque un revert automatique. SafeMath est devenu inutile.

**Q9. Comment Salonia sait-elle que le paiement a vraiment eu lieu ?**
Le serveur ne fait pas confiance au navigateur : il lit le reçu de la transaction, décode l'événement `BookingCreated`
et vérifie **client, centre, praticien et heure** avant de confirmer le rendez-vous. Une même transaction ne peut
confirmer qu'un rendez-vous (index unique `réseau + chainBookingId`).

**Q10. Et si l'utilisateur ferme la page pendant MetaMask ?**
Le rendez-vous reste `PENDING` 15 minutes. Au retour ou à l'expiration, le serveur cherche les événements
`BookingCreated` du client et **reprend** la transaction ; si la chaîne est injoignable, il ne libère pas le créneau à
l'aveugle.

**Q11. Qui peut voir les réservations sur la chaîne ? Est-ce un problème de confidentialité ?**
Tout le monde voit les adresses, les identifiants numériques, les montants et les heures — mais **aucun nom ni
téléphone**. Pour aller plus loin : adresses à usage unique, ou une chaîne privée / L2 avec confidentialité.

**Q12. Pourquoi MetaMask plutôt qu'un wallet géré par le serveur ?**
Avec MetaMask, **le client garde sa clé** : le serveur ne peut ni dépenser son argent ni annuler à sa place, et le
contrôle « seul le client annule » a un sens. L'administration et le staff utilisent des clés serveur dérivées (HD)
pour ne pas imposer MetaMask au personnel.

**Q13. Comment se connecte-t-on avec le wallet ?**
SIWE (EIP-4361) : le client signe un message lisible (domaine, réseau, nonce unique, date). Le serveur vérifie la
signature, le domaine (anti-hameçonnage), la fraîcheur et consomme le nonce (anti-rejeu). Aucune clé ne transite.

**Q14. Que coûte une réservation en gaz ?** (mesuré : `npx hardhat run scripts/gas.js`)
| Opération | Gaz |
|---|---|
| `approve` (client) | 46 347 |
| `createBooking` (client) — écrit la réservation, le créneau et l'acompte (≈ 6 emplacements de stockage neufs à 20 000 gaz chacun) + transfert | 270 066 |
| `cancelBooking` ≥ 24 h (client) | 96 208 |
| `markCompleted` (staff) | 94 365 |
| `withdraw` | 43 981 à 57 661 |
| Déploiement de `BookingEscrow` | 1 563 804 |

Sur Ethereum (10 gwei), `createBooking` coûterait ~0,0027 ETH ; sur un L2 (Base, Arbitrum, Polygon), quelques
centimes. Pistes d'optimisation : regrouper `client`, `centerId`, `practitionerId`, `startTime` et `status` dans un
seul emplacement de stockage, ne pas dupliquer la fiche de réservation dans le coffre, `permit` (EIP-2612) pour
supprimer l'`approve`.

**Q15. Le `block.timestamp` peut être manipulé. Est-ce un risque ?**
De quelques secondes seulement. Nos délais sont de 24 h / 30 min / 15 min ; les bornes sont publiques et testées à la
seconde. Slither le signale à titre informatif ; c'est la seule source de temps disponible sur la chaîne.

**Q16. Que se passe-t-il si quelqu'un envoie des jetons directement au contrat ?**
Ils restent bloqués (aucune fonction de récupération, volontairement : pas de porte dérobée), mais la comptabilité ne
change pas et personne ne peut en profiter. Testé (« donation »).

**Q17. L'administrateur peut-il voler les acomptes ?**
Non. Il n'a aucune fonction pour déplacer les fonds ; `withdraw` ne retire que le solde de l'appelant. Il peut nommer
les gérants, qui fixent la trésorerie *de leur centre* : c'est le point de confiance restant (voir limites).

**Q18. Pourquoi des erreurs personnalisées (`error`) plutôt que `require("message")` ?**
Moins de gaz (pas de chaîne stockée), paramètres utiles (ex. `SlotAlreadyBooked(bookingId)`) que l'application traduit
en message clair.

**Q19. Pourquoi l'héritage multiple, et dans quel ordre ?**
`SlotBooking` et `DepositVault` héritent tous deux de `EscrowHooks, CenterAccess, ReentrancyGuard` **dans le même
ordre** : la linéarisation C3 de Solidity exige un ordre cohérent pour que `BookingEscrow` hérite des deux. Un test
(`AssemblyCheck`) vérifie que les crochets sont bien reliés.

**Q20. Comment testez-vous les délais (24 h, 15 min) sans attendre ?**
`time.increaseTo` et `time.setNextBlockTimestamp` (Hardhat Network Helpers) avancent l'horloge de la chaîne locale.

**Q21. Pourquoi « Nonce too high » dans MetaMask après un redémarrage ?**
Hardhat repart de zéro (nonce 0) mais MetaMask se souvient des transactions déjà envoyées par ce compte. On efface
l'activité du compte dans MetaMask ; l'application affiche ce conseil automatiquement.

### Limites et améliorations (à proposer spontanément)
| Limite | Amélioration |
|---|---|
| Pas d'annulation **par le salon** (seul le client annule) | `cancelBySalon` qui rembourse toujours le client |
| Le contrat bloque l'heure de début exacte, pas les **chevauchements** (prestation de 60 min) | Durée dans la réservation ou blocage de plusieurs créneaux ; aujourd'hui la base Salonia arbitre |
| Contrat **non évolutif** (pas de proxy) | Proxy UUPS + timelock — mais cela réintroduit de la confiance envers l'admin |
| Point de confiance : l'admin nomme les gérants, qui choisissent la trésorerie | Multisig (Safe) pour l'admin, délai avant changement de trésorerie |
| Jetons envoyés par erreur bloqués | Fonction de récupération réservée aux jetons **autres** que le jeton des acomptes |
| Jeton de test, réseau de test | Stablecoin réglementé, audit externe, L2 pour réduire les frais |
| Deux signatures côté client (`approve` + `createBooking`) | `permit` (EIP-2612) : une seule signature |
| Pas d'oracle de prix | Inutile tant que l'acompte est en jeton indexé sur le dinar |

---

## 4. Utilisation de l'IA générative

### 4.1 Comment nous l'avons utilisée
- **Assistant de code (Claude)** pour : proposer la structure des contrats à partir du cahier des charges, écrire des
  tests (dont la suite de vulnérabilités et le fuzzing), expliquer des erreurs, rédiger la documentation.
- **Gemini** dans l'application : chatbot de réservation et assistant financier (hors périmètre blockchain).
- **Règle suivie** : l'IA propose, nous vérifions — chaque proposition est relue, compilée, **testée**, et passée à
  Slither. Rien n'est gardé sans test qui le prouve.

### 4.2 Erreurs de l'IA détectées et corrigées (exemples concrets)
| Proposition / situation | Problème détecté | Comment on l'a vu | Correction |
|---|---|---|---|
| Événements émis après `safeTransferFrom` / `safeTransfer` | Ordre CEI imparfait | **Slither** (`reentrancy-events`) | Événements avant l'interaction ; 182 tests relancés |
| Estimation du gaz de `createBooking` : « 150 000 à 200 000 » | Sous-estimée | **Mesure** (`scripts/gas.js`) : 270 066 | Chiffre mesuré dans le dossier, avec l'explication (stockage neuf à 20 000 gaz) |
| Test de « détournement de trésorerie » qui avançait le temps de 48 h | Le créneau aligné était quelques minutes plus tard → `TooEarly` | Le test échouait | `time.increaseTo(start)` : c'était le test, pas le contrat |
| Littéraux `0n` (BigInt) dans le code TypeScript de Salonia | Refusés par la cible de compilation | Erreur de build | `BigInt(0)` |
| Après redémarrage de Hardhat, réservation bloquée « déjà réservée sur la blockchain » | Les numéros de réservation repartent de 1 et entrent en conflit avec l'index unique | Reproduction pas à pas | Détachement automatique des acomptes de l'ancienne chaîne au redéploiement |
| Rendez-vous libéré à l'expiration alors que le paiement avait eu lieu | Page fermée pendant MetaMask | Scénario de test manuel | Reprise par les événements de la chaîne (`recoverEscrowHold`) + test |
| Erreur MetaMask « Nonce too high » | Ce n'est pas un bug du contrat | Lecture de l'erreur | Message clair dans l'application + procédure de démo |

### 4.3 Ce que nous maîtrisons sans l'IA
Nous savons expliquer chaque fonction, chaque modificateur et chaque test de ce dossier (voir §3). Les choix
structurants (pull payment, montant fixé par le centre, aucune donnée personnelle sur la chaîne, MetaMask pour le
client) ont été **décidés et justifiés par l'équipe** (`docs/DECISIONS.md`), l'IA ayant servi à les implémenter et à
les tester.
