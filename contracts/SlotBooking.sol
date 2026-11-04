// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CenterAccess} from "./CenterAccess.sol";
import {EscrowHooks} from "./EscrowHooks.sol";

/// @title SlotBooking — créneaux, statuts et cycle de vie d'une réservation (Membre 1, Module 3)
/// @notice Un créneau (centre, praticien, heure de début) ne peut être réservé qu'une fois ;
///         il est libéré à l'annulation. Chaque réservation est réglée une seule fois :
///         tout statut autre que Confirmed est définitif.
/// @dev    Ce contrat ne touche jamais au jeton : l'argent passe par les crochets d'EscrowHooks (v0.1),
///         implémentés par DepositVault (Membre 2). Aucune donnée personnelle n'est stockée :
///         centerId et practitionerId sont des identifiants numériques gardés par Salonia.
///         Même ordre d'héritage que DepositVault (EscrowHooks, CenterAccess, ReentrancyGuard) :
///         indispensable pour que BookingEscrow puisse hériter des deux.
abstract contract SlotBooking is EscrowHooks, CenterAccess, ReentrancyGuard {
    /// @notice Durée d'un créneau : les heures de début sont alignées sur 30 minutes.
    uint256 public constant SLOT_DURATION = 30 minutes;
    /// @notice Délai après le début avant de pouvoir marquer une absence.
    uint256 public constant NO_SHOW_DELAY = 15 minutes;

    enum BookingStatus {
        None, // 0 : réservation inexistante
        Confirmed, // 1 : acompte bloqué, créneau pris
        Cancelled, // 2 : annulée par le client (définitif)
        Completed, // 3 : prestation validée par le staff (définitif)
        NoShow // 4 : client absent (définitif)
    }

    struct Booking {
        address client; // wallet qui a réservé (géré par le serveur Salonia)
        uint32 centerId;
        uint32 practitionerId;
        uint64 startTime; // horodatage Unix, aligné sur 30 minutes
        uint256 deposit; // acompte figé à la réservation (un changement de tarif ne le modifie pas)
        BookingStatus status;
    }

    // CenterNotConfigured n'est pas déclarée ici : elle appartient à DepositVault, qui la lève dans _depositFor.
    error InvalidStartTime(uint64 startTime);
    error SlotAlreadyBooked(uint256 bookingId);
    error BookingNotFound(uint256 bookingId);
    error NotBookingClient(uint256 bookingId, address account);
    error InvalidStatus(uint256 bookingId, BookingStatus status);
    error BookingAlreadyStarted(uint256 bookingId);
    error TooEarly(uint256 bookingId, uint256 allowedFrom);

    event BookingCreated(
        uint256 indexed bookingId,
        address indexed client,
        uint32 indexed centerId,
        uint32 practitionerId,
        uint64 startTime,
        uint256 deposit
    );
    event BookingCancelled(uint256 indexed bookingId, address indexed client, bool refunded);
    event BookingCompleted(uint256 indexed bookingId, address indexed staff);
    event BookingNoShow(uint256 indexed bookingId, address indexed staff);

    /// @notice Nombre de réservations créées ; les identifiants commencent à 1.
    uint256 public bookingCount;

    mapping(uint256 bookingId => Booking) private _bookings;
    /// @dev Clé du créneau => réservation qui l'occupe (0 = libre).
    mapping(bytes32 slotKey => uint256 bookingId) private _slotOwner;

    // ─────────────────────────────── Écritures ───────────────────────────────

    /// @notice Réserve un créneau et bloque l'acompte du centre.
    /// @dev    Le client (msg.sender) doit avoir approuvé le jeton pour l'acompte du centre.
    ///         Ordre : vérifier, enregistrer la réservation, puis prendre l'acompte. Le montant enregistré
    ///         vient de _depositFor (lu par le coffre, revert CenterNotConfigured) ; _lockDeposit relit la même
    ///         configuration dans la même transaction et renvoie donc ce même montant.
    function createBooking(uint32 centerId, uint32 practitionerId, uint64 startTime)
        external
        nonReentrant
        returns (uint256 bookingId)
    {
        if (startTime <= block.timestamp || startTime % SLOT_DURATION != 0) revert InvalidStartTime(startTime);

        bytes32 key = slotKey(centerId, practitionerId, startTime);
        uint256 occupant = _slotOwner[key];
        if (occupant != 0) revert SlotAlreadyBooked(occupant);

        // Le montant vient du centre, jamais du client.
        uint256 deposit = _depositFor(centerId);

        bookingId = ++bookingCount;
        _bookings[bookingId] = Booking({
            client: msg.sender,
            centerId: centerId,
            practitionerId: practitionerId,
            startTime: startTime,
            deposit: deposit,
            status: BookingStatus.Confirmed
        });
        _slotOwner[key] = bookingId;
        emit BookingCreated(bookingId, msg.sender, centerId, practitionerId, startTime, deposit);

        // Interaction en dernier : si le transfert échoue (pas d'approve, solde insuffisant),
        // toute la transaction est annulée et le créneau reste libre.
        _lockDeposit(bookingId, centerId, msg.sender);
    }

    /// @notice Annulation par le client, avant le début seulement. Libère le créneau ;
    ///         DepositVault rembourse (>= 24 h avant) ou crédite le salon (< 24 h).
    function cancelBooking(uint256 bookingId) external nonReentrant {
        Booking storage booking = _existingBooking(bookingId);
        if (booking.client != msg.sender) revert NotBookingClient(bookingId, msg.sender);
        _requireConfirmed(bookingId, booking);
        if (block.timestamp >= booking.startTime) revert BookingAlreadyStarted(bookingId);

        booking.status = BookingStatus.Cancelled;
        delete _slotOwner[slotKey(booking.centerId, booking.practitionerId, booking.startTime)];

        bool refunded = _settleCancelled(bookingId, booking.startTime);
        emit BookingCancelled(bookingId, booking.client, refunded);
    }

    /// @notice Prestation validée par le staff du centre, à partir de l'heure de début.
    function markCompleted(uint256 bookingId) external nonReentrant {
        Booking storage booking = _existingBooking(bookingId);
        _requireCenterStaff(booking.centerId);
        _requireConfirmed(bookingId, booking);
        if (block.timestamp < booking.startTime) revert TooEarly(bookingId, booking.startTime);

        booking.status = BookingStatus.Completed;
        _settleToSalon(bookingId);
        emit BookingCompleted(bookingId, msg.sender);
    }

    /// @notice Absence du client, marquée par le staff du centre 15 minutes après le début.
    function markNoShow(uint256 bookingId) external nonReentrant {
        Booking storage booking = _existingBooking(bookingId);
        _requireCenterStaff(booking.centerId);
        _requireConfirmed(bookingId, booking);
        uint256 allowedFrom = uint256(booking.startTime) + NO_SHOW_DELAY;
        if (block.timestamp < allowedFrom) revert TooEarly(bookingId, allowedFrom);

        booking.status = BookingStatus.NoShow;
        _settleToSalon(bookingId);
        emit BookingNoShow(bookingId, msg.sender);
    }

    // ─────────────────────────────── Lectures ────────────────────────────────

    /// @notice Réservation complète ; status None si l'identifiant n'existe pas.
    function getBooking(uint256 bookingId) external view returns (Booking memory) {
        return _bookings[bookingId];
    }

    function isSlotFree(uint32 centerId, uint32 practitionerId, uint64 startTime) external view returns (bool) {
        return _slotOwner[slotKey(centerId, practitionerId, startTime)] == 0;
    }

    /// @notice Réservation qui occupe un créneau (0 = libre).
    function bookingAtSlot(uint32 centerId, uint32 practitionerId, uint64 startTime) external view returns (uint256) {
        return _slotOwner[slotKey(centerId, practitionerId, startTime)];
    }

    /// @notice Clé unique d'un créneau. abi.encode (et non encodePacked) : aucune collision possible.
    function slotKey(uint32 centerId, uint32 practitionerId, uint64 startTime) public pure returns (bytes32) {
        return keccak256(abi.encode(centerId, practitionerId, startTime));
    }

    // ─────────────────────────────── Interne ─────────────────────────────────

    function _existingBooking(uint256 bookingId) private view returns (Booking storage booking) {
        booking = _bookings[bookingId];
        if (booking.status == BookingStatus.None) revert BookingNotFound(bookingId);
    }

    /// @dev Garantit le règlement unique : Cancelled, Completed et NoShow sont définitifs.
    function _requireConfirmed(uint256 bookingId, Booking storage booking) private view {
        if (booking.status != BookingStatus.Confirmed) revert InvalidStatus(bookingId, booking.status);
    }

    /// @dev Le centre est lu dans la réservation : on réutilise le modificateur onlyCenterStaff de CenterAccess
    ///      (l'administrateur et le gérant n'en font pas partie d'office).
    function _requireCenterStaff(uint32 centerId) private view onlyCenterStaff(centerId) {}
}
