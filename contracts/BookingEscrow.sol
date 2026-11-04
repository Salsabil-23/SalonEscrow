// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CenterAccess} from "./CenterAccess.sol";
import {DepositVault} from "./DepositVault.sol";
import {SlotBooking} from "./SlotBooking.sol";

/// @title BookingEscrow — contrat déployé de SalonEscrow (assemblage commun, cahier §6)
/// @notice Réservations (SlotBooking, Membre 1) + acomptes (DepositVault, Membre 2), reliés uniquement
///         par les quatre crochets d'EscrowHooks. Aucune logique propre : tout vient des deux parents.
contract BookingEscrow is SlotBooking, DepositVault {
    /// @param admin Administrateur de la plateforme (propriétaire Ownable).
    /// @param token_ Jeton des acomptes (MockTND, 6 décimales).
    constructor(address admin, IERC20 token_) CenterAccess(admin) DepositVault(token_) {}
}
