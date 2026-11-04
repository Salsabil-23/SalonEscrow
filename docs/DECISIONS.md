# Décisions et points ouverts — SalonEscrow

Statuts : **Décidé** (validé par Salsabil, Membre 2) · **Proposé** (choix par défaut appliqué, à confirmer avec le Membre 1
ou l'encadrement) · **Ouvert** (non tranché, rien n'est codé qui en dépende).

## D1 — Point de départ : **Décidé**
Aucun dépôt de départ n'existe (pas de `.sol`, pas de projet Hardhat, rien dans l'historique Git de Salonia).
Le projet est écrit à partir de zéro dans `SalonEscrow/`, séparé de Salonia. Salonia n'est **que lu**.

## D2 — Wallets : un wallet custodial par utilisateur — **Décidé**
Problème : `createBooking`, `cancelBooking` et `withdraw` reposent sur `msg.sender`. Avec un seul wallet serveur,
tous les clients auraient la même adresse, tous les remboursements tomberaient dans un même solde et les contrôles
« seul le client annule sa réservation » ne protégeraient plus rien.

Choix : le serveur Next.js dérive **une adresse par utilisateur Salonia** (client, staff, gérant) et **une par trésorerie
de centre**, à partir d'une phrase HD gardée dans une variable d'environnement serveur (`ESCROW_HD_MNEMONIC`).
Seul l'**index de dérivation** est stocké en base, jamais la clé. Le serveur ne signe pour un wallet qu'après
`requireRole` + contrôle du périmètre (organisation, centre, propriétaire de la donnée).
Conséquences : chaque wallet a besoin d'un peu d'ETH de test pour le gaz (un wallet « financeur » l'alimente) ;
clés custodiales ⇒ **testnet uniquement**. Le contrat n'est pas modifié.

## D3 — Interface `EscrowHooks` v0.1 — **Proposé** (à figer avec le Membre 1, cahier §11)
Comme rien n'existe, le Membre 2 propose une première version (`contracts/EscrowHooks.sol`). Toute modification se décide à deux.

```solidity
function _depositFor(uint32 centerId) internal view returns (uint256);
function _lockDeposit(uint256 bookingId, uint32 centerId, address client) internal returns (uint256 amount);
function _settleCancelled(uint256 bookingId, uint64 startTime) internal returns (bool refunded);
function _settleToSalon(uint256 bookingId) internal;
```

- La **politique de 24 h** vit dans `DepositVault` (`_settleCancelled`), comme le prévoit le cahier §6.
- **Le coffre garde sa propre fiche par réservation** (client, centre, montant, statut). Conséquences :
  - le montant est lu par le coffre dans la configuration du centre : ni le client ni `SlotBooking` ne le choisissent
    (règle « acompte fixé par le centre ») ; `_lockDeposit` le renvoie pour que `SlotBooking` le recopie dans `Booking.deposit` ;
  - les règlements n'ont besoin que de `bookingId` (et de l'heure de début pour la règle des 24 h) : un appel avec un
    mauvais client ou un mauvais montant est impossible ;
  - **défense en profondeur** : le coffre refuse de bloquer deux fois ou de régler deux fois le même acompte
    (`DepositAlreadyLocked`, `DepositNotLocked`), même si `SlotBooking` avait un bug sur les statuts.
- Ordre attendu côté `SlotBooking` : vérifier → écrire la réservation / changer le statut → appeler le crochet.
- `SlotBooking` garde l'erreur `InvalidStatus` du cahier pour ses propres statuts ; les erreurs du coffre ne servent que de filet.

Changement par rapport à v0 (proposée à l'étape 1) : `amount`, `client` et `centerId` ne sont plus passés aux règlements,
puisque le coffre les connaît.

### Événements ajoutés par le coffre — **Proposé**
En plus de `Withdrawn`, `DepositSet` et `TreasurySet` du cahier : `DepositLocked(bookingId, centerId, client, amount)` et
`DepositCredited(bookingId, beneficiary, amount, refunded)`. Ils permettent au tableau de bord des paiements d'afficher
l'historique d'un bénéficiaire sans indexeur. Erreurs ajoutées : `InvalidDepositAmount`, `DepositAlreadyLocked`, `DepositNotLocked`.

## D4 — Rôles sur la chaîne — **Proposé**
- Administrateur (propriétaire `Ownable` du contrat) = wallet de déploiement de la plateforme (SUPER_ADMIN).
- Gérant d'un centre (un seul par centre, cahier §6) = wallet du MANAGER Salonia du centre s'il existe, sinon celui de
  l'OWNER. Le gérant n'est pas staff par défaut (cahier §3).
- Staff = wallet de chaque STAFF affecté au centre, nommé par `setStaff`.

## Points ouverts (rien n'est codé qui en dépende)
| # | Sujet | Constat | Proposition | Qui tranche |
|---|---|---|---|---|
| O1 | Identifiants | La chaîne attend `uint32 centerId / practitionerId` ; Salonia utilise des ObjectId | Champ numérique dédié sur `Center` et `User` (STAFF) | Membre 4 (schéma) + Membre 1 |
| O2 | Montant de l'acompte | Salonia : 30 % du prix, payé par carte ; cahier escrow : montant fixe par centre | Pour une réservation escrow, l'acompte fixe on-chain remplace l'acompte en pourcentage ; Salonia le reflète dans son registre | Membre 2 + encadrement |
| O3 | Annulation par le salon | Le contrat ne laisse annuler que le client ; un salon qui annule n'a aucune voie de remboursement | Fonction `cancelBySalon` (staff/gérant) qui rembourse toujours | Membre 1 + Membre 2 |
| O4 | Pas des créneaux | Salonia : pas de 15 min ; contrat : alignement 30 min | Seuls les créneaux alignés sur 30 min passent par l'escrow | Membre 1 / Module 3 |
| O5 | Règles d'annulation | Salonia : annulation en ligne jusqu'à 2 h ; contrat : jusqu'au début, remboursement si ≥ 24 h | Afficher les deux règles avant confirmation | Membre 1 / Module 3 |
| O6 | Chevauchements | Le contrat ne bloque que la même heure de début exacte ; une prestation de 60 min peut chevaucher la suivante | La base Salonia reste l'autorité sur les chevauchements | Membre 1 |
| O7 | Changement de trésorerie | Un acompte déjà bloqué est crédité à la trésorerie en vigueur au règlement | Assumé par le cahier §9 ; testé et documenté | — |
| O8 | Intégration dans Salonia | Ajouter viem et des champs de schéma touche l'architecture (CLAUDE.md de Salonia) | Module d'intégration développé et testé dans `SalonEscrow/integration/`, copié dans Salonia seulement après accord | Encadrement |

## Environnement
- Node 24 n'est pas officiellement supporté par Hardhat 2 (avertissement possible). Si un problème apparaît : Node 22 LTS.
- `npm install` signale des vulnérabilités dans des dépendances **de développement** transitives de Hardhat 2
  (outils locaux, jamais déployés). `npm audit fix --force` n'est pas lancé : il casserait les versions figées.
