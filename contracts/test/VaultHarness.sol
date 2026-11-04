// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CenterAccess} from "../CenterAccess.sol";
import {DepositVault} from "../DepositVault.sol";

/// @title VaultHarness — FAUX SlotBooking, pour tester DepositVault seul (cahier §11). TEST UNIQUEMENT.
/// @notice Expose les crochets internes du coffre comme des fonctions publiques, SANS les contrôles de SlotBooking
///         (heure, créneau, statut, droits du client ou du staff). Ne jamais déployer ailleurs qu'en test :
///         n'importe qui pourrait y régler n'importe quel acompte.
contract VaultHarness is DepositVault {
    constructor(address admin, IERC20 token_) CenterAccess(admin) DepositVault(token_) {}

    /// @dev Imite createBooking : le client est toujours l'appelant.
    function book(uint256 bookingId, uint32 centerId) external nonReentrant returns (uint256) {
        return _lockDeposit(bookingId, centerId, msg.sender);
    }

    /// @dev Imite cancelBooking (sans vérifier le client ni l'heure de début).
    function cancel(uint256 bookingId, uint64 startTime) external nonReentrant returns (bool) {
        return _settleCancelled(bookingId, startTime);
    }

    /// @dev Imite markCompleted / markNoShow (sans vérifier le staff ni le délai).
    function settleToSalon(uint256 bookingId) external nonReentrant {
        _settleToSalon(bookingId);
    }

    function depositFor(uint32 centerId) external view returns (uint256) {
        return _depositFor(centerId);
    }
}
