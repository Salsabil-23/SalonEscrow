// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CenterAccess — rôles de SalonEscrow (fichier PARTAGÉ Membre 1 / Membre 2)
/// @notice Trois niveaux de droits, chacun limité à un centre :
///         - administrateur : propriétaire du contrat (Ownable), équipe de la plateforme Salonia ;
///         - gérant d'un centre : un seul par centre, nommé par l'administrateur ;
///         - staff d'un centre : nommé ou retiré par le gérant du centre ou l'administrateur.
///         Le gérant n'est PAS staff par défaut : il doit se nommer lui-même pour valider des prestations.
/// @dev    Version v0 proposée par le Membre 2 (aucun dépôt de départ n'existait). Toute modification se décide à deux.
///         Les identifiants de centre sont ceux de Salonia, réduits à un uint32 (aucune donnée personnelle).
abstract contract CenterAccess is Ownable {
    /// @dev centerId => gérant du centre (adresse nulle = aucun gérant).
    mapping(uint32 => address) private _managers;
    /// @dev centerId => compte => est staff de ce centre.
    mapping(uint32 => mapping(address => bool)) private _staff;

    event CenterManagerSet(uint32 indexed centerId, address indexed manager);
    event StaffSet(uint32 indexed centerId, address indexed account, bool allowed);

    /// @notice L'appelant n'est ni l'administrateur ni le gérant de ce centre.
    error NotCenterManager(uint32 centerId, address account);
    /// @notice L'appelant n'est pas staff de ce centre.
    error NotCenterStaff(uint32 centerId, address account);
    /// @notice Une adresse nulle a été fournie là où une vraie adresse est obligatoire.
    error ZeroAddress();

    /// @param admin Administrateur initial. Ownable (OpenZeppelin 5) refuse déjà l'adresse nulle (OwnableInvalidOwner).
    constructor(address admin) Ownable(admin) {}

    /// @dev Réservé à l'administrateur ou au gérant du centre `centerId`.
    modifier onlyCenterAdmin(uint32 centerId) {
        _checkCenterAdmin(centerId);
        _;
    }

    /// @dev Réservé au staff du centre `centerId` (l'administrateur et le gérant n'en font pas partie d'office).
    modifier onlyCenterStaff(uint32 centerId) {
        if (!_staff[centerId][msg.sender]) revert NotCenterStaff(centerId, msg.sender);
        _;
    }

    // ───────────────────────────── Écritures ─────────────────────────────

    /// @notice Nomme (ou remplace) le gérant d'un centre. Administrateur uniquement.
    function setCenterManager(uint32 centerId, address manager) external onlyOwner {
        if (manager == address(0)) revert ZeroAddress();
        _managers[centerId] = manager;
        emit CenterManagerSet(centerId, manager);
    }

    /// @notice Ajoute (`allowed = true`) ou retire (`false`) un membre du staff d'un centre.
    function setStaff(uint32 centerId, address account, bool allowed) external onlyCenterAdmin(centerId) {
        if (account == address(0)) revert ZeroAddress();
        _staff[centerId][account] = allowed;
        emit StaffSet(centerId, account, allowed);
    }

    // ───────────────────────────── Lectures ─────────────────────────────

    function managerOf(uint32 centerId) external view returns (address) {
        return _managers[centerId];
    }

    function isStaff(uint32 centerId, address account) external view returns (bool) {
        return _staff[centerId][account];
    }

    // ───────────────────────────── Interne ─────────────────────────────

    function _checkCenterAdmin(uint32 centerId) internal view {
        if (msg.sender != owner() && msg.sender != _managers[centerId]) {
            revert NotCenterManager(centerId, msg.sender);
        }
    }
}
