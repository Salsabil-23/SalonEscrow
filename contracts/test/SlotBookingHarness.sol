// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CenterAccess} from "../CenterAccess.sol";
import {SlotBooking} from "../SlotBooking.sol";

/// @title SlotBookingHarness — FAUX coffre, pour tester SlotBooking seul (cahier §11). TEST UNIQUEMENT.
/// @notice Remplace DepositVault : aucun jeton, seulement une comptabilité qui enregistre les appels aux crochets.
///         Permet de vérifier que SlotBooking délègue chaque règlement une seule fois, sans s'appuyer
///         sur les protections propres du coffre (DepositAlreadyLocked / DepositNotLocked).
/// @dev    Même règle des 24 h que DepositVault, recopiée pour que les tests de SlotBooking restent lisibles.
contract SlotBookingHarness is SlotBooking {
    error CenterNotConfigured(uint32 centerId);
    error LockFailed();

    mapping(uint32 centerId => uint256 amount) public depositOf;
    mapping(uint256 bookingId => uint256 amount) public lockedOf;
    uint256 public totalLocked;
    uint256 public lockCalls;
    uint256 public cancelSettlements;
    uint256 public salonSettlements;
    uint256 public refundedTotal;
    uint256 public salonTotal;
    bool public failNextLock;

    constructor(address admin) CenterAccess(admin) {}

    function setDeposit(uint32 centerId, uint256 amount) external onlyCenterAdmin(centerId) {
        depositOf[centerId] = amount;
    }

    /// @dev Simule un client qui n'a pas approuvé le jeton ou dont le solde est insuffisant.
    function setFailNextLock(bool fail) external {
        failNextLock = fail;
    }

    function _depositFor(uint32 centerId) internal view override returns (uint256 amount) {
        amount = depositOf[centerId];
        if (amount == 0) revert CenterNotConfigured(centerId);
    }

    function _lockDeposit(uint256 bookingId, uint32 centerId, address) internal override returns (uint256 amount) {
        if (failNextLock) revert LockFailed();
        amount = _depositFor(centerId);
        lockCalls++;
        lockedOf[bookingId] = amount;
        totalLocked += amount;
    }

    function _settleCancelled(uint256 bookingId, uint64 startTime) internal override returns (bool refunded) {
        cancelSettlements++;
        uint256 amount = _release(bookingId);
        refunded = block.timestamp + 24 hours <= startTime;
        if (refunded) refundedTotal += amount;
        else salonTotal += amount;
    }

    function _settleToSalon(uint256 bookingId) internal override {
        salonSettlements++;
        salonTotal += _release(bookingId);
    }

    function _release(uint256 bookingId) private returns (uint256 amount) {
        amount = lockedOf[bookingId];
        lockedOf[bookingId] = 0;
        totalLocked -= amount;
    }
}
