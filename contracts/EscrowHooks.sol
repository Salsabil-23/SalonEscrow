// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title EscrowHooks — interface entre SlotBooking (Membre 1) et DepositVault (Membre 2). Fichier PARTAGÉ.
/// @notice SlotBooking ne manipule jamais d'argent : il appelle ces quatre fonctions, que DepositVault implémente.
///         Chaque membre peut ainsi tester son fichier seul, avec un faux de l'autre côté.
/// @dev    Version v0.1 proposée par le Membre 2 — À FIGER AVEC LE MEMBRE 1 (cahier §11 : toute modification se décide à deux).
///         Ce sont des fonctions `internal` : une `interface` Solidity ne peut pas en déclarer, d'où un contrat abstrait.
///
///         Contrat d'utilisation attendu de SlotBooking (ordre « vérifier → modifier l'état → transférer ») :
///           createBooking : vérifier l'heure et le créneau → enregistrer la réservation (statut Confirmed)
///                           → `_lockDeposit` (prend l'acompte au client).
///           cancelBooking : vérifier client + avant le début → statut Cancelled → `_settleCancelled`.
///           markCompleted / markNoShow : vérifier staff + délai → statut Completed / NoShow → `_settleToSalon`.
///         Le coffre se protège aussi de lui-même : un acompte inconnu ou déjà réglé est refusé (défense en profondeur).
abstract contract EscrowHooks {
    /// @notice Acompte actuellement exigé par le centre, en plus petite unité du jeton (6 décimales).
    /// @dev    Revert `CenterNotConfigured` si le centre n'a pas d'acompte ou pas de trésorerie.
    function _depositFor(uint32 centerId) internal view virtual returns (uint256);

    /// @notice Bloque l'acompte du centre pour la réservation `bookingId`, payé par `client` (qui a fait `approve` avant).
    /// @dev    Le MONTANT est lu par le coffre dans la configuration du centre : l'appelant ne le choisit pas.
    ///         Il est figé pour cette réservation : un changement de tarif ultérieur ne la touche pas.
    /// @return amount Montant bloqué (à recopier dans la réservation pour `getBooking`).
    function _lockDeposit(uint256 bookingId, uint32 centerId, address client) internal virtual returns (uint256 amount);

    /// @notice Règle l'acompte d'une réservation annulée : remboursé au client si l'annulation a lieu
    ///         au moins 24 heures avant `startTime` (limite incluse), sinon crédité au salon.
    /// @return refunded true si le client est remboursé (pour l'événement BookingCancelled).
    function _settleCancelled(uint256 bookingId, uint64 startTime) internal virtual returns (bool refunded);

    /// @notice Crédite l'acompte à la trésorerie du centre (prestation validée ou client absent).
    function _settleToSalon(uint256 bookingId) internal virtual;
}
