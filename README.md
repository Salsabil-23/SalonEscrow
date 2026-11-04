# SalonEscrow — acompte de rendez-vous sécurisé par smart contract

Mini-projet blockchain intégré à **Salonia** (PWA de gestion de salons). Le client bloque un acompte en jeton de test
(**MockTND**) ; le contrat le rembourse ou le verse au salon selon une règle fixée à l'avance, et chaque bénéficiaire
retire son solde lui-même.

> ⚠️ **Testnet uniquement.** MockTND n'a aucune valeur et n'importe qui peut en créer. Ne jamais déployer sur un réseau principal.

Solidity 0.8.24 (EVM `paris`) · OpenZeppelin 5.0.2 · Hardhat 2 · ethers v6 pour les tests · viem côté Next.js (à venir)

## Règles métier appliquées par le coffre

| Situation | Acompte |
|---|---|
| Annulation **24 h ou plus** avant le début (24 h pile incluse) | Rendu au client |
| Annulation moins de 24 h avant | Crédité au salon |
| Client absent (staff, 15 min après le début) | Crédité au salon |
| Prestation validée (staff, à partir du début) | Crédité au salon |

- L'acompte est fixé **par le centre** (`setDeposit`) et figé à la réservation : un changement de tarif ne touche pas les réservations existantes.
- Chaque acompte est réglé **une seule fois**.
- Le contrat ne fait que **créditer un solde** ; chacun retire le sien avec `withdraw()` (solde remis à zéro avant le transfert).
- 6 décimales : **30 TND = 30 000 000** unités.

## Répartition et état

| Fichier | Responsable | État |
|---|---|---|
| `contracts/MockTND.sol` | Membre 2 | ✅ Fait, testé |
| `contracts/DepositVault.sol` | Membre 2 | ✅ Fait, testé (100 % des lignes) |
| `contracts/EscrowHooks.sol` | Partagé | ⏳ v0.1 **proposée par le Membre 2, à figer avec le Membre 1** |
| `contracts/CenterAccess.sol` | Partagé | ⏳ v0 proposée, à relire avec le Membre 1 |
| `contracts/SlotBooking.sol` | Membre 1 | ⏳ En cours (Membre 1) |
| `contracts/BookingEscrow.sol` | Partagé | ❌ À assembler quand SlotBooking existe |
| Tableau de bord des paiements Salonia | Membre 2 | ❌ À faire (semaine 2) |
| Scripts de déploiement testnet, fichier d'adresses | Membre 2 | ❌ À faire (semaine 2) |

Décisions prises et points ouverts : [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Structure

```
contracts/
  MockTND.sol           jeton ERC-20 de test, 6 décimales, faucet ≤ 1 000 TND par appel
  CenterAccess.sol      rôles : administrateur (Ownable), gérant et staff par centre
  EscrowHooks.sol       interface entre SlotBooking et DepositVault (4 fonctions internes)
  DepositVault.sol      acomptes, règle des 24 h, soldes, withdraw, setDeposit, setTreasury
  test/                 contrats de TEST uniquement, jamais déployés :
    VaultHarness.sol      faux SlotBooking pour tester le coffre seul
    AssemblyCheck.sol     forme d'héritage de BookingEscrow (≠ SlotBooking du Membre 1)
    MaliciousTokens.sol   jetons hostiles (réentrance, retour false)
    SafeERC20Probe.sol    compatibilité SafeERC20 de MockTND
test/
  MockTND.test.js               jeton
  DepositVault.test.js          coffre, fonction par fonction
  FinancialScenarios.test.js    scénarios de bout en bout (24 h, 23:59:59, retraits, double règlement…)
  Accounting.test.js            cohérence comptable, cas limites, séquence aléatoire de 200 opérations
  AssemblyCheck.test.js         le coffre fonctionne à travers l'héritage multiple
docs/DECISIONS.md               décisions et points ouverts
```

## Installation et tests

Node.js 18+ (testé avec Node 24.18 et npm 11.16).

```bash
npm install
npm run compile
npm test            # tous les tests
npm run coverage    # couverture (dossier coverage/)
```

Aucun secret n'est nécessaire pour compiler et tester. La configuration Sepolia (`hardhat.config.js`) n'est activée que si
`SEPOLIA_RPC_URL` et `DEPLOYER_PRIVATE_KEY` sont définies dans un fichier `.env` (jamais commité).

## Intégration avec le Membre 1 (SlotBooking)

`SlotBooking` hérite d'`EscrowHooks`, `CenterAccess` et `ReentrancyGuard`, et n'appelle que ces quatre fonctions :

```solidity
function _depositFor(uint32 centerId) internal view returns (uint256);                       // revert CenterNotConfigured
function _lockDeposit(uint256 bookingId, uint32 centerId, address client) internal returns (uint256 amount);
function _settleCancelled(uint256 bookingId, uint64 startTime) internal returns (bool refunded);
function _settleToSalon(uint256 bookingId) internal;
```

Ce que SlotBooking doit faire :
1. **Ordre** : vérifier → enregistrer la réservation ou changer son statut → appeler le crochet.
2. `createBooking` : recopier dans `Booking.deposit` le montant **renvoyé** par `_lockDeposit` (le client ne le choisit jamais).
3. `cancelBooking` : passer `startTime` à `_settleCancelled` ; l'indicateur `refunded` alimente l'événement `BookingCancelled`.
4. `markCompleted` / `markNoShow` : modificateur `onlyCenterStaff(centerId)` de `CenterAccess`, puis `_settleToSalon`.
5. `nonReentrant` sur `createBooking`, `cancelBooking`, `markCompleted`, `markNoShow` (le coffre le met déjà sur `withdraw`).
6. Contrôles de date (début dans le futur, aligné sur 30 min, absence ≥ 15 min, validation ≥ début, annulation < début) : côté SlotBooking.

Le coffre refuse de lui-même un acompte bloqué deux fois (`DepositAlreadyLocked`) ou réglé deux fois (`DepositNotLocked`) ;
SlotBooking garde l'erreur `InvalidStatus` du cahier pour ses propres statuts.

Assemblage final : `contract BookingEscrow is SlotBooking, DepositVault`, constructeur
`CenterAccess(admin) DepositVault(token)`. Cette forme compile et fonctionne (`test/AssemblyCheck.test.js`).

## Sécurité

- SafeERC20, ReentrancyGuard, ordre vérifier → modifier → transférer, erreurs personnalisées, adresse nulle refusée.
- Aucune donnée personnelle sur la chaîne : uniquement des identifiants numériques, des montants, des heures et des statuts.
- Clés uniquement dans des variables d'environnement ; `.env` est exclu par `.gitignore`.
- `npm install` signale des vulnérabilités dans des dépendances **de développement** de Hardhat 2 (outils locaux, jamais déployés).
