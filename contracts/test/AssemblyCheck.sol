// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CenterAccess} from "../CenterAccess.sol";
import {EscrowHooks} from "../EscrowHooks.sol";
import {DepositVault} from "../DepositVault.sol";

/// @title Vérification d'assemblage — TEST UNIQUEMENT, ce n'est PAS le SlotBooking du Membre 1.
/// @notice Prouve que la forme d'héritage prévue par le cahier §6 compile avec DepositVault :
///         BookingEscrow is SlotBooking, DepositVault — les deux héritant d'EscrowHooks, CenterAccess et ReentrancyGuard.
///         SlotBookingShape n'a que la forme minimale (appels des quatre crochets) ; le vrai SlotBooking reste au Membre 1.
abstract contract SlotBookingShape is EscrowHooks, CenterAccess, ReentrancyGuard {
    function _shapeCreate(uint256 id, uint32 centerId) internal returns (uint256) {
        _depositFor(centerId);
        return _lockDeposit(id, centerId, msg.sender);
    }

    function _shapeCancel(uint256 id, uint64 startTime) internal returns (bool) {
        return _settleCancelled(id, startTime);
    }

    function _shapeComplete(uint256 id, uint32 centerId) internal onlyCenterStaff(centerId) {
        _settleToSalon(id);
    }
}

contract BookingEscrowShape is SlotBookingShape, DepositVault {
    constructor(address admin, IERC20 token_) CenterAccess(admin) DepositVault(token_) {}

    function create(uint256 id, uint32 centerId) external nonReentrant returns (uint256) {
        return _shapeCreate(id, centerId);
    }

    function cancel(uint256 id, uint64 startTime) external nonReentrant returns (bool) {
        return _shapeCancel(id, startTime);
    }

    function complete(uint256 id, uint32 centerId) external nonReentrant {
        _shapeComplete(id, centerId);
    }
}
